import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddSubTaskRequest,
  CreateProjectRequest,
  CreateTaskProjectRequest,
  MemberRequest,
  RemoveSectionArgs,
  SyncSubTaskAssigneeRequest,
  UpdateProjectRequest,
  UpdateSubTaskRequest,
  UpdateTaskRequest,
} from './dto/request';
import { DT_PROJECT, DT_SECTION, DT_SUB_TASK, DT_TAG, DT_TASK, Prisma } from '@prisma/client';
import {
  ProjectDetail,
  ProjectMemberFlat,
  SubTask,
  TaskNonSection,
  TaskSectionResponse,
  AttachmentTask,
  ownTaskResponse,
} from './dto/response';
import { UserService } from '../user/user.service';
import { MailService } from '../utils/mail/mail.service';
import { EProjectRole } from '../constant/EProjectRole';
import { del, put } from '@vercel/blob';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
  ) {}

  // =========================================================
  // 🔹 PROJECT MANAGEMENT
  // =========================================================

  async ownProjects(nik: string, roleId?: string): Promise<DT_PROJECT[]> {
    if (roleId === 'SUPER') {
      return this.prismaService.dT_PROJECT.findMany({
        orderBy: { name: 'asc' },
      });
    }
    return this.prismaService.dT_PROJECT.findMany({
      where: {
        members: {
          some: { nik: { equals: nik } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(projectId: string): Promise<ProjectDetail> {
    return this.ensureProjectExists(projectId);
  }

  async create(creatorNik: string, data: CreateProjectRequest): Promise<string> {
    const { name, desc = null, members = [] } = data;
    const color = this.generateColorFromString(name);

    // 1) Buat project + OWNER dalam satu transaksi
    const projectId = await this.prismaService.$transaction(async (tx) => {
      const project = await tx.dT_PROJECT.create({
        data: { name, color, desc, createdBy: creatorNik },
      });

      // creator selalu jadi OWNER
      await tx.dT_MEMBER_PROJECT.create({
        data: {
          projectId: project.id,
          nik: creatorNik,
          id_dt_project_role: EProjectRole.OWNER,
        },
      });

      // anggota lain TIDAK dibuat di sini, supaya semua logika diff dipegang syncProjectMembers
      return project.id;
    });

    // 2) Normalisasi members dari FE (tanpa OWNER/creator)
    const normalizedMembers = this.normalizeMembersFromCreate(members, creatorNik);

    // 3) Kalau ada anggota lain → pakai service diff global (sekalian kirim email)
    if (normalizedMembers.length > 0) {
      try {
        await this.syncProjectMembers(projectId, normalizedMembers);
      } catch (err) {
        // Jangan jatuhkan create project hanya karena sync/email gagal
        this.logger.warn(`syncProjectMembers after create failed: ${String(err)}`);
      }
    }

    return projectId;
  }

  async updateProjectById(id: string, data: UpdateProjectRequest): Promise<string> {
    const { name, desc, isArchive, members } = data;

    try {
      // 1) Update field project-nya (kalau ada yg dikirim)
      if (name !== undefined || desc !== undefined || isArchive !== undefined) {
        await this.prismaService.dT_PROJECT.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(desc !== undefined ? { desc } : {}),
            ...(isArchive !== undefined ? { isArchive } : {}),
          },
        });
      }

      // 2) Sync members kalau dikirim dari FE
      if (Array.isArray(members)) {
        await this.syncProjectMembers(id, members);
      }

      return `Project with ${id} successfully updated`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update project';
      throw new ConflictException(message);
    }
  }

  async deleteProjectById(id: string): Promise<string> {
    try {
      await this.prismaService.$transaction(async (tx) => {
        await tx.dT_ASSIGNEE_SUBTASK.deleteMany({
          where: {
            subTask: {
              task: { id_dt_project: id },
            },
          },
        });

        await tx.dT_ASSIGNEE_TASK.deleteMany({
          where: {
            task: { id_dt_project: id },
          },
        });

        await tx.dT_SUB_TASK.deleteMany({
          where: { task: { id_dt_project: id } },
        });

        await tx.dT_TASK.deleteMany({
          where: { id_dt_project: id },
        });

        await tx.dT_MEMBER_PROJECT.deleteMany({
          where: { projectId: id },
        });

        await tx.dT_PROJECT.delete({
          where: { id },
        });
      });

      return `Project ${id} deleted`;
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Project ${id} not found`);
      }
      throw new ConflictException('Failed to delete project');
    }
  }

  // =========================================================
  // 🔹 TASK MANAGEMENT
  // =========================================================

  async createTask(
    projectId: string,
    nik: string,
    data: CreateTaskProjectRequest,
  ): Promise<string> {
    const { name, desc, section } = data;

    await this.ensureProjectExists(projectId);

    // Cari task dengan rank paling BESAR (paling bawah)
    const last = await this.prismaService.dT_TASK.findFirst({
      where: {
        id_dt_project: projectId,
        id_dt_section: section ?? null,
      },
      orderBy: { rank: 'desc' }, // ambil rank terbesar
      select: { rank: true },
    });

    let newRank: string;

    // 1) Belum ada task, ATAU task ada tapi rank-nya masih null
    if (!last || !last.rank) {
      newRank = this.rankFirst(); // "0000000000000001"
    } else {
      // 2) Sudah ada rank valid → append di paling bawah
      newRank = this.rankAfter(last.rank); // selalu 16 digit string
    }

    this.logger.debug(
      `createTask(project=${projectId}, section=${section ?? 'NULL'}) lastRank=${
        last?.rank ?? 'NULL'
      } newRank=${newRank}`,
    );

    const task = await this.prismaService.dT_TASK.create({
      data: {
        name,
        desc,
        id_dt_project: projectId,
        id_dt_section: section ?? null,
        createdBy: nik,
        rank: newRank,
      },
    });

    return task.id;
  }

  // project.service.ts
  async taskOwn(nik: string): Promise<ownTaskResponse[]> {
    return this.prismaService.dT_TASK.findMany({
      where: {
        assignees: {
          some: {
            nik,
          },
        },
        status: false,
      },
      select: {
        id: true,
        name: true,
        status: true,
        dueDate: true,
        project: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
      },
    });
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
        },
      });
    });

    if (!updated) throw new NotFoundException(`Task ${taskId} not found after update`);
    return updated;
  }

  async deleteTaskId(taskId: string): Promise<string> {
    try {
      // 1) Ambil semua attachment yang terkait task ini (sebelum transaksi)
      const attachments = await this.prismaService.dT_TASK_ATTACHMENT.findMany({
        where: { taskId },
        select: {
          id: true,
          url: true,
        },
      });

      // 2) Jalankan transaksi untuk hapus data di DB
      await this.prismaService.$transaction(async (tx) => {
        await tx.dT_ASSIGNEE_SUBTASK.deleteMany({
          where: {
            subTask: {
              task: { id: taskId },
            },
          },
        });

        await tx.dT_ASSIGNEE_TASK.deleteMany({
          where: {
            task: { id: taskId },
          },
        });

        await tx.dT_TASK_ATTACHMENT.deleteMany({
          where: {
            taskId,
          },
        });

        await tx.dT_SUB_TASK.deleteMany({
          where: { task: { id: taskId } },
        });

        const deletedTask = await tx.dT_TASK.delete({
          where: { id: taskId },
        });

        if (!deletedTask) {
          throw new Prisma.PrismaClientKnownRequestError('Task not found', {
            code: 'P2025',
            clientVersion: 'unknown',
          });
        }
      });

      // 3) Hapus file di Vercel Blob di luar transaksi
      await Promise.all(
        attachments.map(async (att) => {
          if (!att.url) return;
          try {
            await del(att.url);
          } catch (err) {
            console.error('Failed to delete blob for attachment', att.id, att.url, err);
          }
        }),
      );

      return `Task ${taskId} deleted`;
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Task ${taskId} not found`);
      }
      throw new ConflictException('Failed to delete task');
    }
  }

  async AddTaskAttachments(taskId: string, attachments: Express.Multer.File[]): Promise<string> {
    // validasi basic
    if (!attachments || attachments.length === 0) {
      throw new BadRequestException('No attachments uploaded');
    }

    // pastikan task ada
    const task = await this.prismaService.dT_TASK.findUnique({
      where: { id: taskId },
      select: { id: true },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    // 1) Upload ke Vercel Blob dulu (di luar transaksi DB)
    const uploadedAttachments = await Promise.all(
      attachments.map(async (file) => {
        const originalName = file.originalname || 'file';
        const safeFilename = originalName.length > 20 ? originalName.slice(0, 20) : originalName; // schema: VarChar(20)

        const key = `tasks/${taskId}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}-${originalName}`;

        const blob = await put(key, file.buffer, {
          access: 'public',
          contentType: file.mimetype,
        });

        return {
          taskId,
          url: blob.url,
          filename: safeFilename,
          mimeType: file.mimetype,
          bytes: file.size,
        };
      }),
    );

    await this.prismaService.dT_TASK_ATTACHMENT.createMany({
      data: uploadedAttachments,
    });

    return `Uploaded ${uploadedAttachments.length} attachment(s) to task ${taskId}`;
  }

  async getTaskAttachments(taskId: string): Promise<AttachmentTask[]> {
    return this.prismaService.dT_TASK_ATTACHMENT.findMany({
      where: { taskId: taskId },
    });
  }

  async deleteTaskAttachments(
    taskId: string,
    attachmentIds: Array<string | { id: string }>,
  ): Promise<string> {
    // 0) Normalisasi: pastikan kita punya string[]
    const ids = attachmentIds.map((v) => (typeof v === 'string' ? v : v.id)).filter(Boolean);

    // 1) Validasi basic
    if (!ids.length) {
      throw new BadRequestException('No attachment ids provided');
    }

    // 2) Pastikan task ada
    const task = await this.prismaService.dT_TASK.findUnique({
      where: { id: taskId },
      select: { id: true },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    // 3) Ambil attachment yang match taskId + id
    const attachments = await this.prismaService.dT_TASK_ATTACHMENT.findMany({
      where: {
        id: { in: ids },
        taskId,
      },
    });

    if (!attachments.length) {
      throw new NotFoundException('No matching attachments found for this task');
    }

    // Cek kalau ada id yang tidak dimiliki task ini
    const foundIds = new Set(attachments.map((a) => a.id));
    const missing = ids.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      throw new BadRequestException(
        `Some attachment ids do not belong to this task: ${missing.join(', ')}`,
      );
    }

    // 4) Hapus file dari Vercel Blob
    await Promise.all(
      attachments.map(async (att) => {
        try {
          await del(att.url);
        } catch (err) {
          console.error('Failed to delete blob', att.url, err);
        }
      }),
    );

    // 5) Hapus row di DB (bulk)
    await this.prismaService.dT_TASK_ATTACHMENT.deleteMany({
      where: {
        id: { in: ids },
        taskId,
      },
    });

    return `Deleted ${attachments.length} attachment(s) from task ${taskId}`;
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

    // 1) Task harus ada & milik project
    const task = await this.prismaService.dT_TASK.findFirst({
      where: { id: tid, id_dt_project: pid },
      select: { id: true, id_dt_project: true, id_dt_section: true, rank: true },
    });
    if (!task) throw new NotFoundException(`Task ${tid} not found in project ${pid}`);

    // 2) Tujuan section:
    //    - properti targetSectionId TIDAK DIKIRIM => reorder in-place
    //    - DIKIRIM null => pindah ke UNLOCATED
    //    - DIKIRIM UUID => pindah ke section tsb
    let destSectionId: string | null;
    if ('targetSectionId' in body) {
      const normTarget = this.normalizeGuid(body.targetSectionId ?? null);
      destSectionId = normTarget ?? null;
    } else {
      destSectionId = task.id_dt_section; // in-place
    }

    if (destSectionId) {
      await this.ensureSectionExists(pid, destSectionId);
    }

    // 3) Normalisasi tetangga (harus di section tujuan)
    const beforeIdRaw = this.normalizeGuid(body.beforeId ?? null);
    const afterIdRaw = this.normalizeGuid(body.afterId ?? null);
    const beforeId = beforeIdRaw === tid ? null : beforeIdRaw;
    const afterId = afterIdRaw === tid ? null : afterIdRaw;

    // 4) Ambil rank tetangga di section tujuan
    const [before, after] = await Promise.all([
      beforeId
        ? this.prismaService.dT_TASK.findFirst({
            where: { id: beforeId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
            select: { rank: true },
          })
        : Promise.resolve(null),
      afterId
        ? this.prismaService.dT_TASK.findFirst({
            where: { id: afterId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
            select: { rank: true },
          })
        : Promise.resolve(null),
    ]);

    // 5) Hitung rank baru (LIST ASC – rank kecil = paling atas)
    const computeNewRank = async (): Promise<string> => {
      // FE: afterId = neighbor ATAS, beforeId = neighbor BAWAH
      const top = after;
      const bottom = before;

      // ✅ Kedua tetangga ada → sisip di tengah
      if (top && bottom) {
        return this.rankBetween(top.rank ?? null, bottom.rank ?? null);
      }

      // ✅ Hanya ada tetangga atas (top) → taruh TEPAT DI BAWAH-nya
      if (top && !bottom) {
        const nextBelow = await this.prismaService.dT_TASK.findFirst({
          where: {
            id_dt_project: pid,
            id_dt_section: destSectionId ?? null,
            rank: { gt: top.rank ?? undefined }, // bawah = rank lebih besar
          },
          orderBy: { rank: 'asc' }, // yang paling dekat di bawah
          select: { rank: true },
        });

        return this.rankBetween(top.rank ?? null, nextBelow?.rank ?? null);
      }

      // ✅ Hanya ada tetangga bawah (bottom) → taruh TEPAT DI ATAS-nya
      if (!top && bottom) {
        const prevAbove = await this.prismaService.dT_TASK.findFirst({
          where: {
            id_dt_project: pid,
            id_dt_section: destSectionId ?? null,
            rank: { lt: bottom.rank ?? undefined }, // atas = rank lebih kecil
          },
          orderBy: { rank: 'desc' }, // yang paling dekat di atas
          select: { rank: true },
        });

        return this.rankBetween(prevAbove?.rank ?? null, bottom.rank ?? null);
      }

      // ✅ Tanpa neighbors → append PALING BAWAH
      const max = await this.prismaService.dT_TASK.findFirst({
        where: { id_dt_project: pid, id_dt_section: destSectionId ?? null },
        orderBy: { rank: 'desc' }, // terbesar = paling bawah (ASC)
        select: { rank: true },
      });
      return this.rankAfter(max?.rank ?? null);
    };

    const newRank = await computeNewRank();

    // 6) No-op guard kalau ternyata tidak berubah
    const sameSection = (task.id_dt_section ?? null) === (destSectionId ?? null);
    if (sameSection && task.rank === newRank) {
      const current = await this.prismaService.dT_TASK.findUnique({ where: { id: tid } });
      if (!current) throw new NotFoundException(`Task ${tid} not found`);
      return current;
    }

    // 7) Update
    return this.prismaService.dT_TASK.update({
      where: { id: tid },
      data: {
        id_dt_section: destSectionId ?? null,
        rank: newRank,
      },
    });
  }

  private isOwnerRole(role: EProjectRole | string): boolean {
    return role === (EProjectRole.OWNER as string) || role === 'OWNER';
  }

  private normalizeNik(nik: string | null | undefined): string {
    return (nik ?? '').trim();
  }

  async syncProjectMembers(
    projectId: string,
    members: MemberRequest[],
  ): Promise<{ nik: string; nama: string }[]> {
    // diff di luar tx supaya bisa dipakai kirim email setelah commit
    const toCreate: MemberRequest[] = [];
    const toUpdate: { newData: MemberRequest; oldRole: EProjectRole }[] = [];
    const toDeleteNik: string[] = [];

    // normalisasi payload dulu (terutama nik)
    const normalizedMembers: MemberRequest[] = members.map((m) => ({
      ...m,
      nik: this.normalizeNik(m.nik),
    }));

    const finalMembers = await this.prismaService.$transaction(async (tx) => {
      // 1) Ambil member existing untuk project ini
      const existingRaw = await tx.dT_MEMBER_PROJECT.findMany({
        where: { projectId },
        select: {
          nik: true,
          id_dt_project_role: true,
          user: {
            select: {
              nama: true,
              email: true,
            },
          },
        },
      });

      // Ketatkan tipe + normalisasi nik
      const existing: {
        nik: string;
        id_dt_project_role: EProjectRole;
        user: { nama: string; email: string | null };
      }[] = existingRaw.map((m) => ({
        nik: this.normalizeNik(m.nik),
        id_dt_project_role: m.id_dt_project_role as EProjectRole,
        user: {
          nama: m.user.nama,
          email: m.user.email ?? null,
        },
      }));

      const oldMap = new Map(existing.map((m) => [m.nik, m])); // key = nik (normalized)
      const newMap = new Map(normalizedMembers.map((m) => [m.nik, m])); // key = nik (normalized)

      // 2) Cari CREATE & UPDATE (role berubah)
      for (const m of normalizedMembers) {
        const old = oldMap.get(m.nik);

        if (!old) {
          // member baru
          if (!this.isOwnerRole(m.roleId)) {
            toCreate.push(m);
          }
        } else {
          const oldRole = old.id_dt_project_role;
          const newRole = m.roleId;

          // OWNER tidak boleh diubah lewat endpoint ini
          if (this.isOwnerRole(oldRole) || this.isOwnerRole(newRole)) {
            continue;
          }

          if (oldRole !== newRole) {
            toUpdate.push({
              newData: m,
              oldRole,
            });
          }
        }
      }

      // 3) Cari DELETE → member yang ADA di DB tapi TIDAK ada di payload baru
      for (const old of existing) {
        const isStillInPayload = newMap.has(old.nik);

        if (!isStillInPayload) {
          // kalau gak mau pernah hapus OWNER, bisa skip di sini
          if (this.isOwnerRole(old.id_dt_project_role)) {
            continue;
          }

          toDeleteNik.push(old.nik);
        }
      }

      // 4) DELETE (hapus assignee task & subtask, baru hapus member)
      if (toDeleteNik.length > 0) {
        // 4a. Ambil semua task di project ini
        const tasks = await tx.dT_TASK.findMany({
          where: { id_dt_project: projectId },
          select: {
            id: true,
          },
        });
        const taskIds = tasks.map((t) => t.id);

        // 4b. Ambil semua subtask dari task tersebut
        let subTaskIds: string[] = [];
        if (taskIds.length > 0) {
          const subTasks = await tx.dT_SUB_TASK.findMany({
            where: { id_dt_task: { in: taskIds } },
            select: { id: true },
          });
          subTaskIds = subTasks.map((st) => st.id);
        }

        // 4c. Hapus assignee task untuk nik yang dicabut
        if (taskIds.length > 0) {
          await tx.dT_ASSIGNEE_TASK.deleteMany({
            where: {
              nik: { in: toDeleteNik },
              taskId: { in: taskIds },
            },
          });
        }

        // 4d. Hapus assignee subtask untuk nik yang dicabut
        if (subTaskIds.length > 0) {
          await tx.dT_ASSIGNEE_SUBTASK.deleteMany({
            where: {
              nik: { in: toDeleteNik },
              subTaskId: { in: subTaskIds },
            },
          });
        }

        // 4e. Terakhir, hapus membership project-nya
        await tx.dT_MEMBER_PROJECT.deleteMany({
          where: {
            projectId,
            nik: { in: toDeleteNik },
          },
        });
      }

      // 5) CREATE yang baru
      if (toCreate.length > 0) {
        await tx.dT_MEMBER_PROJECT.createMany({
          data: toCreate.map((m) => ({
            projectId,
            nik: m.nik,
            id_dt_project_role: m.roleId,
          })),
        });
      }

      // 6) UPDATE role yang berubah
      if (toUpdate.length > 0) {
        await Promise.all(
          toUpdate.map((m) =>
            tx.dT_MEMBER_PROJECT.updateMany({
              where: {
                projectId,
                nik: m.newData.nik,
              },
              data: {
                id_dt_project_role: m.newData.roleId,
              },
            }),
          ),
        );
      }

      // 7) Ambil list final buat dikembalikan ke UI
      const finalDbMembers = await tx.dT_MEMBER_PROJECT.findMany({
        where: { projectId },
        select: {
          nik: true,
          user: {
            select: { nama: true },
          },
        },
        orderBy: {
          user: { nama: 'asc' },
        },
      });

      return finalDbMembers.map((m) => ({
        nik: this.normalizeNik(m.nik),
        nama: m.user.nama,
      }));
    });

    // ==== KIRIM EMAIL DI SINI (pakai diff di atas) ====

    if (toCreate.length === 0 && toUpdate.length === 0 && toDeleteNik.length === 0) {
      return finalMembers;
    }

    try {
      const project = await this.prismaService.dT_PROJECT.findUnique({
        where: { id: projectId },
        select: { name: true },
      });
      const projectName = (project?.name as string) ?? 'Project';

      const nikToNotify = Array.from(
        new Set([
          ...toCreate.map((m) => m.nik),
          ...toUpdate.map((x) => x.newData.nik),
          ...toDeleteNik,
        ]),
      );

      const users = await this.prismaService.dT_USER.findMany({
        where: { nik: { in: nikToNotify } },
        select: {
          nik: true,
          nama: true,
          email: true,
        },
      });
      const userMap = new Map(users.map((u) => [this.normalizeNik(u.nik), u]));

      // 1) NEW MEMBERS → "diundang / bergabung"
      for (const m of toCreate) {
        const u = userMap.get(this.normalizeNik(m.nik));
        if (!u?.email) continue;

        await this.mailService.sendProjectJoinedEmail({
          to: u.email,
          projectId,
          projectName,
          role: m.roleId as 'OWNER' | 'EDITOR' | 'READ',
        });
      }

      // 2) ROLE CHANGED → "role diubah"
      for (const x of toUpdate) {
        const u = userMap.get(this.normalizeNik(x.newData.nik));
        if (!u?.email) continue;

        await this.mailService.sendProjectRoleChangedEmail({
          to: u.email,
          projectId,
          projectName,
          oldRole: x.oldRole,
          newRole: x.newData.roleId as 'OWNER' | 'EDITOR' | 'READ',
        });
      }

      // 3) REMOVED → "akses dicabut"
      for (const nik of toDeleteNik) {
        const u = userMap.get(this.normalizeNik(nik));
        if (!u?.email) continue;

        await this.mailService.sendProjectAccessRevokedEmail({
          to: u.email,
          projectId,
          projectName,
        });
      }
    } catch (e) {
      console.warn('Failed sending project member emails:', e);
    }

    return finalMembers;
  }

  // =========================================================
  // 🔹 Sub TASK MANAGEMENT
  // =========================================================

  async addSubTask(taskId: string, data: AddSubTaskRequest): Promise<DT_SUB_TASK> {
    const task = await this.prismaService.dT_TASK.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const max = await this.prismaService.dT_SUB_TASK.findFirst({
      where: { id_dt_task: taskId },
      orderBy: { rank: 'desc' }, // ambil terbesar
      select: { rank: true },
    });
    const newRank = this.rankAfter(max?.rank ?? null);

    return this.prismaService.dT_SUB_TASK.create({
      data: {
        name: data.name,
        dueDate: data.dueDate ?? null,
        id_dt_task: taskId,
        rank: newRank,
      },
    });
  }

  async updateSubTask(subtaskId: string, data: UpdateSubTaskRequest): Promise<DT_SUB_TASK> {
    const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: subtaskId },
    });
    if (!subtask) throw new NotFoundException(`Subtask ${subtaskId} not found`);

    return this.prismaService.dT_SUB_TASK.update({
      where: { id: subtaskId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
  }

  async syncSubTaskAssignees(
    taskId: string,
    subTaskId: string,
    dto: SyncSubTaskAssigneeRequest,
  ): Promise<string> {
    const normalizeNik = (v: string | number | null | undefined): string =>
      v == null ? '' : String(v).trim();

    const nextNikList = Array.from(
      new Set((dto.assignees ?? []).map((a) => normalizeNik(a.nik)).filter((n) => n.length > 0)),
    );

    // 1) Validasi task assignees
    const taskAssignees = await this.prismaService.dT_ASSIGNEE_TASK.findMany({
      where: { taskId },
      select: { nik: true },
    });

    const allowedNiks = new Set(taskAssignees.map((a) => normalizeNik(a.nik)));
    const invalid = nextNikList.filter((nik) => !allowedNiks.has(nik));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `User berikut bukan bagian dari Task ini: ${invalid.join(', ')}`,
      );
    }

    // 2) TRANSAKSI dengan row lock
    const result = await this.prismaService.$transaction(async (tx) => {
      // ✅ Lock subtask row untuk mencegah concurrent update
      await tx.$executeRaw`
          SELECT id FROM dbo.DT_SUB_TASK WITH (UPDLOCK, ROWLOCK)
          WHERE id = ${subTaskId}
      `;

      // 3) Baca existing assignees DALAM transaksi (setelah lock)
      const existing = await tx.dT_ASSIGNEE_SUBTASK.findMany({
        where: { subTaskId },
        select: { nik: true },
      });

      const existingSet = new Set(existing.map((e) => normalizeNik(e.nik)));
      const nextSet = new Set(nextNikList);

      const toDelete = [...existingSet].filter((nik) => !nextSet.has(nik));
      const toInsert = [...nextSet].filter((nik) => !existingSet.has(nik));

      // Early return di dalam transaksi
      if (!toDelete.length && !toInsert.length) {
        return { toInsert: 0, toDelete: 0 };
      }

      // 4) Delete & Insert
      if (toDelete.length) {
        await tx.dT_ASSIGNEE_SUBTASK.deleteMany({
          where: {
            subTaskId,
            nik: { in: toDelete },
          },
        });
      }

      if (toInsert.length) {
        await tx.dT_ASSIGNEE_SUBTASK.createMany({
          data: toInsert.map((nik) => ({
            subTaskId,
            nik,
          })),
        });
      }

      return { toInsert: toInsert.length, toDelete: toDelete.length };
    });

    if (result.toInsert === 0 && result.toDelete === 0) {
      return 'Tidak ada perubahan assignee sub task.';
    }

    return `Berhasil sinkron assignee sub task. Tambah: ${result.toInsert}, hapus: ${result.toDelete}.`;
  }

  async deleteSubTask(subtaskId: string): Promise<{ message: string }> {
    const exist = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: subtaskId },
    });
    if (!exist) throw new NotFoundException(`Subtask ${subtaskId} not found`);

    await this.prismaService.dT_SUB_TASK.delete({ where: { id: subtaskId } });
    return { message: 'Subtask deleted successfully' };
  }

  async moveSubTask(
    subtaskId: string,
    body: { beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_SUB_TASK> {
    const sid = this.normalizeGuid(subtaskId);
    if (!sid) throw new BadRequestException('Invalid subtaskId');

    const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: sid },
      select: { id: true, id_dt_task: true, rank: true },
    });
    if (!subtask) throw new NotFoundException(`Subtask ${sid} not found`);
    const tid = subtask.id_dt_task;
    if (!tid) throw new BadRequestException(`Subtask ${sid} has no parent task`);

    const beforeIdRaw = this.normalizeGuid(body.beforeId ?? null);
    const afterIdRaw = this.normalizeGuid(body.afterId ?? null);
    const beforeId = beforeIdRaw === sid ? null : beforeIdRaw;
    const afterId = afterIdRaw === sid ? null : afterIdRaw;

    const fetchNeighbor = async (nid: string | null) => {
      if (!nid) return null;
      const n = await this.prismaService.dT_SUB_TASK.findUnique({
        where: { id: nid },
        select: { id: true, id_dt_task: true, rank: true },
      });
      return !n || n.id_dt_task !== tid ? null : n;
    };

    const [before, after] = await Promise.all([fetchNeighbor(beforeId), fetchNeighbor(afterId)]);

    const MAX_RETRY = 3;
    const computeNewRank = async (): Promise<string> => {
      // FE: afterId = neighbor ATAS, beforeId = neighbor BAWAH
      const top = after;
      const bottom = before;

      // ✅ Both neighbors (top = di atas, bottom = di bawah)
      if (top && bottom) {
        return this.rankBetween(top.rank ?? null, bottom.rank ?? null);
      }

      // ✅ Only top → taruh TEPAT di bawah 'top'
      if (top && !bottom) {
        const nextBelow = await this.prismaService.dT_SUB_TASK.findFirst({
          where: { id_dt_task: tid, rank: { gt: top.rank ?? undefined } }, // bawah = lebih besar
          orderBy: { rank: 'asc' }, // paling dekat di bawah
          select: { rank: true },
        });
        return this.rankBetween(top.rank ?? null, nextBelow?.rank ?? null);
      }

      // ✅ Only bottom → taruh TEPAT di atas 'bottom'
      if (!top && bottom) {
        const prevAbove = await this.prismaService.dT_SUB_TASK.findFirst({
          where: { id_dt_task: tid, rank: { lt: bottom.rank ?? undefined } }, // atas = lebih kecil
          orderBy: { rank: 'desc' }, // paling dekat di atas
          select: { rank: true },
        });
        return this.rankBetween(prevAbove?.rank ?? null, bottom.rank ?? null);
      }

      // ✅ Tanpa neighbors → append PALING BAWAH
      const max = await this.prismaService.dT_SUB_TASK.findFirst({
        where: { id_dt_task: tid },
        orderBy: { rank: 'desc' }, // terbesar = paling bawah (ASC)
        select: { rank: true },
      });
      return this.rankAfter(max?.rank ?? null);
    };

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const newRank = await computeNewRank();

        if (subtask.rank === newRank) {
          const current = await this.prismaService.dT_SUB_TASK.findUnique({ where: { id: sid } });
          if (!current) throw new NotFoundException(`Subtask ${sid} not found after lookup`);
          return current;
        }

        return await this.prismaService.dT_SUB_TASK.update({
          where: { id: sid },
          data: { rank: newRank },
        });
      } catch (e: any) {
        if (this.isUniqueConstraintError(e) && attempt < MAX_RETRY) continue;
        throw e;
      }
    }
    throw new BadRequestException('Unable to move subtask');
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
    assignees: { user: { nik: string; nama: string } }[];
    creator: { nama: string } | null;
    subTask?: {
      id: string;
      name: string;
      dueDate: Date | null;
      status: boolean;
      assignees: { user: { nik: string; nama: string } }[];
    }[];
  }): TaskNonSection {
    return {
      id: t.id,
      name: t.name,
      desc: t.desc,
      dueDate: t.dueDate,
      status: Boolean(t.status),

      assignees: (t.assignees ?? []).map((a) => ({
        nik: a.user.nik,
        nama: a.user.nama,
      })),

      creator: { nama: t.creator?.nama ?? '' },

      subTask:
        t.subTask?.map<SubTask>((st) => ({
          id: st.id,
          name: st.name,
          dueDate: st.dueDate,
          status: st.status,
          assignees:
            st.assignees?.map((sa) => ({
              nik: sa.user.nik,
              nama: sa.user.nama,
            })) ?? [],
        })) ?? [],
    };
  }

  private get taskSelect() {
    return {
      id: true,
      name: true,
      desc: true,
      dueDate: true,
      status: true,

      assignees: {
        select: {
          user: {
            select: {
              nik: true,
              nama: true,
            },
          },
        },
      },

      attachments: {
        select: {
          id: true,
          taskId: true,
          mimeType: true,
          filename: true,
          url: true,
        },
      },

      creator: {
        select: {
          nama: true,
        },
      },
      subTask: {
        select: {
          id: true,
          name: true,
          dueDate: true,
          status: true,
          assignees: {
            select: {
              user: {
                select: {
                  nik: true,
                  nama: true,
                },
              },
            },
          },
        },
        orderBy: { rank: 'asc' as const },
      },
    } as const;
  }

  async findTasksAndSections(projectId: string): Promise<TaskSectionResponse> {
    const [unlocatedTasks, sections] = await Promise.all([
      this.prismaService.dT_TASK.findMany({
        where: { id_dt_project: projectId, id_dt_section: null },
        select: this.taskSelect,
        orderBy: [{ rank: 'asc' }],
      }),
      this.prismaService.dT_SECTION.findMany({
        where: { id_dt_project: projectId },
        select: {
          id: true,
          name: true,
          rank: true,
          tasks: {
            select: this.taskSelect,
            orderBy: [{ rank: 'asc' }],
          },
        },
        orderBy: { rank: 'asc' },
      }),
    ]);
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

  async removeSection({ projectId, sectionId, includeTask }: RemoveSectionArgs): Promise<string> {
    await this.prismaService.$transaction(async (tx) => {
      const sec = await tx.dT_SECTION.findFirst({
        where: { id: sectionId, id_dt_project: projectId },
        select: { id: true },
      });

      if (!sec) {
        throw new Error('Section tidak ditemukan untuk project tersebut');
      }

      if (includeTask) {
        await tx.dT_TASK.deleteMany({
          where: { id_dt_section: sectionId, id_dt_project: projectId },
        });
      } else {
        await tx.dT_TASK.updateMany({
          where: { id_dt_section: sectionId, id_dt_project: projectId },
          data: { id_dt_section: null },
        });
      }
      await tx.dT_SECTION.delete({
        where: { id: sectionId },
      });
    });

    return 'Delete Section Successfully';
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

    // FE: afterId = atas, beforeId = bawah → sama seperti task
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
  // helper kecil untuk normalisasi members dari FE → MemberRequest[]
  private normalizeMembersFromCreate(
    members: CreateProjectRequest['members'],
    creatorNik: string,
  ): MemberRequest[] {
    if (!members?.length) return [];

    return members
      .map<MemberRequest>((m) => {
        const nik = this.normalizeNik(m.nik);
        const roleId = m.roleId ?? EProjectRole.EDITOR;
        return { nik, roleId };
      })
      .filter(
        (m) =>
          !!m.nik &&
          m.nik !== creatorNik && // jangan masukin OWNER (creator) lagi
          m.roleId !== EProjectRole.OWNER, // OWNER dikelola server
      );
  }

  // =========================
  // 🔢 RANKING UTIL
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

  private rankFirst(): string {
    return '0000000000000001';
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

  private isUniqueConstraintError(err: unknown): boolean {
    return Boolean(
      typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002',
    );
  }

  private async addMembersToProject(
    projectId: string,
    members: Array<{ nik: string; roleId?: string | EProjectRole | null }>,
    tx: Prisma.TransactionClient = this.prismaService,
  ): Promise<void> {
    const roleMap = new Map<string, EProjectRole>([
      ['OWNER', EProjectRole.OWNER],
      ['EDITOR', EProjectRole.EDITOR],
      ['READ', EProjectRole.READ],
    ]);

    const nikToRole = new Map<string, EProjectRole>();
    for (const m of members ?? []) {
      const nik = m?.nik?.trim();
      if (!nik) continue;
      const key = String(m?.roleId ?? 'READ').toUpperCase();
      nikToRole.set(nik, roleMap.get(key) ?? EProjectRole.READ);
    }
    if (!nikToRole.size) return;

    const nikList = [...nikToRole.keys()];

    const existing = await tx.dT_MEMBER_PROJECT.findMany({
      where: { projectId, nik: { in: nikList } },
      select: { nik: true },
    });
    const existingNik = new Set(existing.map((e) => e.nik));

    const rows = nikList
      .filter((nik) => !existingNik.has(nik))
      .map((nik) => ({
        projectId,
        nik,
        id_dt_project_role: nikToRole.get(nik)!,
      }));
    if (!rows.length) return;

    await tx.dT_MEMBER_PROJECT.createMany({
      data: rows,
    });
  }
}
