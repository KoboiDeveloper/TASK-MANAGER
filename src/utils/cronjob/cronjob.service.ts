// src/cronjob/cronjob.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { DT_IMAGES } from '@prisma/client';
import { DropboxStorageService } from '../../storage/dropbox.storage.service';
import { MailService } from '../mail/mail.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: DropboxStorageService,
    private readonly mailService: MailService,
  ) {}

  /** ⏱ TEST: tanggal 29 jam 16:49 WIB (ganti ke '0 0 0 29 * *' untuk produksi) */
  @Cron('0 00 00 29 * *', { timeZone: 'Asia/Jakarta' })
  async cleanupOldImages(): Promise<CleanupStats> {
    const started = Date.now();

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
              if (this.dryRun) {
                this.logger.debug(`[DRY] would delete: ${r.url}`);
                okIds.push(r.id);
                return;
              }
              await this.storageService.deleteFile(r.url);
              okIds.push(r.id);
            } catch (e) {
              blobErrors++;
              this.logger.warn(`Delete failed id=${r.id} :: ${(e as Error)?.message || e}`);
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

  /**
   * ⏰ Daily Task Reminders & Standup Digest
   * Berjalan setiap hari pada pukul 09:00 WIB
   * Mengirim ringkasan tugas: overdue & jatuh tempo hari ini/besok ke masing-masing assignee
   */
  @Cron('0 0 9 * * *', { timeZone: 'Asia/Jakarta' })
  async sendDailyTaskRemindersAndDigest(): Promise<{
    usersProcessed: number;
    emailsSent: number;
    durationMs: number;
  }> {
    const started = Date.now();
    this.logger.log('Starting daily task reminder & digest cronjob...');

    const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
    const nowUtc = new Date();
    const nowWib = new Date(nowUtc.getTime() + WIB_OFFSET_MS);

    const y = nowWib.getUTCFullYear();
    const m = nowWib.getUTCMonth();
    const d = nowWib.getUTCDate();

    const todayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - WIB_OFFSET_MS);
    const todayEndUtc = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - WIB_OFFSET_MS);

    // Ambil semua task belum selesai dari project aktif yang memiliki deadline
    const tasks = await this.prisma.dT_TASK.findMany({
      where: {
        status: false,
        project: { isArchive: false },
        dueDate: { not: null },
      },
      select: {
        id: true,
        shortId: true,
        name: true,
        dueDate: true,
        id_dt_project: true,
        project: {
          select: {
            id: true,
            shortId: true,
            name: true,
          },
        },
        assignees: {
          include: {
            user: {
              select: {
                nik: true,
                nama: true,
                email: true,
                notificationPrefs: true,
              },
            },
          },
        },
      },
    });

    // Peta user ke task overdue dan dueToday
    type UserTaskItem = {
      id: string;
      name: string;
      projectId: string;
      projectName: string;
      dueDate?: Date | null;
      daysOverdue?: number;
    };

    const userDigestMap = new Map<
      string,
      {
        user: { nik: string; nama: string; email: string };
        overdue: Array<UserTaskItem & { daysOverdue: number }>;
        dueToday: Array<UserTaskItem>;
      }
    >();

    for (const t of tasks) {
      if (!t.dueDate) continue;

      const isOverdue = t.dueDate < todayStartUtc;
      const isDueToday = t.dueDate >= todayStartUtc && t.dueDate <= todayEndUtc;

      if (!isOverdue && !isDueToday) continue;

      const daysOverdue = isOverdue
        ? Math.max(
            1,
            Math.ceil((todayStartUtc.getTime() - t.dueDate.getTime()) / (1000 * 60 * 60 * 24)),
          )
        : 0;

      const projectId = t.project?.shortId || t.project?.id || t.id_dt_project;
      const projectName = t.project?.name || 'Project';
      const taskId = t.shortId || t.id;

      for (const a of t.assignees) {
        if (!a.user || !a.user.email) continue;
        const nik = a.user.nik;

        // Cek preferensi email ringkasan harian
        if (a.user.notificationPrefs) {
          try {
            const prefs = JSON.parse(a.user.notificationPrefs);
            if (prefs.emailDailyDigest === false) continue;
          } catch {
            // fallback default ON
          }
        }

        if (!userDigestMap.has(nik)) {
          userDigestMap.set(nik, {
            user: { nik, nama: a.user.nama, email: a.user.email },
            overdue: [],
            dueToday: [],
          });
        }

        const entry = userDigestMap.get(nik)!;
        if (isOverdue) {
          entry.overdue.push({
            id: taskId,
            name: t.name,
            projectId,
            projectName,
            dueDate: t.dueDate,
            daysOverdue,
          });
        } else if (isDueToday) {
          entry.dueToday.push({
            id: taskId,
            name: t.name,
            projectId,
            projectName,
            dueDate: t.dueDate,
          });
        }
      }
    }

    let emailsSent = 0;
    const usersProcessed = userDigestMap.size;

    for (const [nik, data] of userDigestMap.entries()) {
      try {
        // Hitung total active task yang diemban user
        const totalActiveTasks = await this.prisma.dT_ASSIGNEE_TASK.count({
          where: {
            nik,
            task: {
              status: false,
              project: { isArchive: false },
            },
          },
        });

        await this.mailService.sendDailyDigestEmail({
          to: data.user.email,
          userName: data.user.nama,
          dueToday: data.dueToday,
          overdue: data.overdue,
          totalActiveTasks,
        });

        emailsSent++;
      } catch (err) {
        this.logger.error(
          `Failed sending daily digest to ${data.user.email} (${nik}):`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    const durationMs = Date.now() - started;
    this.logger.log(
      `Daily task reminder cronjob completed: ${emailsSent} emails sent out of ${usersProcessed} users in ${durationMs}ms`,
    );

    return { usersProcessed, emailsSent, durationMs };
  }
}
