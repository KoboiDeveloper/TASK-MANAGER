// src/cronjob/cronjob.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { del } from '@vercel/blob';
import { DT_IMAGES } from '@prisma/client';

type ImageRow = Pick<DT_IMAGES, 'id' | 'url' | 'createdAt'>;

export interface CleanupStats {
  checked: number;
  deleted: number;
  blobErrors: number;
  durationMs: number;
}

function startOfMonthWIBtoUTC(monthsAgo = 0): Date {
  // Pastikan monthsAgo valid
  const n = Number.isFinite(monthsAgo) && monthsAgo >= 0 ? Math.floor(monthsAgo) : 0;

  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7
  const now = new Date();
  const nowWibMs = now.getTime() + WIB_OFFSET_MS;
  const nowWib = new Date(nowWibMs);

  // Awal bulan WIB (jam 00:00 WIB di bulan ini)
  const startThisMonthWib = new Date(
    Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), 1, 0, 0, 0, 0),
  );

  // Mundur n bulan pada “waktu WIB”
  const targetMonthWib = new Date(
    Date.UTC(
      startThisMonthWib.getUTCFullYear(),
      startThisMonthWib.getUTCMonth() - n,
      1,
      0,
      0,
      0,
      0,
    ),
  );

  // Konversi balik ke UTC riil
  return new Date(targetMonthWib.getTime() - WIB_OFFSET_MS);
}

@Injectable()
export class CronjobService {
  private readonly logger = new Logger(CronjobService.name);

  // ✅ Default yang aman + sanitasi
  private readonly keepLastNMonths: number = (() => {
    const v = Number(process.env.KEEP_LAST_N_MONTHS ?? 1);
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
  })();

  private readonly batchSize: number = (() => {
    const v = Number(process.env.CLEANUP_BATCH_SIZE ?? 500);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500;
  })();

  private readonly dryRun: boolean =
    String(process.env.CLEANUP_DRY_RUN ?? 'false').toLowerCase() === 'true';

  private readonly blobToken: string = String(process.env.BLOB_READ_WRITE_TOKEN ?? '');

  private isAllowedBlobHost(hostname: string): boolean {
    if (!hostname) return false;
    if (hostname === 'blob.vercel-storage.com') return true;
    return (
      hostname.endsWith('.blob.vercel-storage.com') ||
      hostname.endsWith('.public.blob.vercel-storage.com')
    );
  }

  constructor(private readonly prisma: PrismaService) {}

  /** ⏱ TEST: tanggal 29 jam 16:49 WIB (ganti ke '0 0 0 29 * *' untuk produksi) */
  @Cron('0 00 00 29 * *', { timeZone: 'Asia/Jakarta' })
  async cleanupOldImages(): Promise<CleanupStats> {
    const started = Date.now();

    if (!this.blobToken && !this.dryRun) {
      this.logger.error('BLOB_READ_WRITE_TOKEN missing. Abort cleanup.');
      return { checked: 0, deleted: 0, blobErrors: 0, durationMs: 0 };
    }

    // Cutoff = awal bulan WIB dikurangi (keepLastNMonths - 1) bulan
    const cutoff = startOfMonthWIBtoUTC(this.keepLastNMonths - 1);

    this.logger.log(
      `Start monthly cleanup: keepLastNMonths=${this.keepLastNMonths} cutoff(UTC)=${cutoff.toISOString()} dryRun=${this.dryRun}`,
    );

    let checked = 0;
    let deleted = 0;
    let blobErrors = 0;
    let cursorId: string | undefined;

    const concurrencyEnv = Number(process.env.CLEANUP_CONCURRENCY ?? 10);
    const concurrency =
      Number.isFinite(concurrencyEnv) && concurrencyEnv > 0 ? Math.floor(concurrencyEnv) : 10;

    while (true) {
      const rows: ImageRow[] = await this.prisma.dT_IMAGES.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: this.batchSize,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
        select: { id: true, url: true, createdAt: true },
      });

      if (rows.length === 0) break;
      cursorId = rows[rows.length - 1].id;

      checked += rows.length;

      const okIds: string[] = [];
      for (let i = 0; i < rows.length; i += concurrency) {
        const slice = rows.slice(i, i + concurrency);
        await Promise.allSettled(
          slice.map(async (r) => {
            try {
              const u = new URL(r.url);
              if (!this.isAllowedBlobHost(u.hostname)) {
                this.logger.warn(`Skip non-blob host: ${u.hostname} for id=${r.id}`);
                return;
              }
              if (this.dryRun) {
                this.logger.debug(`[DRY] would delete blob: ${r.url}`);
                okIds.push(r.id);
                return;
              }
              await del(r.url, { token: this.blobToken });
              okIds.push(r.id);
            } catch (e) {
              blobErrors++;
              this.logger.warn(`Blob delete failed id=${r.id} :: ${(e as Error)?.message || e}`);
            }
          }),
        );
      }

      if (okIds.length) {
        if (this.dryRun) {
          this.logger.debug(`[DRY] would delete DB rows: ${okIds.length}`);
        } else {
          const res = await this.prisma.dT_IMAGES.deleteMany({ where: { id: { in: okIds } } });
          deleted += res.count;
        }
      }

      if (rows.length < this.batchSize) break;
    }

    const durationMs = Date.now() - started;
    this.logger.log(
      `Done monthly cleanup: checked=${checked} deleted=${deleted} blobErrors=${blobErrors} in ${durationMs}ms`,
    );
    return { checked, deleted, blobErrors, durationMs };
  }
}
