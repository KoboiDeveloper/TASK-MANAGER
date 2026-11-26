import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../notifications/push.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { MailService } from '../utils/mail/mail.service';
import { DailyTaskService } from './daily-task.service';
import { ANDI_ESCALATION, ANDI_KPIS, ANDI_NIK, KPI_CATEGORIES, KPI_METHODS } from './daily-task.seed';

type TargetInput = {
  id?: string;
  text: string;
  dueDate?: string | null;
  methodId?: string | null;
  targetValue?: number | null;
};

type KpiInput = {
  id?: string;
  title: string;
  weight: number;
  seasonal?: boolean;
  breakdown?: string[];
  escalation?: string[];
  targets: TargetInput[];
};

const WORK_STATUS = {
  todo: 'Belum dikerjakan',
  doing: 'Sedang dikerjakan',
  done: 'Selesai',
} as const;

type WorkStatus = keyof typeof WORK_STATUS;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7,
  agu: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};

@Injectable()
export class DailyTaskKpiService implements OnModuleInit {
  private readonly logger = new Logger(DailyTaskKpiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dailyTask: DailyTaskService,
    private readonly storage: DropboxStorageService,
    private readonly pushService: PushService,
    private readonly mailService: MailService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureSeed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Daily task seed skipped: ${message}`);
    }
  }

  async masters() {
    await this.ensureSeed();
    const [methods, categories] = await Promise.all([
      this.prisma.dT_KPI_METHOD.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.dT_KPI_CATEGORY.findMany({ orderBy: { min: 'desc' } }),
    ]);
    return {
      methods: methods.map((method) => ({
        id: method.id,
        name: method.name,
        hint: method.hint,
        formula: method.formula,
      })),
      categories: categories.map((category) => ({
        id: category.id,
        min: category.min,
        label: category.label,
      })),
    };
  }

  async access(actorNik: string) {
    const profile = await this.profile(actorNik);
    return {
      nik: profile.nik,
      roleId: profile.roleId,
      kpiAdmin: profile.kpiAdmin,
      departmentId: profile.departmentId,
      departmentIds: profile.departmentIds,
    };
  }

  async saveMethod(actorNik: string, input: { id?: string; name: string; hint?: string; formula: string }) {
    const name = input.name?.trim();
    const formula = input.formula?.trim();
    if (!name || !formula) throw new BadRequestException('Nama dan rumus wajib diisi');
    const id = (input.id?.trim() || crypto.randomUUID()).slice(0, 40);
    await this.assertMaster(actorNik);
    const hint = input.hint?.trim() ?? '';
    const before = await this.prisma.dT_KPI_METHOD.findUnique({ where: { id } });
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dT_KPI_METHOD.upsert({
        where: { id },
        create: { id, name, hint, formula, sortOrder: before?.sortOrder ?? 100 },
        update: { name, hint },
      });
      await this.writeLog(tx, {
        actorNik,
        entityType: 'method',
        entityId: id,
        action: before ? 'update' : 'create',
        summary: `${before ? 'Ubah' : 'Tambah'} metode ${name}`,
        before,
        after: row,
      });
      return row;
    });
    return { id: saved.id, name: saved.name, hint: saved.hint, formula: saved.formula };
  }

  async saveCategory(actorNik: string, input: { id?: string; min: number; label: string }) {
    const label = input.label?.trim();
    const min = Number(input.min);
    await this.assertMaster(actorNik);
    if (!label || !Number.isFinite(min)) throw new BadRequestException('Label dan nilai minimum wajib diisi');
    const id = (input.id?.trim() || `cat-${min}`).slice(0, 40);
    const before = await this.prisma.dT_KPI_CATEGORY.findUnique({ where: { id } });
    const saved = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dT_KPI_CATEGORY.upsert({
        where: { id },
        create: { id, min, label },
        update: { min, label },
      });
      await this.writeLog(tx, {
        actorNik,
        entityType: 'category',
        entityId: id,
        action: before ? 'update' : 'create',
        summary: `${before ? 'Ubah' : 'Tambah'} kategori ${label}`,
        before,
        after: row,
      });
      return row;
    });
    return { id: saved.id, min: saved.min, label: saved.label };
  }

  async sheet(actorNik: string, departmentId: string, nik: string, month: string) {
    this.assertMonth(month);
    const departmentKey = departmentId.trim();
    const employeeNik = this.assertNik(nik);
    const profile = await this.profile(actorNik);
    const seesAll = profile.roleId === 'SUPER' || profile.roleId === 'ADMIN' || profile.kpiAdmin;
    if (!seesAll && !profile.departmentIds.includes(departmentKey)) {
      throw new ForbiddenException('KPI departemen ini tidak bisa dilihat');
    }
    const ownSheet = profile.roleId === 'STAFF' && departmentKey === profile.departmentId;
    if (ownSheet && employeeNik !== profile.nik) {
      throw new ForbiddenException('Karyawan hanya bisa melihat KPI sendiri');
    }
    await this.ensureSeed();
    const owned = await this.ownsTemplate(employeeNik);
    const kpis = await this.loadKpis(owned ? null : departmentKey, owned ? employeeNik : null, month);
    const targetIds = kpis.flatMap((kpi) => kpi.targets.map((target) => target.id));
    const entries = targetIds.length
      ? await this.prisma.dT_KPI_ENTRY.findMany({
          where: { nik: employeeNik, month, targetId: { in: targetIds } },
          include: { files: { orderBy: { uploadedAt: 'asc' } } },
        })
      : [];
    const byTarget = Object.fromEntries(
      entries.map((entry) => [
        entry.targetId,
        {
          realisasi: entry.realisasi,
          submittedAt: entry.submittedAt?.toISOString() ?? null,
          note: entry.note,
          workStatus: this.workStatusOf(entry.workStatus),
          files: entry.files.map((file) => ({
            id: file.id,
            name: file.filename,
            type: file.mimeType,
            size: file.bytes,
            url: file.url,
          })),
        },
      ]),
    );
    return {
      kpis,
      entries: byTarget,
      canSubmitRealisasi: await this.isHeadOf(actorNik, departmentKey),
      canUploadFiles: actorNik.trim() === employeeNik,
      canEditKpi: this.mayEditKpi(profile, departmentKey),
      view: ownSheet ? 'staff' : 'full',
    };
  }

  async progress(departmentId: string, month: string) {
    this.assertMonth(month);
    await this.ensureSeed();
    const employees = await this.dailyTask.employees(departmentId);
    const niks = employees.map((employee) => employee.nik.trim()).filter((nik) => nik.length === 8);
    const [departmentKpis, personal] = await Promise.all([
      this.loadKpis(departmentId, null, month),
      this.personalKpis(niks, month),
    ]);
    const targetIds = [
      ...departmentKpis,
      ...[...personal.values()].flat(),
    ].flatMap((kpi) => kpi.targets.map((target) => target.id));
    const entries = targetIds.length && niks.length
      ? await this.prisma.dT_KPI_ENTRY.findMany({
          where: {
            month,
            nik: { in: niks },
            targetId: { in: targetIds },
            realisasi: { not: null },
          },
          select: { nik: true, targetId: true, realisasi: true },
        })
      : [];
    const done = new Set(
      entries.filter((entry) => entry.realisasi?.trim()).map((entry) => `${entry.nik.trim()}|${entry.targetId}`),
    );
    return employees.map((employee) => {
      const nik = employee.nik.trim();
      const kpis = personal.get(nik) ?? departmentKpis;
      return { nik, ...this.progressOf(kpis, nik, done) };
    });
  }

  async createKpi(actorNik: string, departmentId: string, employeeNik: string, month: string, input: KpiInput) {
    await this.assertCanEditKpi(actorNik, departmentId);
    const nik = this.assertNik(employeeNik);
    const period = this.assertMonth(month);
    const owned = await this.ownsTemplate(nik);
    const kpi = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dT_KPI.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          departmentId: owned ? null : departmentId,
          ownerNik: owned ? nik : null,
          title: this.cleanTitle(input.title),
          weight: input.weight,
          seasonal: Boolean(input.seasonal),
          breakdown: JSON.stringify(this.cleanLines(input.breakdown)),
          escalation: JSON.stringify(this.cleanLines(input.escalation)),
          sortOrder: 1000,
          createdBy: actorNik,
          updatedBy: actorNik,
          targets: { create: await this.targetCreates(input.targets) },
        },
        include: { targets: true },
      });
      await this.writeLog(tx, {
        actorNik,
        subjectNik: nik,
        departmentId,
        month: period,
        entityType: 'kpi',
        entityId: row.id,
        action: 'create',
        summary: `Tambah KPI ${row.title}`,
        after: row,
      });
      return row;
    });
    return this.presentKpi(kpi, '');
  }

  async updateKpi(actorNik: string, kpiId: string, departmentId: string, employeeNik: string, month: string, input: KpiInput) {
    const existing = await this.prisma.dT_KPI.findUnique({
      where: { id: kpiId },
      include: { targets: true },
    });
    if (!existing) throw new NotFoundException('KPI tidak ditemukan');
    await this.assertCanEditKpi(actorNik, departmentId);
    const nik = this.assertNik(employeeNik);
    const period = this.assertMonth(month);
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.dT_KPI.update({
        where: { id: kpiId },
        data: {
          title: this.cleanTitle(input.title),
          weight: input.weight,
          seasonal: Boolean(input.seasonal),
          breakdown: JSON.stringify(this.cleanLines(input.breakdown)),
          escalation: JSON.stringify(this.cleanLines(input.escalation)),
          updatedBy: actorNik,
        },
      });
      const incoming = input.targets.filter((target) => target.text?.trim());
      const incomingIds = new Set(incoming.map((target) => target.id).filter(Boolean));
      for (const target of existing.targets) {
        if (incomingIds.has(target.id)) continue;
        const used = await tx.dT_KPI_ENTRY.count({ where: { targetId: target.id } });
        if (used === 0) await tx.dT_KPI_TARGET.delete({ where: { id: target.id } });
      }
      for (const [index, target] of incoming.entries()) {
        const data = await this.targetData(target, index);
        const current = target.id ? existing.targets.find((item) => item.id === target.id) : undefined;
        if (current) {
          await tx.dT_KPI_TARGET.update({
            where: { id: current.id },
            data: data.dueDate ? { ...data, dueDay: null, dueMonth: null } : data,
          });
        } else {
          await tx.dT_KPI_TARGET.create({
            data: { ...(target.id ? { id: target.id } : {}), kpiId, ...data },
          });
        }
      }
      const row = await tx.dT_KPI.findUnique({ where: { id: kpiId }, include: { targets: true } });
      await this.writeLog(tx, {
        actorNik,
        subjectNik: nik,
        departmentId,
        month: period,
        entityType: 'kpi',
        entityId: kpiId,
        action: 'update',
        summary: `Ubah KPI ${input.title.trim()}`,
        before: existing,
        after: row,
      });
      return row;
    });
    if (!saved) throw new NotFoundException('KPI tidak ditemukan');
    return this.presentKpi(saved, '');
  }

  async submitRealisasi(
    actorNik: string,
    departmentId: string,
    targetId: string,
    employeeNik: string,
    month: string,
    realisasi: string,
  ) {
    this.assertMonth(month);
    const nik = this.assertNik(employeeNik);
    const value = realisasi?.trim();
    if (!value) throw new BadRequestException('Realisasi wajib diisi');
    if (!(await this.isHeadOf(actorNik, departmentId))) {
      throw new ForbiddenException('Hanya HEAD departemen ini yang bisa mengisi realisasi');
    }
    await this.assertTarget(targetId);
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.dT_KPI_ENTRY.findUnique({
        where: { targetId_nik_month: { targetId, nik, month } },
      });
      const row = await tx.dT_KPI_ENTRY.upsert({
        where: { targetId_nik_month: { targetId, nik, month } },
        create: { targetId, nik, month, realisasi: value, submittedAt: new Date() },
        update: { realisasi: value, submittedAt: new Date() },
      });
      await this.writeLog(tx, {
        actorNik,
        subjectNik: nik,
        departmentId,
        month,
        entityType: 'entry',
        entityId: row.id,
        action: 'submit',
        summary: `Isi realisasi ${value}`,
        before,
        after: row,
      });
      return row;
    });
    const targetText = await this.targetText(targetId);
    const headName = await this.displayName(actorNik);
    void this.notifyUsers(
      [nik],
      actorNik,
      'Realisasi KPI',
      `${headName} mengisi realisasi "${targetText}": ${value}`,
      this.sheetPath(departmentId, nik),
      'kpi.realisasi',
    );
    return {
      realisasi: saved.realisasi,
      submittedAt: saved.submittedAt?.toISOString() ?? null,
    };
  }

  async setWorkStatus(
    actorNik: string,
    departmentId: string,
    targetId: string,
    employeeNik: string,
    month: string,
    status: string,
  ) {
    this.assertMonth(month);
    const nik = this.assertNik(employeeNik);
    if (actorNik.trim() !== nik) {
      throw new ForbiddenException('Hanya karyawan yang bersangkutan yang bisa mengubah status');
    }
    if (status !== 'todo' && status !== 'doing') {
      throw new BadRequestException('Status hanya bisa Belum dikerjakan atau Sedang dikerjakan');
    }
    const nextStatus: WorkStatus = status === 'doing' ? 'doing' : 'todo';
    await this.assertTarget(targetId);
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.dT_KPI_ENTRY.findUnique({
        where: { targetId_nik_month: { targetId, nik, month } },
      });
      if (before?.workStatus === 'done') {
        throw new BadRequestException('Target yang sudah selesai tidak bisa diubah statusnya');
      }
      if ((before?.workStatus ?? 'todo') === nextStatus) return { row: before, changed: false };
      const row = await tx.dT_KPI_ENTRY.upsert({
        where: { targetId_nik_month: { targetId, nik, month } },
        create: { targetId, nik, month, workStatus: nextStatus },
        update: { workStatus: nextStatus },
      });
      await this.writeLog(tx, {
        actorNik,
        subjectNik: nik,
        departmentId,
        month,
        entityType: 'entry',
        entityId: row.id,
        action: 'status',
        summary: `Status menjadi ${WORK_STATUS[nextStatus]}`,
        before,
        after: row,
      });
      return { row, changed: true };
    });
    if (saved.changed) {
      const targetText = await this.targetText(targetId);
      const name = await this.displayName(nik);
      const heads = await this.headsOf(departmentId);
      void this.notifyUsers(
        heads.map((head) => head.nik),
        nik,
        'Status KPI',
        `${name} mengubah status "${targetText}" menjadi ${WORK_STATUS[nextStatus]}`,
        this.sheetPath(departmentId, nik),
        'kpi.status',
        heads,
      );
    }
    return { workStatus: this.workStatusOf(saved.row?.workStatus) };
  }

  async submitFiles(
    actorNik: string,
    departmentId: string,
    targetId: string,
    employeeNik: string,
    month: string,
    note: string,
    files: Express.Multer.File[],
  ) {
    this.assertMonth(month);
    const nik = this.assertNik(employeeNik);
    if (actorNik.trim() !== nik) {
      throw new ForbiddenException('Hanya karyawan yang bersangkutan yang bisa mengunggah file');
    }
    const trimmed = note?.trim() ?? '';
    if (!trimmed && files.length === 0) throw new BadRequestException('Isi keterangan atau lampirkan file');
    const target = await this.assertTarget(targetId);
    if (this.isPastDue(this.dueLabel(month, target.dueDay, target.dueMonth, target.dueDate))) {
      throw new BadRequestException('Due date target sudah lewat');
    }
    const uploaded: { url: string; filename: string; mimeType: string; bytes: number }[] = [];
    for (const file of files) {
      if (!file?.buffer?.length) continue;
      if (file.size > 15 * 1024 * 1024) throw new BadRequestException('Maksimum ukuran file 15MB');
      const filename = (file.originalname || 'file').slice(0, 255);
      const safe = filename.replace(/[^\w.-]+/g, '_');
      const stored = await this.storage.uploadFile(
        `daily-task/${nik}/${month}/${Date.now()}_${safe}`,
        file.buffer,
        file.mimetype || 'application/octet-stream',
      );
      uploaded.push({
        url: stored.url,
        filename,
        mimeType: file.mimetype || 'application/octet-stream',
        bytes: file.size,
      });
    }
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.dT_KPI_ENTRY.findUnique({
        where: { targetId_nik_month: { targetId, nik, month } },
        include: { files: true },
      });
      const entry = await tx.dT_KPI_ENTRY.upsert({
        where: { targetId_nik_month: { targetId, nik, month } },
        create: { targetId, nik, month, note: trimmed || null, workStatus: 'done' },
        update: { ...(trimmed ? { note: trimmed } : {}), workStatus: 'done' },
      });
      if (uploaded.length) {
        await tx.dT_KPI_ENTRY_FILE.createMany({
          data: uploaded.map((file) => ({ ...file, entryId: entry.id, uploadedBy: actorNik })),
        });
      }
      const after = await tx.dT_KPI_ENTRY.findUnique({
        where: { id: entry.id },
        include: { files: true },
      });
      await this.writeLog(tx, {
        actorNik,
        subjectNik: nik,
        departmentId,
        month,
        entityType: 'file',
        entityId: entry.id,
        action: 'upload',
        summary: trimmed ? `Submit task: ${trimmed}` : `Unggah ${uploaded.length} file`,
        before,
        after,
      });
      return after;
    });
    const targetText = await this.targetText(targetId);
    const name = await this.displayName(nik);
    const heads = await this.headsOf(departmentId);
    void this.notifyUsers(
      heads.map((head) => head.nik),
      nik,
      'Status KPI',
      `${name} menyelesaikan target "${targetText}"`,
      this.sheetPath(departmentId, nik),
      'kpi.status',
      heads,
    );
    return {
      note: saved?.note ?? null,
      workStatus: 'done' as const,
      files: (saved?.files ?? []).map((file) => ({
        id: file.id,
        name: file.filename,
        type: file.mimeType,
        size: file.bytes,
        url: file.url,
      })),
    };
  }

  async logs(departmentId: string, nik: string | undefined, month: string) {
    this.assertMonth(month);
    const rows = await this.prisma.dT_KPI_LOG.findMany({
      where: {
        departmentId,
        month,
        ...(nik?.trim() ? { subjectNik: this.assertNik(nik) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      actorNik: row.actorNik.trim(),
      subjectNik: row.subjectNik?.trim() ?? null,
      action: row.action,
      entityType: row.entityType,
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async ensureSeed() {
    for (const [index, method] of KPI_METHODS.entries()) {
      await this.prisma.dT_KPI_METHOD.upsert({
        where: { id: method.id },
        create: { ...method, sortOrder: index },
        update: {},
      });
    }
    for (const category of KPI_CATEGORIES) {
      await this.prisma.dT_KPI_CATEGORY.upsert({
        where: { id: category.id },
        create: category,
        update: {},
      });
    }
    const existing = await this.prisma.dT_KPI.count({ where: { ownerNik: ANDI_NIK } });
    if (existing > 0) return;
    for (const [index, kpi] of ANDI_KPIS.entries()) {
      await this.prisma.dT_KPI.create({
        data: {
          ownerNik: ANDI_NIK,
          title: kpi.title,
          weight: kpi.weight,
          breakdown: JSON.stringify(kpi.breakdown),
          escalation: JSON.stringify(ANDI_ESCALATION),
          sortOrder: index,
          createdBy: ANDI_NIK,
          targets: {
            create: kpi.targets.map((target, targetIndex) => ({
              text: target.text,
              methodId: target.methodId,
              targetValue: target.targetValue,
              dueDay: target.due?.day ?? null,
              dueMonth: target.due?.month ?? null,
              sortOrder: targetIndex,
            })),
          },
        },
      });
    }
  }

  private async ownsTemplate(nik: string) {
    const count = await this.prisma.dT_KPI.count({ where: { ownerNik: nik } });
    return count > 0;
  }

  private async personalKpis(niks: string[], month: string) {
    const grouped = new Map<string, ReturnType<DailyTaskKpiService['presentKpi']>[]>();
    if (niks.length === 0) return grouped;
    const rows = await this.prisma.dT_KPI.findMany({
      where: { ownerNik: { in: niks } },
      include: { targets: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    for (const row of rows) {
      const nik = row.ownerNik?.trim();
      if (!nik) continue;
      const list = grouped.get(nik) ?? [];
      list.push(this.presentKpi(row, month));
      grouped.set(nik, list);
    }
    return grouped;
  }

  private async loadKpis(departmentId: string | null, ownerNik: string | null, month: string) {
    const rows = await this.prisma.dT_KPI.findMany({
      where: ownerNik ? { ownerNik } : { departmentId, ownerNik: null },
      include: { targets: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((row) => this.presentKpi(row, month));
  }

  private presentKpi(
    row: {
      id: string;
      title: string;
      weight: Prisma.Decimal | number;
      seasonal: boolean;
      breakdown: string;
      escalation: string;
      targets: Array<{
        id: string;
        text: string;
        dueDate: Date | null;
        dueDay: number | null;
        dueMonth: number | null;
        methodId: string | null;
        targetValue: Prisma.Decimal | number | null;
      }>;
    },
    month: string,
  ) {
    return {
      id: row.id,
      title: row.title,
      seasonal: row.seasonal,
      weight: Number(row.weight),
      breakdown: this.readLines(row.breakdown),
      escalation: this.readLines(row.escalation),
      targets: [...row.targets]
        .sort((a, b) => ('sortOrder' in a && 'sortOrder' in b ? Number(a.sortOrder) - Number(b.sortOrder) : 0))
        .map((target) => ({
          id: target.id,
          text: target.text,
          dueDate: this.dueLabel(month, target.dueDay, target.dueMonth, target.dueDate),
          methodId: target.methodId,
          targetValue: target.targetValue == null ? null : Number(target.targetValue),
        })),
    };
  }

  private async targetCreates(targets: TargetInput[]) {
    const clean = targets.filter((target) => target.text?.trim());
    if (clean.length === 0) throw new BadRequestException('Minimal satu target');
    const rows = [];
    for (const [index, target] of clean.entries()) {
      rows.push({ ...(target.id ? { id: target.id } : {}), ...(await this.targetData(target, index)) });
    }
    return rows;
  }

  private async targetData(target: TargetInput, sortOrder: number) {
    const methodId = target.methodId?.trim() || null;
    if (methodId) {
      const method = await this.prisma.dT_KPI_METHOD.findUnique({ where: { id: methodId } });
      if (!method) throw new BadRequestException('Metode penilaian tidak dikenal');
    }
    const parsed = this.parseDate(target.dueDate);
    return {
      text: target.text.trim(),
      methodId,
      targetValue: target.targetValue == null || Number.isNaN(Number(target.targetValue)) ? null : Number(target.targetValue),
      dueDate: parsed,
      sortOrder,
    };
  }

  private async assertTarget(targetId: string) {
    const target = await this.prisma.dT_KPI_TARGET.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Target tidak ditemukan');
    return target;
  }

  private isPastDue(label: string | null) {
    const date = label ? this.parseDate(label) : null;
    if (!date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }

  private async profile(actorNik: string) {
    const nik = this.assertNik(actorNik);
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { roleId: true, kpiAdmin: true },
    });
    const departmentId = await this.departmentOf(nik);
    const extraIds = await this.extraDepartmentsOf(nik);
    const departmentIds = [...new Set([departmentId, ...extraIds].filter((id): id is string => Boolean(id)))];
    const roleId = user?.roleId ?? 'STAFF';
    return {
      nik,
      roleId,
      kpiAdmin: roleId === 'HEAD' && Boolean(user?.kpiAdmin),
      departmentId,
      departmentIds,
    };
  }

  private async extraDepartmentsOf(nik: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT LTRIM(RTRIM(CONVERT(varchar(30), t.DepartemenIDLng))) AS id
      FROM hris.dbo.SM_DEPT_LIST l
      INNER JOIN hris.dbo.SM_DEPT_DETAIL d
        ON LTRIM(RTRIM(d.NIK_SM)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(l.NIK)) COLLATE DATABASE_DEFAULT
      INNER JOIN hris.dbo.tbldepartemen t
        ON LTRIM(RTRIM(t.KodeDepartemenStr)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(d.DEPT)) COLLATE DATABASE_DEFAULT
      WHERE l.STATUS = 1
        AND l.NIK IS NOT NULL
        AND LTRIM(RTRIM(l.NIK)) COLLATE DATABASE_DEFAULT = ${nik.trim()}
    `;
    return rows.map((row) => row.id?.trim()).filter((id): id is string => Boolean(id));
  }

  private mayEditKpi(profile: { roleId: string; kpiAdmin: boolean; departmentId: string | null }, departmentId: string) {
    if (profile.roleId === 'SUPER' || profile.roleId === 'ADMIN') return true;
    return profile.kpiAdmin && profile.departmentId === departmentId;
  }

  private async assertCanEditKpi(actorNik: string, departmentId: string) {
    const profile = await this.profile(actorNik);
    if (!this.mayEditKpi(profile, departmentId)) {
      throw new ForbiddenException('KPI departemen ini tidak bisa diubah');
    }
  }

  private async assertMaster(actorNik: string) {
    const profile = await this.profile(actorNik);
    if (profile.roleId !== 'SUPER' && profile.roleId !== 'ADMIN') {
      throw new ForbiddenException('Master KPI hanya bisa diubah admin');
    }
  }

  private async isHeadOf(actorNik: string, departmentId: string) {
    const nik = actorNik?.trim() ?? '';
    if (!/^\d{8}$/.test(nik)) return false;
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { roleId: true },
    });
    if (user?.roleId !== 'HEAD') return false;
    const department = await this.departmentOf(actorNik);
    return department === departmentId;
  }

  private async departmentOf(nik: string) {
    const rows = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT TOP 1 LTRIM(RTRIM(CONVERT(varchar(30), l.DepartemenIDLng))) AS id
      FROM hris.dbo.tblpegawai t1
      INNER JOIN (
        SELECT
          tj.PegawaiIDLng,
          tj.DepartemenIDLng,
          ROW_NUMBER() OVER (PARTITION BY tj.PegawaiIDLng ORDER BY tj.PegawaiJabatanIDLng DESC) AS rn
        FROM hris.dbo.tblpegawaijabatan tj
      ) l ON l.PegawaiIDLng = t1.PegawaiIDLng AND l.rn = 1
      WHERE LTRIM(RTRIM(t1.NomorIndukStr)) COLLATE DATABASE_DEFAULT = ${nik.trim()}
    `;
    return rows[0]?.id?.trim() || null;
  }

  private progressOf(
    kpis: Array<{ weight: number; targets: { id: string }[] }>,
    nik: string,
    done: Set<string>,
  ) {
    let pending = 0;
    let earned = 0;
    let weight = 0;
    for (const kpi of kpis) {
      weight += kpi.weight;
      const total = kpi.targets.length;
      if (total === 0) continue;
      const finished = kpi.targets.filter((target) => done.has(`${nik}|${target.id}`)).length;
      pending += total - finished;
      earned += (kpi.weight * finished) / total;
    }
    return { pending, weightPercent: weight === 0 ? 0 : Math.round((earned / weight) * 100) };
  }

  private workStatusOf(value: string | null | undefined): WorkStatus {
    return value === 'doing' || value === 'done' ? value : 'todo';
  }

  private sheetPath(departmentId: string, nik: string) {
    return `/dashboard/daily-task/${departmentId.trim()}?user=${encodeURIComponent(nik.trim())}`;
  }

  private async targetText(targetId: string) {
    const target = await this.prisma.dT_KPI_TARGET.findUnique({
      where: { id: targetId },
      select: { text: true },
    });
    const text = target?.text?.trim() || 'target';
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  private async displayName(nik: string) {
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik: this.assertNik(nik) },
      select: { nama: true },
    });
    return user?.nama?.trim() || nik;
  }

  private async headsOf(departmentId: string) {
    const id = departmentId.trim();
    if (!/^\d+$/.test(id)) return [];
    const rows = await this.prisma.$queryRaw<{ nik: string; email: string | null; nama: string | null }[]>`
      SELECT LTRIM(RTRIM(u.nik)) AS nik,
             NULLIF(LTRIM(RTRIM(u.email)), '') AS email,
             u.nama AS nama
      FROM DT_USER u
      INNER JOIN hris.dbo.tblpegawai t1
        ON LTRIM(RTRIM(t1.NomorIndukStr)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(u.nik)) COLLATE DATABASE_DEFAULT
      INNER JOIN (
        SELECT
          tj.PegawaiIDLng,
          tj.DepartemenIDLng,
          ROW_NUMBER() OVER (PARTITION BY tj.PegawaiIDLng ORDER BY tj.PegawaiJabatanIDLng DESC) AS rn
        FROM hris.dbo.tblpegawaijabatan tj
      ) l ON l.PegawaiIDLng = t1.PegawaiIDLng AND l.rn = 1
      WHERE u.roleId = 'HEAD'
        AND u.statusActive = 1
        AND LTRIM(RTRIM(CONVERT(varchar(30), l.DepartemenIDLng))) = ${id}
    `;
    return rows.filter((row) => row.nik);
  }

  private async notifyUsers(
    niks: string[],
    actorNik: string,
    title: string,
    message: string,
    path: string,
    type: 'kpi.status' | 'kpi.realisasi',
    known?: { nik: string; email: string | null; nama: string | null }[],
  ) {
    const actor = actorNik.trim();
    const targets = [...new Set(niks.map((nik) => nik.trim()).filter((nik) => nik && nik !== actor))];
    if (targets.length === 0) return;
    for (const nik of targets) {
      this.pushService.notifyUser(nik, { type, title, body: message, url: path, tag: `${type}:${nik}` });
    }
    const people = known
      ? known
      : (await this.prisma.dT_USER.findMany({
          where: { nik: { in: targets } },
          select: { nik: true, email: true, nama: true },
        })).map((row) => ({ nik: row.nik.trim(), email: row.email, nama: row.nama }));
    for (const person of people) {
      const email = person.email?.trim();
      if (!email || !targets.includes(person.nik.trim())) continue;
      try {
        await this.mailService.sendDailyTaskNotice({
          to: email,
          name: person.nama?.trim() || person.nik,
          title,
          message,
          path,
        });
      } catch (error) {
        this.logger.warn(`Email KPI ke ${person.nik} gagal: ${(error as Error).message}`);
      }
    }
  }

  private async writeLog(
    tx: Prisma.TransactionClient,
    input: {
      actorNik: string;
      subjectNik?: string | null;
      departmentId?: string | null;
      month?: string | null;
      entityType: string;
      entityId: string;
      action: string;
      summary: string;
      before?: unknown;
      after?: unknown;
    },
  ) {
    await tx.dT_KPI_LOG.create({
      data: {
        actorNik: this.assertNik(input.actorNik),
        subjectNik: input.subjectNik ? this.assertNik(input.subjectNik) : null,
        departmentId: input.departmentId ?? null,
        month: input.month ?? null,
        entityType: input.entityType,
        entityId: input.entityId.slice(0, 40),
        action: input.action,
        summary: input.summary.slice(0, 400),
        beforeJson: input.before == null ? null : JSON.stringify(input.before),
        afterJson: input.after == null ? null : JSON.stringify(input.after),
      },
    });
  }

  private dueLabel(month: string, dueDay: number | null, dueMonth: number | null, dueDate: Date | null) {
    if (!month) return dueDate ? this.formatDate(dueDate) : null;
    if (dueDay) {
      const [yearText, monthText] = month.split('-');
      const date = new Date(Number(yearText), (dueMonth ?? Number(monthText)) - 1, dueDay);
      while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
      return this.formatDate(date);
    }
    return dueDate ? this.formatDate(dueDate) : null;
  }

  private formatDate(date: Date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  private parseDate(value: string | null | undefined) {
    const text = value?.trim() ?? '';
    if (!text) return null;
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (local) return new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]));
    const named = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
    if (named) {
      const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
      if (month) return new Date(Number(named[3]), month - 1, Number(named[1]));
    }
    return null;
  }

  private readLines(value: string) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private cleanLines(value: string[] | undefined) {
    return (value ?? []).map((item) => item.trim()).filter(Boolean);
  }

  private cleanTitle(value: string) {
    const title = value?.trim();
    if (!title) throw new BadRequestException('Judul KPI wajib diisi');
    return title;
  }

  private assertNik(nik: string) {
    const clean = nik?.trim();
    if (!/^\d{8}$/.test(clean)) throw new BadRequestException('NIK tidak valid');
    return clean;
  }

  private assertMonth(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new BadRequestException('Bulan tidak valid');
    return month;
  }
}
