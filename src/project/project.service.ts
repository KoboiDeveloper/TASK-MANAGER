import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddTaskDetailRequest,
  CreateProjectRequest,
  CreateTaskProjectRequest,
  UpdateTaskDetailRequest,
  UpdateTaskRequest,
} from './dto/request';
import { EProjectRole } from '../constant/EProjectRole';
import { DT_PROJECT, DT_SECTION, DT_TAG, DT_TASK, DT_TASK_DETAIL, Prisma } from '@prisma/client';
import {
  ProjectDetail,
  ProjectMemberFlat,
  TaskNonSection,
  TaskSectionResponse,
} from './dto/response';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(private readonly prismaService: PrismaService) {}
  // =========================================================
  // 🔹 PROJECT MANAGEMENT
  // =========================================================

  async ownProjects(nik: string): Promise<DT_PROJECT[]> {
    return this.prismaService.dT_PROJECT.findMany({
      where: { user: { nik } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(projectId: string): Promise<ProjectDetail> {
    return this.ensureProjectExists(projectId);
  }

  async create(nik: string, data: CreateProjectRequest): Promise<string> {
    const { name, desc } = data;
    const color = this.generateColorFromString(name);

    return this.prismaService.$transaction(async (tx) => {
      const project = await tx.dT_PROJECT.create({
        data: { name, color, desc, createdBy: nik },
      });
      await tx.dT_MEMBER_PROJECT.create({
        data: { projectId: project.id, nik, id_dt_project_role: EProjectRole.OWNER },
      });
      return project.id;
    });
  }

  // =========================================================
  // 🔹 TASK MANAGEMENT
  // =========================================================

  async createTask(
    projectId: string,
    nik: string,
    data: CreateTaskProjectRequest,
  ): Promise<string> {
    const { name, section, tag } = data;

    await this.ensureProjectExists(projectId);

    const sectionIdNorm = this.normalizeGuid(section ?? null);
    const sectionEntity = sectionIdNorm
      ? await this.ensureSectionExists(projectId, sectionIdNorm)
      : null;

    const tagEntity = tag ? await this.ensureTagExists(projectId, tag) : null;

    const task = await this.prismaService.dT_TASK.create({
      data: {
        name,
        id_dt_project: projectId,
        createdBy: nik,
        id_dt_section: sectionEntity?.id ?? null,
        ...(tagEntity && { tags: { connect: [{ id: tagEntity.id }] } }),
      },
    });

    return task.id;
  }

  async updateTask(taskId: string, dto: UpdateTaskRequest): Promise<DT_TASK> {
    // pastikan task ada
    const exists = await this.prismaService.dT_TASK.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Task ${taskId} not found`);

    // bangun patch hanya dari field yang dikirim
    const patch: Prisma.DT_TASKUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length > 100) throw new BadRequestException('Name exceeds 100 characters');
      patch.name = name;
    }

    if (dto.desc !== undefined) {
      if (dto.desc && dto.desc.length > 100) {
        throw new BadRequestException('desc exceeds 100 characters');
      }
      patch.desc = dto.desc ?? null;
    }

    if (dto.status !== undefined) {
      patch.status = dto.status;
    }

    if (dto.dueDate !== undefined) {
      if (dto.dueDate) {
        const d = new Date(dto.dueDate);
        if (isNaN(d.getTime()))
          throw new BadRequestException('Invalid dueDate (must be ISO string)');
        patch.dueDate = d;
      } else {
        patch.dueDate = null;
      }
    }

    const hasScalarUpdate = Object.keys(patch).length > 0;
    const assigneesProvided = dto.assignees !== undefined;

    if (!hasScalarUpdate && !assigneesProvided) {
      throw new BadRequestException('No valid fields to update');
    }

    // transaksi: update scalar + reset assignees bila dikirim
    const updated = await this.prismaService.$transaction(async (tx) => {
      if (hasScalarUpdate) {
        await tx.dT_TASK.update({
          where: { id: taskId },
          data: patch,
          select: { id: true },
        });
      }

      if (assigneesProvided) {
        await tx.dT_ASSIGNEE_TASK.deleteMany({ where: { taskId } });
        if (dto.assignees && dto.assignees.length > 0) {
          await tx.dT_ASSIGNEE_TASK.createMany({
            data: dto.assignees.map((a) => ({
              taskId,
              nik: a.nik,
              name: a.name,
            })),
          });
        }
      }

      return tx.dT_TASK.findUnique({
        where: { id: taskId },
        include: {
          section: true,
          assignees: true,
          tags: true,
          // details: true, logs: true, // tambahkan bila perlu
        },
      });
    });

    if (!updated) throw new NotFoundException(`Task ${taskId} not found after update`);
    return updated;
  }

  async moveTask(
    projectId: string,
    taskId: string,
    body: { targetSectionId?: string | null; beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_TASK> {
    const pid = this.normalizeGuid(projectId);
    const tid = this.normalizeGuid(taskId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!tid) throw new BadRequestException('Invalid taskId');

    // 1) Pastikan task ada & milik project ini
    const task = await this.prismaService.dT_TASK.findFirst({
      where: { id: tid, id_dt_project: pid },
      select: { id: true, id_dt_project: true, id_dt_section: true, rank: true },
    });
    if (!task) throw new NotFoundException(`Task ${tid} not found in project ${pid}`);

    // 2) Tentukan section tujuan:
    //    - kalau 'targetSectionId' tidak DIKIRIM → reorder in-place (pakai section asal)
    //    - kalau DIKIRIM null → pindah ke UNLOCATED
    //    - kalau DIKIRIM UUID → pindah ke section tsb (divalidasi)
    let destSectionId: string | null;
    if ('targetSectionId' in body) {
      const normTarget = this.normalizeGuid(body.targetSectionId ?? null);
      destSectionId = normTarget ?? null;
    } else {
      destSectionId = task.id_dt_section; // reorder di section yang sama
    }

    if (destSectionId) {
      await this.ensureSectionExists(pid, destSectionId);
    }

    // 3) Normalisasi tetangga (wajib berada di section tujuan)
    const beforeId = this.normalizeGuid(body.beforeId ?? null);
    const afterId = this.normalizeGuid(body.afterId ?? null);

    // hindari self-reference
    const safeBeforeId = beforeId === tid ? null : beforeId;
    const safeAfterId = afterId === tid ? null : afterId;

    // 4) Ambil rank tetangga di section tujuan
    const [before, after] = await Promise.all([
      safeBeforeId
        ? this.prismaService.dT_TASK.findFirst({
            where: { id: safeBeforeId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
            select: { rank: true },
          })
        : Promise.resolve(null),
      safeAfterId
        ? this.prismaService.dT_TASK.findFirst({
            where: { id: safeAfterId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
            select: { rank: true },
          })
        : Promise.resolve(null),
    ]);

    // 5) Jika before/after kosong → taruh di akhir
    let newRank: string;
    if (!before && !after) {
      const last = await this.prismaService.dT_TASK.findFirst({
        where: { id_dt_project: pid, id_dt_section: destSectionId ?? null },
        orderBy: { rank: 'desc' },
        select: { rank: true },
      });
      newRank = this.rankAfter(last?.rank ?? null);
    } else {
      newRank = this.rankBetween(after?.rank ?? null, before?.rank ?? null);
    }

    // 6) Early exit bila benar-benar tidak berubah (jarang terjadi)
    const sameSection = (task.id_dt_section ?? null) === (destSectionId ?? null);
    if (sameSection && task.rank === newRank) {
      // Ambil entity terkini (tanpa include agar tipenya DT_TASK murni)
      const current = await this.prismaService.dT_TASK.findUnique({ where: { id: tid } });
      // prisma.findUnique bisa return null secara tipe, tapi semestinya ada karena task sudah dicek
      // fallback aman:
      if (!current) throw new NotFoundException(`Task ${tid} not found`);
      return current;
    }

    // 7) Update section + rank baru
    return this.prismaService.dT_TASK.update({
      where: { id: tid },
      data: {
        id_dt_section: destSectionId ?? null,
        rank: newRank,
      },
    });
  }

  // =========================================================
  // 🔹 TASK DETAIL MANAGEMENT
  // =========================================================

  async addTaskDetail(taskId: string, data: AddTaskDetailRequest): Promise<DT_TASK_DETAIL> {
    const task = await this.prismaService.dT_TASK.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    return this.prismaService.dT_TASK_DETAIL.create({
      data: {
        name: data.name,
        dueDate: data.dueDate ?? null,
        priority: data.priority ?? null,
        status: data.status ?? null,
        id_dt_task: taskId,
      },
    });
  }

  async updateTaskDetail(detailId: string, data: UpdateTaskDetailRequest): Promise<DT_TASK_DETAIL> {
    const detail = await this.prismaService.dT_TASK_DETAIL.findUnique({ where: { id: detailId } });
    if (!detail) throw new NotFoundException(`Task detail ${detailId} not found`);

    return this.prismaService.dT_TASK_DETAIL.update({
      where: { id: detailId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
  }

  async deleteTaskDetail(detailId: string): Promise<{ message: string }> {
    const exist = await this.prismaService.dT_TASK_DETAIL.findUnique({ where: { id: detailId } });
    if (!exist) throw new NotFoundException(`Task detail ${detailId} not found`);

    await this.prismaService.dT_TASK_DETAIL.delete({ where: { id: detailId } });
    return { message: 'Task detail deleted successfully' };
  }

  // =========================================================
  // 🔹 SECTION MANAGEMENT (ordered)
  // =========================================================
  private mapTask(t: {
    id: string;
    name: string;
    desc: string | null;
    dueDate: Date | null;
    status: boolean;
    assignees: { nik: string; name: string; assignedAt: Date }[];
    creator: { nama: string } | null;
  }): TaskNonSection {
    return {
      id: t.id,
      name: t.name,
      desc: t.desc,
      dueDate: t.dueDate ?? null,
      status: Boolean(t.status),
      assignees: (t.assignees ?? []).map((a) => ({
        nik: a.nik,
        name: a.name,
        assignedAt: a.assignedAt,
      })),
      creator: { nama: t.creator?.nama ?? '' },
    };
  }

  async findTasksAndSections(projectId: string): Promise<TaskSectionResponse> {
    const [unlocatedTasks, sections] = await Promise.all([
      this.prismaService.dT_TASK.findMany({
        where: { id_dt_project: projectId, id_dt_section: null },
        select: {
          id: true,
          name: true,
          dueDate: true,
          desc: true,
          status: true,
          assignees: { select: { nik: true, name: true, assignedAt: true } },
          creator: { select: { nama: true } },
        },
        orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      }),
      this.prismaService.dT_SECTION.findMany({
        where: { id_dt_project: projectId },
        select: {
          id: true,
          name: true,
          rank: true,
          tasks: {
            select: {
              id: true,
              name: true,
              desc: true,
              dueDate: true,
              status: true,
              assignees: { select: { nik: true, name: true, assignedAt: true } },
              creator: { select: { nama: true } },
            },
            orderBy: [{ rank: 'asc' }, { id: 'asc' }],
          },
        },
        orderBy: { rank: 'asc' },
      }),
    ]);

    if (unlocatedTasks.length === 0 && sections.length === 0) {
      throw new NotFoundException(`No tasks found in project ${projectId}`);
    }

    return {
      unlocated: unlocatedTasks.map((t) => this.mapTask(t)),
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        tasks: s.tasks.map((t) => this.mapTask(t)),
      })),
    };
  }

  async createSection(projectId: string, name: string): Promise<DT_SECTION> {
    const last = await this.prismaService.dT_SECTION.findFirst({
      where: { id_dt_project: projectId },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    let rank = last ? this.rankAfter(last.rank) : '8888888888888888';

    for (let i = 0; i < 3; i += 1) {
      try {
        return await this.prismaService.dT_SECTION.create({
          data: { name, id_dt_project: projectId, rank },
        });
      } catch (e) {
        if (this.isUniqueConstraintError(e) && i < 2) {
          const next = await this.prismaService.dT_SECTION.findFirst({
            where: { id_dt_project: projectId },
            orderBy: { rank: 'desc' },
            select: { rank: true },
          });
          rank = this.rankAfter(next?.rank ?? rank);
          continue;
        }
        this.logger.error('createSection failed', e instanceof Error ? e.stack : String(e));
        throw e;
      }
    }

    return this.prismaService.dT_SECTION.create({
      data: { name, id_dt_project: projectId, rank },
    });
  }

  async updateSection(sectionId: string, name: string): Promise<DT_SECTION> {
    return await this.prismaService.dT_SECTION.update({
      where: { id: sectionId },
      data: { name: name },
    });
  }

  async moveSection(
    projectId: string,
    sectionId: string,
    opts: { beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_SECTION> {
    const pid = this.normalizeGuid(projectId);
    const sid = this.normalizeGuid(sectionId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!sid) throw new BadRequestException('Invalid sectionId');

    await this.ensureSectionExists(pid, sid);

    const beforeId = this.normalizeGuid(opts.beforeId ?? null);
    const afterId = this.normalizeGuid(opts.afterId ?? null);

    const [before, after] = await Promise.all([
      beforeId
        ? this.prismaService.dT_SECTION.findFirst({
            where: { id: beforeId, id_dt_project: pid },
            select: { rank: true },
          })
        : Promise.resolve(null),
      afterId
        ? this.prismaService.dT_SECTION.findFirst({
            where: { id: afterId, id_dt_project: pid },
            select: { rank: true },
          })
        : Promise.resolve(null),
    ]);

    const newRank = this.rankBetween(after?.rank ?? null, before?.rank ?? null);

    return this.prismaService.dT_SECTION.update({
      where: { id: sid },
      data: { rank: newRank },
    });
  }

  // =========================================================
  // 🔹 TAG MANAGEMENT
  // =========================================================

  async findTags(projectId: string): Promise<DT_TAG[]> {
    return this.prismaService.dT_TAG.findMany({
      where: { id_dt_project: projectId },
      orderBy: { name: 'asc' },
    });
  }

  async findTag(projectId: string, tagId: string): Promise<DT_TAG> {
    const tag = await this.prismaService.dT_TAG.findFirst({
      where: { id_dt_project: projectId, id: tagId },
    });
    if (!tag) throw new NotFoundException(`Tag with id ${tagId} not found in project ${projectId}`);
    return tag;
  }

  async createTag(projectId: string, tagName: string): Promise<string> {
    const existing = await this.prismaService.dT_TAG.findFirst({
      where: { id_dt_project: projectId, name: tagName },
    });
    if (existing) throw new ConflictException(`Tag '${tagName}' already exists`);
    await this.prismaService.dT_TAG.create({ data: { name: tagName, id_dt_project: projectId } });
    return 'tag created';
  }

  // =========================================================
  // 🔹 HELPER METHODS
  // =========================================================

  // =========================
  // 🔢 RANKING UTIL (Section)
  // =========================
  private static readonly WIDTH = 16;
  private static readonly MAX = BigInt('9'.repeat(ProjectService.WIDTH));

  private pad(n: bigint): string {
    const s = n.toString();
    const w = ProjectService.WIDTH;
    return s.length >= w ? s.slice(-w) : '0'.repeat(w - s.length) + s;
  }
  private toBig(s?: string | null): bigint {
    return s && s.length ? BigInt(s) : 0n;
  }
  private mid(a: bigint, b: bigint): string {
    if (a >= b) return this.pad((a + ProjectService.MAX) / 2n);
    const m = (a + b) / 2n;
    if (m === a || m === b) return this.pad(a + 1n);
    return this.pad(m);
  }
  private rankBetween(prev?: string | null, next?: string | null): string {
    if (!prev && !next) return '8'.repeat(ProjectService.WIDTH);
    if (!prev && next) return this.pad(this.toBig(next) / 2n);
    if (prev && !next) return this.pad((this.toBig(prev) + ProjectService.MAX) / 2n);
    return this.mid(this.toBig(prev), this.toBig(next));
  }
  private rankAfter(prev?: string | null): string {
    return this.rankBetween(prev ?? null, null);
  }
  private static readonly UUID_REGEX =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  private stripSectionPrefix(id?: string | null): string | null {
    if (!id) return null;
    return id.startsWith('section-') ? id.replace(/^section-/, '') : id;
  }
  private normalizeGuid(id?: string | null): string | null {
    const raw = this.stripSectionPrefix(id);
    if (!raw || !ProjectService.UUID_REGEX.test(raw)) return null;
    return raw.toLowerCase();
  }

  private generateColorFromString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const color = (hash & 0x00ffff_ff).toString(16).toUpperCase().padStart(6, '0');
    return `#${color}`;
  }

  private async ensureProjectExists(projectId: string): Promise<ProjectDetail> {
    const project = await this.prismaService.dT_PROJECT.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        desc: true,
        members: {
          select: {
            nik: true,
            roleProject: { select: { name: true } },
            user: { select: { nama: true } },
          },
        },
        activities: true,
      },
    });
    if (!project) throw new NotFoundException(`Project with id ${projectId} not found`);

    const formattedMembers: ProjectMemberFlat[] = project.members.map((m) => ({
      nik: m.nik.trim(),
      role: m.roleProject?.name ?? null,
      nama: m.user?.nama ?? null,
    }));

    return {
      id: project.id,
      name: project.name,
      desc: project.desc,
      members: formattedMembers,
      activities: project.activities,
    };
  }

  private async ensureSectionExists(projectId: string, sectionId: string): Promise<DT_SECTION> {
    const pid = this.normalizeGuid(projectId);
    const sid = this.normalizeGuid(sectionId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!sid) throw new BadRequestException('Invalid sectionId');

    const section = await this.prismaService.dT_SECTION.findFirst({
      where: { id: sid, id_dt_project: pid },
    });
    if (!section) throw new NotFoundException(`Section ${sid} not found in project ${pid}`);
    return section;
  }

  private async ensureTagExists(projectId: string, tagName: string): Promise<DT_TAG> {
    const tag = await this.prismaService.dT_TAG.findFirst({
      where: { id_dt_project: projectId, name: tagName },
    });
    if (tag) return tag;
    return this.prismaService.dT_TAG.create({
      data: { name: tagName, id_dt_project: projectId },
    });
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return Boolean(
      typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002',
    );
  }
}
