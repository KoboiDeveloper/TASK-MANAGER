import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isOriginAllowed } from '../common/corsOrigins';
import { MailboxCryptoService } from '../mailbox/mailbox-crypto.service';
import { MailboxService, type CalendarEvent as ZimbraCalendarEvent } from '../mailbox/mailbox.service';
import {
  GoogleOAuthClient,
  type GoogleCalendarEventRaw,
} from './google-oauth.client';

type OAuthStatePayload = {
  nik: string;
  typ: 'google_cal_oauth';
  nonce: string;
  /** FE origin that started OAuth (e.g. http://localhost:3000) */
  returnOrigin?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  appointmentId: string;
  title: string;
  location: string | null;
  start: number;
  end: number;
  allDay: boolean;
  folderId?: string;
  fragment?: string;
  source: 'google';
  accountEmail: string;
  /** Synced copy from Zimbra — hidden in workspace UI to avoid duplicates */
  syncedFromZimbra?: boolean;
};

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailboxCryptoService,
    private readonly oauth: GoogleOAuthClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mailbox: MailboxService,
  ) {}

  isConfigured() {
    return this.oauth.isConfigured();
  }

  async getStatus(nik: string) {
    const rows = await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findMany({
      where: { nik },
      orderBy: { createdAt: 'desc' },
      select: {
        googleEmail: true,
        displayName: true,
        createdAt: true,
        updatedAt: true,
        scope: true,
      },
    });
    const accounts = rows.map((r) => ({
      email: r.googleEmail,
      name: (r.displayName || '').trim() || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return {
      configured: this.oauth.isConfigured(),
      connected: accounts.length > 0,
      email: accounts[0]?.email ?? null,
      name: accounts[0]?.name ?? null,
      accounts,
      updatedAt: accounts[0]?.updatedAt ?? null,
    };
  }

  async getConnectUrl(nik: string, returnOrigin?: string): Promise<{ url: string }> {
    if (!this.oauth.isConfigured()) {
      throw new BadRequestException(
        'Google Calendar OAuth belum dikonfigurasi di server',
      );
    }
    let origin: string | undefined;
    if (returnOrigin?.trim()) {
      try {
        const u = new URL(returnOrigin.trim());
        const candidate = `${u.protocol}//${u.host}`;
        if (isOriginAllowed(candidate)) origin = candidate;
      } catch {
        /* ignore bad origin */
      }
    }
    const state = await this.jwt.signAsync(
      {
        nik,
        typ: 'google_cal_oauth',
        nonce: randomUUID(),
        ...(origin ? { returnOrigin: origin } : {}),
      } satisfies OAuthStatePayload,
      {
        secret: this.mustGet('SECRET_KEY'),
        issuer: this.mustGet('ISSUER_STAMP'),
        expiresIn: '15m',
      },
    );
    return { url: this.oauth.buildAuthUrl(state) };
  }

  /** Safe FE origin from OAuth state (for error redirects before token exchange). */
  async getReturnOriginFromState(state?: string): Promise<string | undefined> {
    if (!state?.trim()) return undefined;
    try {
      const payload = await this.jwt.verifyAsync<OAuthStatePayload>(state, {
        secret: this.mustGet('SECRET_KEY'),
        issuer: this.mustGet('ISSUER_STAMP'),
      });
      if (payload.returnOrigin && isOriginAllowed(payload.returnOrigin)) {
        return payload.returnOrigin.replace(/\/$/, '');
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  async handleCallback(code: string | undefined, state: string | undefined) {
    if (!code?.trim() || !state?.trim()) {
      throw new BadRequestException('code/state OAuth hilang');
    }
    let payload: OAuthStatePayload;
    try {
      payload = await this.jwt.verifyAsync<OAuthStatePayload>(state, {
        secret: this.mustGet('SECRET_KEY'),
        issuer: this.mustGet('ISSUER_STAMP'),
      });
    } catch {
      throw new BadRequestException('State OAuth tidak valid atau kedaluwarsa');
    }
    if (payload.typ !== 'google_cal_oauth' || !payload.nik) {
      throw new BadRequestException('State OAuth tidak valid');
    }

    const tokens = await this.oauth.exchangeCode(code.trim());
    if (!tokens.refresh_token) {
      // Re-consent may omit refresh if already granted — try keep existing later
      this.logger.warn(`No refresh_token for nik=${payload.nik}`);
    }

    const info = await this.oauth.getUserInfo(tokens.access_token);
    const email = (info.email || '').trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Google tidak mengembalikan email');
    }
    const displayName = (info.name || '').trim() || null;

    const accessEnc = this.crypto.encrypt(tokens.access_token);
    const expiresAt = new Date(
      Date.now() + Math.max((tokens.expires_in || 3600) - 60, 60) * 1000,
    );

    const existing = await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findUnique({
      where: { nik_googleEmail: { nik: payload.nik, googleEmail: email } },
      select: {
        refreshTokenCipher: true,
        refreshTokenIv: true,
        refreshTokenTag: true,
      },
    });

    let refreshEnc = tokens.refresh_token
      ? this.crypto.encrypt(tokens.refresh_token)
      : null;
    if (!refreshEnc && existing) {
      refreshEnc = {
        cipher: existing.refreshTokenCipher,
        iv: existing.refreshTokenIv,
        tag: existing.refreshTokenTag,
      };
    }
    if (!refreshEnc) {
      throw new BadRequestException(
        'Google tidak mengirim refresh_token. Cabut akses app di Google Account lalu coba lagi.',
      );
    }

    await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.upsert({
      where: { nik_googleEmail: { nik: payload.nik, googleEmail: email } },
      create: {
        id: randomUUID(),
        nik: payload.nik,
        googleEmail: email,
        displayName,
        accessTokenCipher: accessEnc.cipher,
        accessTokenIv: accessEnc.iv,
        accessTokenTag: accessEnc.tag,
        refreshTokenCipher: refreshEnc.cipher,
        refreshTokenIv: refreshEnc.iv,
        refreshTokenTag: refreshEnc.tag,
        accessTokenExpiresAt: expiresAt,
        scope: tokens.scope || null,
      },
      update: {
        ...(displayName ? { displayName } : {}),
        accessTokenCipher: accessEnc.cipher,
        accessTokenIv: accessEnc.iv,
        accessTokenTag: accessEnc.tag,
        refreshTokenCipher: refreshEnc.cipher,
        refreshTokenIv: refreshEnc.iv,
        refreshTokenTag: refreshEnc.tag,
        accessTokenExpiresAt: expiresAt,
        scope: tokens.scope || null,
      },
    });

    return {
      nik: payload.nik,
      email,
      name: displayName,
      returnOrigin: payload.returnOrigin,
    };
  }

  async disconnect(nik: string, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) throw new BadRequestException('Query email wajib');
    const deleted = await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.deleteMany({
      where: { nik, googleEmail: normalized },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Akun Google Calendar tidak ditemukan');
    }
    return this.getStatus(nik);
  }

  async getCalendars(nik: string) {
    const accounts = await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findMany({
      where: { nik },
      orderBy: { createdAt: 'desc' },
    });
    if (!accounts.length) {
      throw new BadRequestException('Google Calendar belum terhubung');
    }
    const out: Array<{
      id: string;
      name: string;
      accountEmail: string;
      primary: boolean;
      color: string | null;
    }> = [];
    for (const acc of accounts) {
      const token = await this.getValidAccessToken(acc);
      const list = await this.oauth.listCalendars(token);
      for (const c of list) {
        out.push({
          id: c.id,
          name: c.summary || c.id,
          accountEmail: acc.googleEmail,
          primary: !!c.primary,
          color: c.backgroundColor || null,
        });
      }
    }
    return out;
  }

  async getEvents(
    nik: string,
    opts: { start: number; end: number; calendarId?: string; email?: string },
  ): Promise<GoogleCalendarEvent[]> {
    if (!Number.isFinite(opts.start) || !Number.isFinite(opts.end) || opts.end <= opts.start) {
      throw new BadRequestException('Range start/end tidak valid');
    }
    const accounts = await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findMany({
      where: {
        nik,
        ...(opts.email ? { googleEmail: opts.email.trim().toLowerCase() } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!accounts.length) return [];

    const timeMin = new Date(opts.start).toISOString();
    const timeMax = new Date(opts.end).toISOString();
    const events: GoogleCalendarEvent[] = [];

    for (const acc of accounts) {
      try {
        const token = await this.getValidAccessToken(acc);
        // Default: primary only (fast). Pass calendarId to target another.
        const calendarIds = opts.calendarId
          ? [opts.calendarId]
          : ['primary'];

        for (const calId of calendarIds) {
          const raw = await this.oauth.listEvents(token, calId, timeMin, timeMax);
          for (const ev of raw) {
            const mapped = this.mapEvent(ev, calId, acc.googleEmail);
            // Hide Zimbra→Google mirrors in workspace (shown via Zimbra feed)
            if (mapped && !mapped.syncedFromZimbra) events.push(mapped);
          }
        }
      } catch (e) {
        this.logger.warn(
          `getEvents failed for ${acc.googleEmail}: ${String(e)}`,
        );
      }
    }

    events.sort((a, b) => a.start - b.start);
    return events;
  }


  private buildGoogleEventBody(input: {
    title: string;
    location?: string | null;
    description?: string | null;
    start: number;
    end: number;
    allDay?: boolean;
    timeZone?: string;
  }): Record<string, unknown> {
    const tz =
      input.timeZone?.trim() ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'UTC';
    const body: Record<string, unknown> = {
      summary: input.title.trim(),
    };
    if (input.location?.trim()) body.location = input.location.trim();
    if (input.description?.trim()) body.description = input.description.trim();

    if (input.allDay) {
      const toYmd = (ms: number) => {
        const d = new Date(ms);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };
      // Google all-day end is exclusive (midnight after last day)
      const startYmd = toYmd(input.start);
      let endYmd = toYmd(input.end);
      if (endYmd <= startYmd) {
        endYmd = toYmd(input.start + 86_400_000);
      }
      body.start = { date: startYmd };
      body.end = { date: endYmd };
    } else {
      body.start = { dateTime: new Date(input.start).toISOString(), timeZone: tz };
      body.end = { dateTime: new Date(input.end).toISOString(), timeZone: tz };
    }
    return body;
  }

  private async resolveAccount(nik: string, email?: string) {
    const row = email?.trim()
      ? await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findUnique({
          where: {
            nik_googleEmail: { nik, googleEmail: email.trim().toLowerCase() },
          },
        })
      : await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.findFirst({
          where: { nik },
          orderBy: { createdAt: 'desc' },
        });
    if (!row) {
      throw new BadRequestException('Google Calendar belum terhubung');
    }
    return row;
  }

  async createEvent(
    nik: string,
    input: {
      title: string;
      location?: string;
      description?: string;
      start: number;
      end: number;
      allDay?: boolean;
      calendarId?: string;
      email?: string;
      timeZone?: string;
    },
  ): Promise<GoogleCalendarEvent> {
    if (!input.title?.trim()) throw new BadRequestException('Judul wajib');
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) {
      throw new BadRequestException('Range waktu tidak valid');
    }
    const acc = await this.resolveAccount(nik, input.email);
    const token = await this.getValidAccessToken(acc);
    const calendarId = (input.calendarId || 'primary').trim() || 'primary';
    const raw = await this.oauth.createEvent(
      token,
      calendarId,
      this.buildGoogleEventBody(input),
    );
    const mapped = this.mapEvent(raw, calendarId, acc.googleEmail);
    if (!mapped) throw new BadRequestException('Gagal memetakan event Google');
    return mapped;
  }

  async updateEvent(
    nik: string,
    eventId: string,
    input: {
      title: string;
      location?: string;
      description?: string;
      start: number;
      end: number;
      allDay?: boolean;
      calendarId?: string;
      email?: string;
      timeZone?: string;
    },
  ): Promise<GoogleCalendarEvent> {
    if (!eventId?.trim()) throw new BadRequestException('eventId wajib');
    if (!input.title?.trim()) throw new BadRequestException('Judul wajib');
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) {
      throw new BadRequestException('Range waktu tidak valid');
    }
    const acc = await this.resolveAccount(nik, input.email);
    const token = await this.getValidAccessToken(acc);
    const calendarId = (input.calendarId || 'primary').trim() || 'primary';
    const raw = await this.oauth.updateEvent(
      token,
      calendarId,
      eventId.trim(),
      this.buildGoogleEventBody(input),
    );
    const mapped = this.mapEvent(raw, calendarId, acc.googleEmail);
    if (!mapped) throw new BadRequestException('Gagal memetakan event Google');
    return mapped;
  }

  async deleteEvent(
    nik: string,
    opts: { eventId: string; calendarId?: string; email?: string },
  ) {
    if (!opts.eventId?.trim()) throw new BadRequestException('eventId wajib');
    const acc = await this.resolveAccount(nik, opts.email);
    const token = await this.getValidAccessToken(acc);
    const calendarId = (opts.calendarId || 'primary').trim() || 'primary';
    await this.oauth.deleteEvent(token, calendarId, opts.eventId.trim());
    return { deleted: true, eventId: opts.eventId.trim() };
  }


  /**
   * Push Zimbra appointments into the user's primary Google Calendar.
   * Idempotent via DT_ZIMBRA_GOOGLE_EVENT_SYNC + Google extendedProperties.
   */
  async syncFromZimbra(
    nik: string,
    opts: { start: number; end: number; googleEmail?: string },
  ) {
    if (!Number.isFinite(opts.start) || !Number.isFinite(opts.end) || opts.end <= opts.start) {
      throw new BadRequestException('Range start/end tidak valid');
    }
    // Cap sync window (~120 days) to keep OAuth/API light
    if (opts.end - opts.start > 120 * 86_400_000) {
      throw new BadRequestException('Rentang sync maksimal 120 hari');
    }

    const gStatus = await this.getStatus(nik);
    if (!gStatus.connected) {
      throw new BadRequestException('Google Calendar belum terhubung');
    }
    const mStatus = await this.mailbox.getStatus(nik);
    if (!mStatus.connected || !(mStatus.accounts?.length > 0)) {
      throw new BadRequestException('Zimbra belum terhubung');
    }

    const gAcc = await this.resolveAccount(nik, opts.googleEmail);
    const token = await this.getValidAccessToken(gAcc);
    const calendarId = 'primary';
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    const seen = new Set<string>();

    for (const za of mStatus.accounts) {
      let zimbraEvents: ZimbraCalendarEvent[] = [];
      try {
        zimbraEvents = await this.mailbox.getEvents(nik, {
          start: opts.start,
          end: opts.end,
          email: za.email,
        });
      } catch (e) {
        this.logger.warn(`sync zimbra fetch ${za.email}: ${String(e)}`);
        continue;
      }

      for (const ev of zimbraEvents) {
        const zimbraEventKey = ev.id;
        if (!zimbraEventKey) continue;
        seen.add(`${za.email}::${zimbraEventKey}`);

        const body = this.buildZimbraMirrorBody(ev, za.email, timeZone);
        const existing =
          await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.findUnique({
            where: {
              nik_zimbraEmail_zimbraEventKey: {
                nik,
                zimbraEmail: za.email,
                zimbraEventKey,
              },
            },
          });

        if (existing) {
          const changed =
            existing.title !== ev.title ||
            Number(existing.startMs) !== ev.start ||
            Number(existing.endMs) !== ev.end ||
            existing.allDay !== !!ev.allDay;
          if (!changed) {
            skipped += 1;
            continue;
          }
          try {
            await this.oauth.updateEvent(
              token,
              existing.googleCalendarId || calendarId,
              existing.googleEventId,
              body,
            );
            await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.update({
              where: { id: existing.id },
              data: {
                title: ev.title.slice(0, 500),
                startMs: BigInt(ev.start),
                endMs: BigInt(ev.end),
                allDay: !!ev.allDay,
              },
            });
            updated += 1;
          } catch (e) {
            this.logger.warn(
              `sync update failed ${existing.googleEventId}, recreating: ${String(e)}`,
            );
            try {
              const raw = await this.oauth.createEvent(token, calendarId, body);
              if (!raw.id) continue;
              await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.update({
                where: { id: existing.id },
                data: {
                  googleEventId: raw.id,
                  googleCalendarId: calendarId,
                  title: ev.title.slice(0, 500),
                  startMs: BigInt(ev.start),
                  endMs: BigInt(ev.end),
                  allDay: !!ev.allDay,
                },
              });
              created += 1;
            } catch (e2) {
              this.logger.warn(`sync recreate failed: ${String(e2)}`);
            }
          }
        } else {
          try {
            const raw = await this.oauth.createEvent(token, calendarId, body);
            if (!raw.id) continue;
            await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.create({
              data: {
                id: randomUUID(),
                nik,
                zimbraEmail: za.email,
                zimbraEventKey,
                googleEmail: gAcc.googleEmail,
                googleCalendarId: calendarId,
                googleEventId: raw.id,
                title: ev.title.slice(0, 500),
                startMs: BigInt(ev.start),
                endMs: BigInt(ev.end),
                allDay: !!ev.allDay,
              },
            });
            created += 1;
          } catch (e) {
            this.logger.warn(`sync create failed ${zimbraEventKey}: ${String(e)}`);
          }
        }
      }
    }

    // Remove Google mirrors for Zimbra events that disappeared in this window
    const maps = await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.findMany({
      where: {
        nik,
        googleEmail: gAcc.googleEmail,
        startMs: { lt: BigInt(opts.end) },
        endMs: { gt: BigInt(opts.start) },
      },
    });
    for (const m of maps) {
      const key = `${m.zimbraEmail}::${m.zimbraEventKey}`;
      if (seen.has(key)) continue;
      try {
        await this.oauth.deleteEvent(
          token,
          m.googleCalendarId || calendarId,
          m.googleEventId,
        );
      } catch {
        /* already gone on Google */
      }
      await this.prisma.dT_ZIMBRA_GOOGLE_EVENT_SYNC.delete({ where: { id: m.id } });
      deleted += 1;
    }

    return {
      created,
      updated,
      deleted,
      skipped,
      start: opts.start,
      end: opts.end,
      googleEmail: gAcc.googleEmail,
      zimbraAccounts: mStatus.accounts.length,
    };
  }

  private buildZimbraMirrorBody(
    ev: ZimbraCalendarEvent,
    zimbraEmail: string,
    timeZone: string,
  ): Record<string, unknown> {
    const body = this.buildGoogleEventBody({
      title: ev.title,
      location: ev.location,
      description: ev.fragment
        ? `${ev.fragment}\n\n[Synced from Zimbra: ${zimbraEmail}]`
        : `[Synced from Zimbra: ${zimbraEmail}]`,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      timeZone,
    });
    body.extendedProperties = {
      private: {
        amsSource: 'zimbra',
        amsZimbraKey: ev.id,
        amsZimbraEmail: zimbraEmail,
        amsZimbraAppt: ev.appointmentId || '',
      },
    };
    return body;
  }

  frontendRedirect(ok: boolean, error?: string, returnOrigin?: string): string {
    let base =
      this.config.get<string>('FRONTEND_URL')?.replace(/\/$/, '') ||
      'http://localhost:3000';
    if (returnOrigin?.trim()) {
      try {
        const u = new URL(returnOrigin.trim());
        const candidate = `${u.protocol}//${u.host}`;
        if (isOriginAllowed(candidate)) base = candidate;
      } catch {
        /* keep FRONTEND_URL */
      }
    }
    const params = new URLSearchParams();
    if (ok) params.set('google', 'connected');
    else params.set('google', 'error');
    if (error) params.set('google_error', error.slice(0, 120));
    return `${base}/dashboard/user-settings?${params.toString()}#connected-apps`;
  }

  private async getValidAccessToken(row: {
    id: string;
    accessTokenCipher: string;
    accessTokenIv: string;
    accessTokenTag: string;
    refreshTokenCipher: string;
    refreshTokenIv: string;
    refreshTokenTag: string;
    accessTokenExpiresAt: Date | null;
  }): Promise<string> {
    const stillValid =
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt.getTime() > Date.now() + 30_000;
    if (stillValid) {
      return this.crypto.decrypt({
        cipher: row.accessTokenCipher,
        iv: row.accessTokenIv,
        tag: row.accessTokenTag,
      });
    }

    const refreshToken = this.crypto.decrypt({
      cipher: row.refreshTokenCipher,
      iv: row.refreshTokenIv,
      tag: row.refreshTokenTag,
    });
    const tokens = await this.oauth.refreshAccessToken(refreshToken);
    const accessEnc = this.crypto.encrypt(tokens.access_token);
    const expiresAt = new Date(
      Date.now() + Math.max((tokens.expires_in || 3600) - 60, 60) * 1000,
    );
    const refreshEnc = tokens.refresh_token
      ? this.crypto.encrypt(tokens.refresh_token)
      : null;

    await this.prisma.dT_GOOGLE_CALENDAR_CREDENTIAL.update({
      where: { id: row.id },
      data: {
        accessTokenCipher: accessEnc.cipher,
        accessTokenIv: accessEnc.iv,
        accessTokenTag: accessEnc.tag,
        accessTokenExpiresAt: expiresAt,
        ...(refreshEnc
          ? {
              refreshTokenCipher: refreshEnc.cipher,
              refreshTokenIv: refreshEnc.iv,
              refreshTokenTag: refreshEnc.tag,
            }
          : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });

    return tokens.access_token;
  }

  private mapEvent(
    ev: GoogleCalendarEventRaw,
    calendarId: string,
    accountEmail: string,
  ): GoogleCalendarEvent | null {
    const appointmentId = String(ev.id || '');
    if (!appointmentId) return null;

    const startRaw = ev.start?.dateTime || ev.start?.date;
    const endRaw = ev.end?.dateTime || ev.end?.date;
    if (!startRaw) return null;

    const allDay = !ev.start?.dateTime && !!ev.start?.date;
    const startMs = Date.parse(startRaw);
    let endMs = endRaw ? Date.parse(endRaw) : NaN;
    if (!Number.isFinite(startMs)) return null;
    if (!Number.isFinite(endMs) || endMs <= startMs) {
      endMs = startMs + (allDay ? 86_400_000 : 3_600_000);
    }

    const priv = ev.extendedProperties?.private || {};
    const syncedFromZimbra = priv.amsSource === 'zimbra';

    return {
      id: `gcal-${accountEmail}-${calendarId}-${appointmentId}-${startMs}`,
      appointmentId,
      title: String(ev.summary || '(tanpa judul)'),
      location: ev.location ? String(ev.location) : null,
      start: startMs,
      end: endMs,
      allDay,
      folderId: calendarId,
      fragment: ev.description ? String(ev.description).slice(0, 280) : undefined,
      source: 'google',
      accountEmail,
      syncedFromZimbra,
    };
  }

  private mustGet(key: string): string {
    const v = this.config.get<string>(key);
    if (!v) throw new Error(`Missing ENV variable: ${key}`);
    return v;
  }
}
