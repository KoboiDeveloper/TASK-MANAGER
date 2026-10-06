import { createHash } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { isPushAllowed, PushPayload } from './push.types';

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT') || 'mailto:admin@taskmanager.local';
    if (!publicKey || !privateKey) {
      this.logger.warn('VAPID keys missing — Web Push disabled');
      return;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.ready = true;
    this.logger.log('Web Push (VAPID) ready');
  }

  getPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY') || null;
  }

  static hashEndpoint(endpoint: string): string {
    return createHash('sha256').update(endpoint).digest('hex');
  }

  async subscribe(
    nik: string,
    input: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
  ) {
    const endpointHash = PushService.hashEndpoint(input.endpoint);
    await this.prisma.dT_PUSH_SUBSCRIPTION.upsert({
      where: { endpointHash },
      create: {
        nik,
        endpoint: input.endpoint,
        endpointHash,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
      update: {
        nik,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
    });
    return { ok: true };
  }

  async unsubscribe(nik: string, endpoint: string) {
    const endpointHash = PushService.hashEndpoint(endpoint);
    await this.prisma.dT_PUSH_SUBSCRIPTION.deleteMany({
      where: { nik, endpointHash },
    });
    return { ok: true };
  }

  /** Fire-and-forget safe: never throws to caller */
  notifyUser(nik: string, payload: PushPayload, excludeNik?: string): void {
    if (excludeNik && nik === excludeNik) return;
    void this.sendToUser(nik, payload).catch((e) =>
      this.logger.warn(`push ${payload.type} → ${nik}: ${(e as Error).message}`),
    );
  }

  notifyUsers(niks: string[], payload: PushPayload, excludeNik?: string): void {
    const unique = Array.from(new Set(niks.filter((n) => n && n !== excludeNik)));
    for (const nik of unique) this.notifyUser(nik, payload);
  }

  async sendToUser(nik: string, payload: PushPayload): Promise<void> {
    if (!this.ready) return;

    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { notificationPrefs: true, statusActive: true },
    });
    if (!user?.statusActive) return;
    if (!isPushAllowed(user.notificationPrefs, payload.type)) return;

    const subs = await this.prisma.dT_PUSH_SUBSCRIPTION.findMany({ where: { nik } });
    if (!subs.length) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/dashboard',
      tag: payload.tag || payload.type,
      data: { type: payload.type, ...(payload.data || {}) },
    });

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            body,
            { TTL: 60 * 60 * 12, urgency: 'normal' },
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await this.prisma.dT_PUSH_SUBSCRIPTION.delete({ where: { id: sub.id } }).catch(() => undefined);
          } else {
            this.logger.debug(`push fail ${nik}: ${(err as Error).message}`);
          }
        }
      }),
    );
  }
}
