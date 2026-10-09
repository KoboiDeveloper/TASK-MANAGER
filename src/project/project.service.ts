import * as crypto from 'crypto';
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
import {
  DT_PROJECT,
  DT_SECTION,
  DT_SUB_TASK,
  DT_TAG,
  DT_TASK,
  DT_VIEWS,
  Prisma,
} from '@prisma/client';
import {
  ProjectDetail,
  ProjectMemberFlat,
  SubTask,
  TaskNonSection,
  TaskSectionResponse,
  AttachmentTask,
  ownTaskResponse,
  ActivityResponse,
} from './dto/response';
import { UserService } from '../user/user.service';
import { MailService } from '../utils/mail/mail.service';
import { EProjectRole } from '../constant/EProjectRole';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { ProjectGateway } from './project.gateway';
import { CronjobService } from '../utils/cronjob/cronjob.service';
import { PushService } from '../notifications/push.service';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
    private readonly storageService: DropboxStorageService,
    private readonly projectGateway: ProjectGateway,
    private readonly cronjobService: CronjobService,
    private readonly pushService: PushService,
  ) {}

  // =========================================================
  // 🔹 PROJECT MANAGEMENT
  // =========================================================

  async ownProjects(nik: string, roleId?: string): Promise<DT_PROJECT[]> {
    let projects: DT_PROJECT[];
    if (roleId === 'SUPER') {
      projects = await this.prismaService.dT_PROJECT.findMany({
        orderBy: { name: 'asc' },
      });
    } else {
      projects = await this.prismaService.dT_PROJECT.findMany({
        where: {
          members: {
            some: { nik: { equals: nik } },
          },
        },
        orderBy: { name: 'asc' },
      });
    }
    return projects.map((p) => ({
      ...p,
      id: p.shortId || p.id,
    }));
  }

  async findOne(projectId: string): Promise<ProjectDetail> {
    return this.ensureProjectExists(projectId);
  }

  async create(creatorNik: string, data: CreateProjectRequest): Promise<string> {
    const {
      name,
      desc = null,
      members = [],
      icon = null,
      views = null,
      isPrivate = false,
      defaultPermission = 'EDITOR',
      sections = [],
    } = data;
    const color = data.color || this.generateColorFromString(name);

    // 1) Buat project + OWNER + sections dalam satu transaksi
    const projectId = await this.prismaService.$transaction(async (tx) => {
      const project = await tx.dT_PROJECT.create({
        data: {
          name,
          color,
          icon,
          isPrivate,
          defaultPermission,
          desc,
          createdBy: creatorNik,
          shortId: this.generateShortId(7),
        },
      });

      // Default view if none provided:
      let viewsList: Array<{ name: string; type: string }> = [];
      if (views) {
        if (typeof views === 'string') {
          try {
            const parsed = JSON.parse(views);
            if (Array.isArray(parsed)) {
              viewsList = parsed.map((v) => {
                const type = typeof v === 'string' ? v.toLowerCase() : v.type || 'list';
                const name =
                  typeof v === 'string'
                    ? type.charAt(0).toUpperCase() + type.slice(1)
                    : v.name || 'List';
                return { name, type };
              });
            }
          } catch {
            // fallback
          }
        }
      }
      if (viewsList.length === 0) {
        viewsList = [{ name: 'List', type: 'list' }];
      }

      for (const v of viewsList) {
        await tx.dT_VIEWS.create({
          data: {
            projectId: project.id,
            name: v.name,
            type: v.type,
          },
        });
      }

      // creator selalu jadi OWNER
      await tx.dT_MEMBER_PROJECT.create({
        data: {
          projectId: project.id,
          nik: creatorNik,
          id_dt_project_role: EProjectRole.OWNER,
        },
      });

      // Jika ada sections dari create project (workflow), buat sections
      if (Array.isArray(sections) && sections.length > 0) {
        let currentRank = '8000000000000000';
        for (const sec of sections) {
          const secName = typeof sec === 'string' ? sec : sec?.name;
          const secCategory =
            typeof sec === 'object' && (sec as any)?.category
              ? (sec as any).category
              : /complete|done|selesai|closed/i.test(secName || '')
                ? 'done'
                : 'active';
          if (secName && secName.trim()) {
            await tx.dT_SECTION.create({
              data: {
                id_dt_project: project.id,
                name: secName.trim(),
                rank: currentRank,
                category: secCategory,
              },
            });
            currentRank = this.rankAfter(currentRank);
          }
        }
      }

      await tx.lOG_ACTIVITY.create({
        data: {
          projectId: project.id,
          nik: creatorNik,
          action: 'PROJECT_CREATED',
          details: JSON.stringify({ projectName: project.name }),
        },
      });

      // anggota lain TIDAK dibuat di sini, supaya semua logika diff dipegang syncProjectMembers
      return { id: project.id, shortId: project.shortId };
    });

    // 2) Normalisasi members dari FE (tanpa OWNER/creator)
    const normalizedMembers = this.normalizeMembersFromCreate(members, creatorNik);

    // 3) Kalau ada anggota lain → pakai service diff global (sekalian kirim email)
    if (normalizedMembers.length > 0) {
      try {
        await this.syncProjectMembers(projectId.id, normalizedMembers);
      } catch (err) {
        // Jangan jatuhkan create project hanya karena sync/email gagal
        this.logger.warn(`syncProjectMembers after create failed: ${String(err)}`);
      }
    }

    return projectId.shortId || projectId.id;
  }

  async updateProjectById(id: string, data: UpdateProjectRequest, nik?: string): Promise<string> {
    const pid = (await this.resolveProjectId(id)) || id;
    const { name, desc, isArchive, members, color, icon, isPrivate, defaultPermission } = data;

    const prevProject =
      isArchive === true
        ? await this.prismaService.dT_PROJECT.findUnique({
            where: { id: pid },
            select: {
              isArchive: true,
              name: true,
              shortId: true,
              id: true,
              members: { select: { nik: true } },
            },
          })
        : null;

    try {
      // 1) Update field project-nya (kalau ada yg dikirim)
      if (
        name !== undefined ||
        desc !== undefined ||
        isArchive !== undefined ||
        color !== undefined ||
        icon !== undefined ||
        isPrivate !== undefined ||
        defaultPermission !== undefined
      ) {
        await this.prismaService.dT_PROJECT.update({
          where: { id: pid },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(desc !== undefined ? { desc } : {}),
            ...(isArchive !== undefined ? { isArchive } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(icon !== undefined ? { icon } : {}),
            ...(isPrivate !== undefined ? { isPrivate } : {}),
            ...(defaultPermission !== undefined ? { defaultPermission } : {}),
          },
        });

        if (nik) {
          const changes: Record<string, any> = {};
          if (name !== undefined) changes.name = name;
          if (desc !== undefined) changes.desc = desc;
          if (isArchive !== undefined) changes.isArchive = isArchive;
          await this.logActivity({
            projectId: pid,
            nik,
            action: 'PROJECT_UPDATED',
            details: changes,
          });
        }
      }

      // 2) Sync members kalau dikirim dari FE
      if (Array.isArray(members)) {
        await this.syncProjectMembers(pid, members);
      }

      if (prevProject && !prevProject.isArchive && isArchive === true) {
        const effectiveProjectId = prevProject.shortId || prevProject.id;
        this.pushService.notifyUsers(
          prevProject.members.map((m) => m.nik),
          {
            type: 'project.archived',
            title: 'Project diarsipkan',
            body: prevProject.name,
            url: `/dashboard/project/${effectiveProjectId}`,
          },
        );
      }

      return `Project with ${id} successfully updated`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update project';
      throw new ConflictException(message);
    }
  }

  async deleteProjectById(id: string): Promise<string> {
    const pid = (await this.resolveProjectId(id)) || id;
    try {
      await this.prismaService.$transaction(async (tx) => {
        await tx.dT_ASSIGNEE_SUBTASK.deleteMany({
          where: {
            subTask: {
              task: { id_dt_project: pid },
            },
          },
        });

        await tx.dT_ASSIGNEE_TASK.deleteMany({
          where: {
            task: { id_dt_project: pid },
          },
        });

        await tx.dT_SUB_TASK.deleteMany({
          where: { task: { id_dt_project: pid } },
        });

        await tx.dT_TASK.deleteMany({
          where: { id_dt_project: pid },
        });

        await tx.dT_MEMBER_PROJECT.deleteMany({
          where: { projectId: pid },
        });

        await tx.dT_PROJECT.delete({
          where: { id: pid },
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
    const { name, desc, section, id_dt_view } = data;

    const pid =
      (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId) || projectId;

    await this.ensureProjectExists(pid);

    let viewId = id_dt_view
      ? (await this.resolveViewId(id_dt_view, pid)) || this.normalizeGuid(id_dt_view)
      : null;

    if (!viewId) {
      const defaultView = await this.prismaService.dT_VIEWS.findFirst({
        where: { projectId: pid },
        select: { id: true },
      });
      viewId = defaultView?.id ?? null;
    }

    const sid = section && section !== 'unlocated' ? this.normalizeGuid(section) : null;

    // Cari task dengan rank paling BESAR (paling bawah)
    const last = await this.prismaService.dT_TASK.findFirst({
      where: {
        id_dt_project: pid,
        id_dt_section: sid ?? null,
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
      `createTask(project=${pid}, section=${sid ?? 'NULL'}) lastRank=${
        last?.rank ?? 'NULL'
      } newRank=${newRank}`,
    );

    const task = await this.prismaService.dT_TASK.create({
      data: {
        name,
        desc,
        id_dt_project: pid,
        id_dt_section: sid ?? null,
        id_dt_view: viewId,
        createdBy: nik,
        rank: newRank,
        shortId: this.generateShortId(7),
      },
    });

    await this.logActivity({
      projectId: pid,
      taskid: task.id,
      nik,
      action: 'TASK_CREATED',
      details: { taskName: task.name },
    });

    this.projectGateway.broadcastToProject(pid, 'task:created', {
      taskId: task.shortId || task.id,
      id: task.id,
      shortId: task.shortId,
      name: task.name,
      desc: task.desc,
      sectionId: task.id_dt_section,
      rank: task.rank,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      status: task.status,
      id_dt_view: task.id_dt_view,
    });

    return task.shortId || task.id;
  }

  async taskOwn(nik: string): Promise<ownTaskResponse[]> {
    // Dashboard "My tasks": assigned to user AND not completed
    const tasks = await this.prismaService.dT_TASK.findMany({
      where: {
        assignees: { some: { nik } },
        status: false,
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 300,
      select: {
        id: true,
        shortId: true,
        name: true,
        status: true,
        dueDate: true,
        createdBy: true,
        assignees: { select: { nik: true } },
        project: {
          select: {
            id: true,
            shortId: true,
            name: true,
            color: true,
            createdBy: true,
            members: { select: { nik: true } },
          },
        },
      },
    });
    return tasks.map((t) => {
      const memberNiks = Array.from(
        new Set(
          [t.project.createdBy, ...(t.project.members ?? []).map((m) => m.nik)].filter(
            (n): n is string => Boolean(n),
          ),
        ),
      );
      return {
        // keep shortId-first for dashboard links; expose guid for chat
        id: t.shortId || t.id,
        guid: t.id,
        shortId: t.shortId,
        name: t.name,
        status: t.status,
        dueDate: t.dueDate,
        createdBy: t.createdBy,
        assignees: (t.assignees ?? []).map((a) => ({ nik: a.nik })),
        project: {
          id: t.project.shortId || t.project.id,
          guid: t.project.id,
          shortId: t.project.shortId,
          name: t.project.name,
          color: t.project.color,
          memberNiks,
        },
      };
    });
  }

  async updateTask(taskId: string, dto: UpdateTaskRequest, nik?: string): Promise<DT_TASK> {
    const tid = (await this.resolveTaskId(taskId)) || taskId;
    // pastikan task ada
    const exists = await this.prismaService.dT_TASK.findUnique({
      where: { id: tid },
      select: {
        id: true,
        shortId: true,
        name: true,
        status: true,
        dueDate: true,
        id_dt_project: true,
        createdBy: true,
        project: { select: { shortId: true } },
      },
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
      patch.doneDate = dto.status ? new Date() : null;
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

    if (dto.customFields !== undefined) {
      patch.customFields = dto.customFields;
    }

    const hasScalarUpdate = Object.keys(patch).length > 0;
    const assigneesProvided = dto.assignees !== undefined;

    if (!hasScalarUpdate && !assigneesProvided) {
      throw new BadRequestException('No valid fields to update');
    }

    let newlyAssignedNiks: string[] = [];
    let removedAssignedNiks: string[] = [];
    if (assigneesProvided) {
      const existingAssignees = await this.prismaService.dT_ASSIGNEE_TASK.findMany({
        where: { taskId: tid },
        select: { nik: true },
      });
      const existingNikSet = new Set(existingAssignees.map((a) => this.normalizeNik(a.nik)));
      const nextNikSet = new Set(
        (dto.assignees || []).map((a) => this.normalizeNik(a.nik)).filter(Boolean),
      );
      newlyAssignedNiks = [...nextNikSet].filter((n) => !existingNikSet.has(n));
      removedAssignedNiks = [...existingNikSet].filter((n) => !nextNikSet.has(n));
    }

    // transaksi: update scalar + reset assignees bila dikirim
    const updated = await this.prismaService.$transaction(async (tx) => {
      if (hasScalarUpdate) {
        await tx.dT_TASK.update({
          where: { id: tid },
          data: patch,
          select: { id: true },
        });
      }

      if (assigneesProvided) {
        await tx.dT_ASSIGNEE_TASK.deleteMany({ where: { taskId: tid } });
        if (dto.assignees && dto.assignees.length > 0) {
          await tx.dT_ASSIGNEE_TASK.createMany({
            data: dto.assignees.map((a) => ({
              taskId: tid,
              nik: a.nik,
            })),
          });
        }
      }

      return tx.dT_TASK.findUnique({
        where: { id: tid },
        include: {
          section: true,
          assignees: {
            include: {
              user: {
                select: { nik: true, nama: true, photo: true },
              },
            },
          },
          tags: true,
        },
      });
    });

    if (!updated) throw new NotFoundException(`Task ${taskId} not found after update`);

    if (updated.id_dt_project) {
      const broadcastAssignees = updated.assignees
        ? updated.assignees.map((a: any) => ({
            nik: a.nik,
            nama: a.user?.nama || a.nik,
            photo: a.user?.photo || null,
          }))
        : undefined;

      this.projectGateway.broadcastToProject(updated.id_dt_project, 'task:updated', {
        taskId: updated.shortId || updated.id,
        id: updated.id,
        shortId: updated.shortId,
        name: updated.name,
        desc: updated.desc,
        status: updated.status,
        dueDate: updated.dueDate,
        id_dt_section: updated.id_dt_section,
        customFields: updated.customFields,
        assignees: broadcastAssignees,
      });

      const actionUser = nik || updated.createdBy;
      if (dto.status !== undefined && dto.status !== exists.status) {
        await this.logActivity({
          projectId: updated.id_dt_project,
          taskid: updated.id,
          nik: actionUser,
          action: dto.status ? 'TASK_COMPLETED' : 'TASK_UNCOMPLETED',
          details: { taskName: updated.name },
        });
      } else if (dto.name !== undefined && dto.name.trim() !== exists.name) {
        await this.logActivity({
          projectId: updated.id_dt_project,
          taskid: updated.id,
          nik: actionUser,
          action: 'TASK_RENAMED',
          details: { oldName: exists.name, newName: updated.name },
        });
      } else if (dto.dueDate !== undefined) {
        await this.logActivity({
          projectId: updated.id_dt_project,
          taskid: updated.id,
          nik: actionUser,
          action: 'TASK_DUE_DATE_CHANGED',
          details: { taskName: updated.name, dueDate: dto.dueDate },
        });
      }

      const effectiveProjectId =
        exists.project?.shortId || updated.id_dt_project;
      const taskLinkId = updated.shortId || updated.id;
      const taskUrl = `/dashboard/project/${effectiveProjectId}?task=${taskLinkId}`;

      // 1) Email jika ada user baru yang ditugaskan ke task ini
      if (newlyAssignedNiks.length > 0) {
        const targetNiks = newlyAssignedNiks.filter((n) => n !== actionUser);
        if (targetNiks.length > 0) {
          this.sendTaskAssignedEmailsAsync(
            targetNiks,
            updated.id_dt_project,
            taskLinkId,
            updated.name,
            actionUser,
            updated.dueDate,
            false,
          ).catch((err) => this.logger.warn(`Failed sending task assigned emails: ${err}`));
        }
      }

      if (removedAssignedNiks.length > 0) {
        this.pushService.notifyUsers(
          removedAssignedNiks,
          {
            type: 'task.removed',
            title: 'Dilepas dari task',
            body: updated.name,
            url: taskUrl,
          },
          actionUser,
        );
      }

      if (dto.dueDate !== undefined) {
        const prevDue = exists.dueDate?.getTime() ?? null;
        const nextDue = updated.dueDate?.getTime() ?? null;
        if (prevDue !== nextDue) {
          const assigneeNiks = (updated.assignees ?? []).map((a) => a.nik);
          this.pushService.notifyUsers(
            assigneeNiks,
            {
              type: 'task.due_date_changed',
              title: 'Tenggat diubah',
              body: updated.name,
              url: taskUrl,
            },
            actionUser,
          );
        }
      }

      if (dto.status === true && exists.status === false) {
        const completedNiks = Array.from(
          new Set([
            ...(updated.assignees ?? []).map((a) => a.nik),
            exists.createdBy,
          ].filter(Boolean)),
        );
        this.pushService.notifyUsers(
          completedNiks,
          {
            type: 'task.completed',
            title: 'Task selesai',
            body: updated.name,
            url: taskUrl,
          },
          actionUser,
        );

        this.checkAndSendProjectCompletedEmailAsync(updated.id_dt_project).catch((err) =>
          this.logger.warn(`Failed checking project completion email: ${err}`),
        );
      }
    }

    return { ...updated, id: updated.shortId || updated.id };
  }

  async deleteTaskId(taskId: string, nik?: string): Promise<string> {
    const tid = (await this.resolveTaskId(taskId)) || this.normalizeGuid(taskId);
    if (!tid) {
      return `Task ${taskId} already deleted`;
    }
    const existingTask = await this.prismaService.dT_TASK.findUnique({
      where: { id: tid },
      select: {
        id: true,
        shortId: true,
        id_dt_project: true,
        name: true,
        createdBy: true,
        project: { select: { shortId: true } },
        assignees: { select: { nik: true } },
      },
    });

    try {
      // 1) Ambil semua attachment yang terkait task ini (sebelum transaksi)
      const attachments = await this.prismaService.dT_TASK_ATTACHMENT.findMany({
        where: { taskId: tid },
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
              id_dt_task: tid,
            },
          },
        });

        await tx.dT_SUB_TASK.deleteMany({
          where: { id_dt_task: tid },
        });

        await tx.dT_ASSIGNEE_TASK.deleteMany({
          where: {
            taskId: tid,
          },
        });

        await tx.dT_TASK_ATTACHMENT.deleteMany({
          where: {
            taskId: tid,
          },
        });

        await tx.dT_TAG.deleteMany({
          where: {
            id_dt_task: tid,
          },
        });

        await tx.lOG_ACTIVITY.updateMany({
          where: {
            taskid: tid,
          },
          data: {
            taskid: null,
          },
        });

        const deletedTask = await tx.dT_TASK.delete({
          where: { id: tid },
        });

        if (!deletedTask) {
          throw new Prisma.PrismaClientKnownRequestError('Task not found', {
            code: 'P2025',
            clientVersion: 'unknown',
          });
        }
      });

      // 3) Hapus file di Dropbox di luar transaksi
      await Promise.all(
        attachments.map(async (att) => {
          if (!att.url) return;
          try {
            await this.storageService.deleteFile(att.url);
          } catch (err) {
            console.error('Failed to delete blob for attachment', att.id, att.url, err);
          }
        }),
      );

      if (existingTask?.id_dt_project) {
        this.projectGateway.broadcastToProject(existingTask.id_dt_project, 'task:deleted', {
          taskId,
          resolvedTaskId: tid,
        });

        await this.logActivity({
          projectId: existingTask.id_dt_project,
          nik: nik || existingTask.createdBy,
          action: 'TASK_DELETED',
          details: { taskName: existingTask.name },
        });

        const effectiveProjectId =
          existingTask.project?.shortId || existingTask.id_dt_project;
        const taskLinkId = existingTask.shortId || existingTask.id;
        this.pushService.notifyUsers(
          (existingTask.assignees ?? []).map((a) => a.nik),
          {
            type: 'task.removed',
            title: 'Task dihapus',
            body: existingTask.name,
            url: `/dashboard/project/${effectiveProjectId}?task=${taskLinkId}`,
          },
          nik,
        );
      }

      return `Task ${taskId} deleted`;
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException(`Task ${taskId} not found`);
      }
      this.logger.error(
        `Failed to delete task ${taskId} (resolved: ${tid})`,
        e instanceof Error ? e.stack : String(e),
      );
      throw new ConflictException(e instanceof Error ? e.message : 'Failed to delete task');
    }
  }

  async AddTaskAttachments(
    taskId: string,
    attachments: Express.Multer.File[],
    nik?: string,
  ): Promise<string> {
    const tid = (await this.resolveTaskId(taskId)) || this.normalizeGuid(taskId);
    if (!tid) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    // validasi basic
    if (!attachments || attachments.length === 0) {
      throw new BadRequestException('No attachments uploaded');
    }

    // pastikan task ada
    const task = await this.prismaService.dT_TASK.findUnique({
      where: { id: tid },
      select: {
        id: true,
        shortId: true,
        name: true,
        id_dt_project: true,
        createdBy: true,
        project: { select: { shortId: true } },
        assignees: { select: { nik: true } },
      },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    // 1) Upload ke Dropbox dulu (di luar transaksi DB)
    const uploadedAttachments = await Promise.all(
      attachments.map(async (file) => {
        const originalName = file.originalname || 'file';
        const safeFilename = originalName.length > 20 ? originalName.slice(0, 20) : originalName; // schema: VarChar(20)

        const key = `tasks/${tid}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}-${originalName}`;

        const uploaded = await this.storageService.uploadFile(key, file.buffer, file.mimetype);

        return {
          taskId: tid,
          url: uploaded.url,
          filename: safeFilename,
          mimeType: file.mimetype,
          bytes: file.size,
        };
      }),
    );

    await this.prismaService.dT_TASK_ATTACHMENT.createMany({
      data: uploadedAttachments,
    });

    if (task.id_dt_project) {
      await this.logActivity({
        projectId: task.id_dt_project,
        taskid: tid,
        nik: nik || task.createdBy,
        action: 'ATTACHMENT_UPLOADED',
        details: {
          taskName: task.name,
          count: attachments.length,
          filenames: attachments.map((f) => (f.originalname || 'file').slice(0, 50)),
        },
      });

      const effectiveProjectId = task.project?.shortId || task.id_dt_project;
      const taskLinkId = task.shortId || task.id;
      this.pushService.notifyUsers(
        (task.assignees ?? []).map((a) => a.nik),
        {
          type: 'task.attachment',
          title: 'Lampiran baru',
          body: task.name,
          url: `/dashboard/project/${effectiveProjectId}?task=${taskLinkId}`,
        },
        nik,
      );
    }

    return `Uploaded ${uploadedAttachments.length} attachment(s) to task ${taskId}`;
  }

  async getTaskAttachments(taskId: string): Promise<AttachmentTask[]> {
    const tid = (await this.resolveTaskId(taskId)) || this.normalizeGuid(taskId);
    if (!tid) {
      return [];
    }
    return this.prismaService.dT_TASK_ATTACHMENT.findMany({
      where: { taskId: tid },
    });
  }

  async deleteTaskAttachments(
    taskId: string,
    attachmentIds: Array<string | { id: string }>,
  ): Promise<string> {
    const tid = (await this.resolveTaskId(taskId)) || this.normalizeGuid(taskId);
    if (!tid) {
      return `Deleted 0 attachment(s) from task ${taskId}`;
    }

    // 0) Normalisasi: pastikan kita punya string[]
    const ids = attachmentIds.map((v) => (typeof v === 'string' ? v : v.id)).filter(Boolean);

    // 1) Validasi basic
    if (!ids.length) {
      throw new BadRequestException('No attachment ids provided');
    }

    // 2) Pastikan task ada
    const task = await this.prismaService.dT_TASK.findUnique({
      where: { id: tid },
      select: { id: true },
    });

    if (!task) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }

    // 3) Ambil attachment yang match taskId + id
    const attachments = await this.prismaService.dT_TASK_ATTACHMENT.findMany({
      where: {
        id: { in: ids },
        taskId: tid,
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

    // 4) Hapus file dari Dropbox
    await Promise.all(
      attachments.map(async (att) => {
        try {
          await this.storageService.deleteFile(att.url);
        } catch (err) {
          console.error('Failed to delete blob', att.url, err);
        }
      }),
    );

    // 5) Hapus row di DB (bulk)
    await this.prismaService.dT_TASK_ATTACHMENT.deleteMany({
      where: {
        id: { in: ids },
        taskId: tid,
      },
    });

    return `Deleted ${attachments.length} attachment(s) from task ${taskId}`;
  }

  async moveTask(
    projectId: string,
    taskId: string,
    body: { targetSectionId?: string | null; beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_TASK> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const tid = (await this.resolveTaskId(taskId, pid)) || this.normalizeGuid(taskId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!tid) throw new BadRequestException('Invalid taskId');

    const MAX_RETRY = 5;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const result = await this.prismaService.$transaction(async (tx) => {
          // 🔒 Lock project row to serialize task rank moves for this project
          await tx.$executeRaw`
            SELECT id FROM dbo.DT_PROJECT WITH (UPDLOCK, ROWLOCK)
            WHERE id = ${pid}
          `;

          // 1) Task harus ada & milik project
          const task = await tx.dT_TASK.findFirst({
            where: { id: tid, id_dt_project: pid },
            select: { id: true, id_dt_project: true, id_dt_section: true, rank: true },
          });
          if (!task) throw new NotFoundException(`Task ${tid} not found in project ${pid}`);

          // 2) Tujuan section:
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
          const beforeResolved =
            (await this.resolveTaskId(body.beforeId ?? null, pid)) ||
            this.normalizeGuid(body.beforeId ?? null);
          const afterResolved =
            (await this.resolveTaskId(body.afterId ?? null, pid)) ||
            this.normalizeGuid(body.afterId ?? null);
          const beforeId = beforeResolved === tid ? null : beforeResolved;
          const afterId = afterResolved === tid ? null : afterResolved;

          // 4) Ambil rank tetangga di section tujuan
          const [before, after] = await Promise.all([
            beforeId
              ? tx.dT_TASK.findFirst({
                  where: { id: beforeId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
                  select: { rank: true },
                })
              : Promise.resolve(null),
            afterId
              ? tx.dT_TASK.findFirst({
                  where: { id: afterId, id_dt_project: pid, id_dt_section: destSectionId ?? null },
                  select: { rank: true },
                })
              : Promise.resolve(null),
          ]);

          // 5) Hitung rank baru (LIST ASC – rank kecil = paling atas)
          const top = after;
          const bottom = before;
          let newRank: string;

          if (top && bottom) {
            newRank = this.rankBetween(top.rank ?? null, bottom.rank ?? null);
          } else if (top && !bottom) {
            const nextBelow = await tx.dT_TASK.findFirst({
              where: {
                id_dt_project: pid,
                id_dt_section: destSectionId ?? null,
                rank: { gt: top.rank ?? undefined },
              },
              orderBy: { rank: 'asc' },
              select: { rank: true },
            });
            newRank = this.rankBetween(top.rank ?? null, nextBelow?.rank ?? null);
          } else if (!top && bottom) {
            const prevAbove = await tx.dT_TASK.findFirst({
              where: {
                id_dt_project: pid,
                id_dt_section: destSectionId ?? null,
                rank: { lt: bottom.rank ?? undefined },
              },
              orderBy: { rank: 'desc' },
              select: { rank: true },
            });
            newRank = this.rankBetween(prevAbove?.rank ?? null, bottom.rank ?? null);
          } else {
            const max = await tx.dT_TASK.findFirst({
              where: { id_dt_project: pid, id_dt_section: destSectionId ?? null },
              orderBy: { rank: 'desc' },
              select: { rank: true },
            });
            newRank = this.rankAfter(max?.rank ?? null);
          }

          // 6) No-op guard kalau ternyata tidak berubah
          const sameSection = (task.id_dt_section ?? null) === (destSectionId ?? null);
          if (sameSection && task.rank === newRank) {
            const current = await tx.dT_TASK.findUnique({ where: { id: tid } });
            if (!current) throw new NotFoundException(`Task ${tid} not found`);
            return current;
          }

          // 7) Update
          return await tx.dT_TASK.update({
            where: { id: tid },
            data: {
              id_dt_section: destSectionId ?? null,
              rank: newRank,
            },
          });
        });

        this.projectGateway.broadcastToProject(pid, 'task:moved', {
          taskId: tid,
          id: tid,
          shortId: result.shortId,
          targetSectionId: result.id_dt_section,
          rank: result.rank,
          beforeId: body.beforeId ?? null,
          afterId: body.afterId ?? null,
        });

        return result;
      } catch (e: any) {
        if (attempt < MAX_RETRY) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 30 + Math.floor(Math.random() * 30)),
          );
          continue;
        }
        throw e;
      }
    }

    throw new BadRequestException('Unable to move task due to concurrent updates');
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
    senderNik?: string,
  ): Promise<{ nik: string; nama: string }[]> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
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
        where: { projectId: pid },
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
          where: { id_dt_project: pid },
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
            projectId: pid,
            nik: { in: toDeleteNik },
          },
        });

        for (const nik of toDeleteNik) {
          const oldMember = existing.find((e) => e.nik === nik);
          await tx.lOG_ACTIVITY.create({
            data: {
              projectId: pid,
              nik: senderNik || nik,
              action: 'MEMBER_REMOVED',
              details: JSON.stringify({
                memberName: oldMember?.user?.nama || nik,
              }),
            },
          });
        }
      }

      // 5) CREATE yang baru
      if (toCreate.length > 0) {
        await tx.dT_MEMBER_PROJECT.createMany({
          data: toCreate.map((m) => ({
            projectId: pid,
            nik: m.nik,
            id_dt_project_role: m.roleId,
          })),
        });

        for (const m of toCreate) {
          const userRec = await tx.dT_USER.findUnique({
            where: { nik: m.nik },
            select: { nama: true },
          });
          await tx.lOG_ACTIVITY.create({
            data: {
              projectId: pid,
              nik: m.nik,
              action: 'MEMBER_JOINED',
              details: JSON.stringify({
                memberName: userRec?.nama || m.nik,
                role: m.roleId,
              }),
            },
          });
        }

        // 📝 Catat ke LOG_INVITATION_PROJECT
        if (senderNik) {
          try {
            await tx.lOG_INVITATION_PROJECT.createMany({
              data: toCreate.map((m) => ({
                sender: senderNik,
                to: m.nik,
                projectId: pid,
                status: 'JOINED',
                asRole: m.roleId,
              })),
            });
          } catch (logErr) {
            this.logger.warn(
              `Failed logging to LOG_INVITATION_PROJECT: ${(logErr as Error).message}`,
            );
          }
        }
      }

      // 6) UPDATE role yang berubah
      if (toUpdate.length > 0) {
        await Promise.all(
          toUpdate.map((m) =>
            tx.dT_MEMBER_PROJECT.updateMany({
              where: {
                projectId: pid,
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
        where: { projectId: pid },
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
      const project = await this.prismaService.dT_PROJECT.findFirst({
        where: {
          OR: [{ id: pid }, { shortId: projectId }],
        },
        select: { name: true, shortId: true, id: true },
      });
      const projectName = (project?.name as string) ?? 'Project';
      const effectiveProjectId = project?.shortId || project?.id || projectId;

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

      const projectUrl = `/dashboard/project/${effectiveProjectId}`;

      // 1) NEW MEMBERS → "diundang / bergabung"
      for (const m of toCreate) {
        const u = userMap.get(this.normalizeNik(m.nik));
        this.pushService.notifyUser(m.nik, {
          type: 'project.member_added',
          title: 'Ditambahkan ke project',
          body: projectName,
          url: projectUrl,
        });
        if (!u?.email) {
          this.logger.warn(`User ${m.nik} does not have an email in DT_USER. Skipping email.`);
          continue;
        }

        this.logger.log(
          `📧 Sending project joined email to ${u.email} for project "${projectName}"...`,
        );
        await this.mailService.sendProjectJoinedEmail({
          to: u.email,
          projectId: effectiveProjectId,
          projectName,
          role: m.roleId as 'OWNER' | 'EDITOR' | 'READ',
        });
      }

      // 2) ROLE CHANGED → "role diubah"
      for (const x of toUpdate) {
        const u = userMap.get(this.normalizeNik(x.newData.nik));
        this.pushService.notifyUser(x.newData.nik, {
          type: 'project.role_changed',
          title: 'Role project diubah',
          body: projectName,
          url: projectUrl,
        });
        if (!u?.email) continue;

        this.logger.log(`📧 Sending project role changed email to ${u.email}...`);
        await this.mailService.sendProjectRoleChangedEmail({
          to: u.email,
          projectId: effectiveProjectId,
          projectName,
          oldRole: x.oldRole,
          newRole: x.newData.roleId as 'OWNER' | 'EDITOR' | 'READ',
        });
      }

      // 3) REMOVED → "akses dicabut"
      for (const nik of toDeleteNik) {
        const u = userMap.get(this.normalizeNik(nik));
        this.pushService.notifyUser(nik, {
          type: 'project.access_revoked',
          title: 'Akses project dicabut',
          body: projectName,
          url: '/dashboard',
        });
        if (!u?.email) continue;

        this.logger.log(`📧 Sending project access revoked email to ${u.email}...`);
        await this.mailService.sendProjectAccessRevokedEmail({
          to: u.email,
          projectId: effectiveProjectId,
          projectName,
        });
      }
    } catch (e) {
      this.logger.error(
        'Failed sending project member emails:',
        e instanceof Error ? e.stack : String(e),
      );
    }

    return finalMembers;
  }

  // =========================================================
  // 🔹 Sub TASK MANAGEMENT
  // =========================================================

  async addSubTask(
    taskId: string,
    data: AddSubTaskRequest,
    creatorNik: string,
  ): Promise<DT_SUB_TASK> {
    const tid = (await this.resolveTaskId(taskId)) || taskId;
    const task = await this.prismaService.dT_TASK.findUnique({ where: { id: tid } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const trimmedName = data.name.trim();

    // Guard duplicate submissions within 2 seconds
    const twoSecondsAgo = new Date(Date.now() - 2000);
    const existingRecent = await this.prismaService.dT_SUB_TASK.findFirst({
      where: {
        id_dt_task: tid,
        name: trimmedName,
        createdAt: { gte: twoSecondsAgo },
      },
    });
    if (existingRecent) {
      return existingRecent;
    }

    const max = await this.prismaService.dT_SUB_TASK.findFirst({
      where: { id_dt_task: tid },
      orderBy: { rank: 'desc' }, // ambil terbesar
      select: { rank: true },
    });
    const newRank = this.rankAfter(max?.rank ?? null);

    const created = await this.prismaService.dT_SUB_TASK.create({
      data: {
        name: trimmedName,
        dueDate: data.dueDate ?? null,
        id_dt_task: tid,
        createdBy: creatorNik,
        rank: newRank,
      },
    });

    if (task.id_dt_project) {
      this.projectGateway.broadcastToProject(task.id_dt_project, 'subtask:created', {
        taskId: tid,
        subtaskId: created.id,
        name: created.name,
        rank: created.rank,
        dueDate: created.dueDate,
        status: created.status,
        createdAt: created.createdAt,
        createdBy: created.createdBy,
      });

      await this.logActivity({
        projectId: task.id_dt_project,
        taskid: tid,
        nik: creatorNik,
        action: 'SUBTASK_CREATED',
        details: { subTaskName: created.name, parentTaskName: task.name },
      });
    }

    return created;
  }

  async updateSubTask(
    subtaskId: string,
    data: UpdateSubTaskRequest,
    nik?: string,
  ): Promise<DT_SUB_TASK> {
    const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: subtaskId },
      include: { task: { select: { id_dt_project: true } } },
    });
    if (!subtask) throw new NotFoundException(`Subtask ${subtaskId} not found`);

    const updated = await this.prismaService.dT_SUB_TASK.update({
      where: { id: subtaskId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
        ...(data.status !== undefined && {
          status: data.status,
          doneDate: data.status ? new Date() : null,
        }),
        ...(data.customFields !== undefined && { customFields: data.customFields }),
      },
    });

    if (subtask.task?.id_dt_project) {
      this.projectGateway.broadcastToProject(subtask.task.id_dt_project, 'subtask:updated', {
        taskId: subtask.id_dt_task,
        subtaskId: updated.id,
        name: updated.name,
        status: updated.status,
        dueDate: updated.dueDate,
        customFields: updated.customFields,
      });

      if (data.status !== undefined && data.status !== subtask.status) {
        await this.logActivity({
          projectId: subtask.task.id_dt_project,
          taskid: subtask.id_dt_task,
          nik: nik || subtask.createdBy || '00000000',
          action: data.status ? 'SUBTASK_COMPLETED' : 'SUBTASK_UNCOMPLETED',
          details: { subTaskName: updated.name },
        });
      }
    }

    return updated;
  }

  async syncSubTaskAssignees(
    taskId: string,
    subTaskId: string,
    dto: SyncSubTaskAssigneeRequest,
  ): Promise<string> {
    const tid = (await this.resolveTaskId(taskId)) || taskId;
    const normalizeNik = (v: string | number | null | undefined): string =>
      v == null ? '' : String(v).trim();

    const nextNikList = Array.from(
      new Set((dto.assignees ?? []).map((a) => normalizeNik(a.nik)).filter((n) => n.length > 0)),
    );

    // 1) Validasi task assignees
    const taskAssignees = await this.prismaService.dT_ASSIGNEE_TASK.findMany({
      where: { taskId: tid },
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
        return { toInsert: 0, toDelete: 0, insertedNiks: [] as string[], deletedNiks: [] as string[] };
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

      return {
        toInsert: toInsert.length,
        toDelete: toDelete.length,
        insertedNiks: toInsert,
        deletedNiks: toDelete,
      };
    });

    if (result.insertedNiks && result.insertedNiks.length > 0) {
      this.sendSubTaskAssignedEmailsAsync(subTaskId, result.insertedNiks).catch((err) =>
        this.logger.warn(`Failed sending subtask assigned emails: ${err}`),
      );
    }

    if (result.deletedNiks?.length) {
      this.prismaService.dT_SUB_TASK.findUnique({
        where: { id: subTaskId },
        include: {
          task: {
            select: {
              shortId: true,
              id: true,
              project: { select: { shortId: true, id: true } },
            },
          },
        },
      }).then((sub) => {
        if (!sub?.task) return;
        const effectiveProjectId = sub.task.project?.shortId || sub.task.project?.id;
        const taskLinkId = sub.task.shortId || sub.task.id;
        this.pushService.notifyUsers(result.deletedNiks!, {
          type: 'task.removed',
          title: 'Dilepas dari subtask',
          body: sub.name,
          url: `/dashboard/project/${effectiveProjectId}?task=${taskLinkId}`,
        });
      }).catch(() => undefined);
    }

    if (result.toInsert === 0 && result.toDelete === 0) {
      return 'Tidak ada perubahan assignee sub task.';
    }

    return `Berhasil sinkron assignee sub task. Tambah: ${result.toInsert}, hapus: ${result.toDelete}.`;
  }

  async deleteSubTask(subtaskId: string): Promise<{ message: string }> {
    const exist = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: subtaskId },
      include: { task: { select: { id_dt_project: true } } },
    });
    if (!exist) throw new NotFoundException(`Subtask ${subtaskId} not found`);

    await this.prismaService.dT_SUB_TASK.delete({ where: { id: subtaskId } });

    if (exist.task?.id_dt_project) {
      this.projectGateway.broadcastToProject(exist.task.id_dt_project, 'subtask:deleted', {
        taskId: exist.id_dt_task,
        subtaskId,
      });
    }

    return { message: 'Subtask deleted successfully' };
  }

  private async rebalanceTaskSubTasks(
    taskId: string,
    tx: Prisma.TransactionClient = this.prismaService,
  ): Promise<void> {
    const subtasks = await tx.dT_SUB_TASK.findMany({
      where: { id_dt_task: taskId },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    const base = 8000000000000000n;
    const step = 100000000000000n;

    for (let i = 0; i < subtasks.length; i++) {
      const rankStr = (base + BigInt(i) * step).toString().padStart(ProjectService.WIDTH, '0');
      await tx.dT_SUB_TASK.update({
        where: { id: subtasks[i].id },
        data: { rank: rankStr },
      });
    }
  }

  async moveSubTask(
    subtaskId: string,
    body: { beforeId?: string | null; afterId?: string | null; targetTaskId?: string | null },
  ): Promise<DT_SUB_TASK> {
    const sid = this.normalizeGuid(subtaskId);
    if (!sid) throw new BadRequestException('Invalid subtaskId');

    const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: sid },
      select: {
        id: true,
        id_dt_task: true,
        rank: true,
        task: { select: { id_dt_project: true } },
      },
    });
    if (!subtask) throw new NotFoundException(`Subtask ${sid} not found`);
    const tid = subtask.id_dt_task;
    if (!tid) throw new BadRequestException(`Subtask ${sid} has no parent task`);

    // FE exposes task.id as shortId (mapTask), so resolve shortId → GUID
    let targetTid = tid;
    if (body.targetTaskId) {
      const resolvedTarget =
        (await this.resolveTaskId(body.targetTaskId)) || this.normalizeGuid(body.targetTaskId);
      if (!resolvedTarget) {
        throw new NotFoundException(`Target task ${body.targetTaskId} not found`);
      }
      targetTid = resolvedTarget;

      if (targetTid !== tid) {
        const targetTask = await this.prismaService.dT_TASK.findUnique({
          where: { id: targetTid },
          select: { id: true },
        });
        if (!targetTask) throw new NotFoundException(`Target task ${targetTid} not found`);
      }
    }

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
      return !n || n.id_dt_task !== targetTid ? null : n;
    };

    const MAX_RETRY = 3;
    const computeNewRank = async (): Promise<string> => {
      // FE: beforeId = neighbor ATAS (rank lebih kecil), afterId = neighbor BAWAH (rank lebih besar)
      let [prevItem, nextItem] = await Promise.all([
        fetchNeighbor(beforeId),
        fetchNeighbor(afterId),
      ]);

      // 1) Diapit dua tetangga
      if (prevItem && nextItem) {
        if (prevItem.rank && nextItem.rank && prevItem.rank >= nextItem.rank) {
          await this.rebalanceTaskSubTasks(targetTid);
          [prevItem, nextItem] = await Promise.all([
            fetchNeighbor(beforeId),
            fetchNeighbor(afterId),
          ]);
        }
        let rank = this.rankBetween(prevItem?.rank ?? null, nextItem?.rank ?? null);
        if (rank === prevItem?.rank || rank === nextItem?.rank) {
          await this.rebalanceTaskSubTasks(targetTid);
          [prevItem, nextItem] = await Promise.all([
            fetchNeighbor(beforeId),
            fetchNeighbor(afterId),
          ]);
          rank = this.rankBetween(prevItem?.rank ?? null, nextItem?.rank ?? null);
        }
        return rank;
      }

      // 2) Di paling bawah (ada prevItem di atas, tidak ada nextItem di bawah)
      if (prevItem && !nextItem) {
        return this.rankAfter(prevItem.rank ?? null);
      }

      // 3) Di paling atas (tidak ada prevItem di atas, ada nextItem di bawah)
      if (!prevItem && nextItem) {
        return this.rankBetween(null, nextItem.rank ?? null);
      }

      // 4) Tanpa tetangga sama sekali
      return this.rankBetween(null, null);
    };

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const newRank = await computeNewRank();

        if (subtask.rank === newRank && targetTid === tid) {
          const current = await this.prismaService.dT_SUB_TASK.findUnique({ where: { id: sid } });
          if (!current) throw new NotFoundException(`Subtask ${sid} not found after lookup`);
          return current;
        }

        const updateData: { rank: string; id_dt_task?: string } = { rank: newRank };
        if (targetTid !== tid) {
          updateData.id_dt_task = targetTid;
        }

        const updated = await this.prismaService.dT_SUB_TASK.update({
          where: { id: sid },
          data: updateData,
        });

        if (targetTid !== tid) {
          // If subtask has assignees, ensure they are also part of targetTask
          const subAssignees = await this.prismaService.dT_ASSIGNEE_SUBTASK.findMany({
            where: { subTaskId: sid },
            select: { nik: true },
          });
          for (const sa of subAssignees) {
            await this.prismaService.dT_ASSIGNEE_TASK
              .upsert({
                where: { taskId_nik: { taskId: targetTid, nik: sa.nik } },
                create: { taskId: targetTid, nik: sa.nik },
                update: {},
              })
              .catch(() => null);
          }
        }

        const pid = subtask.task?.id_dt_project;
        if (pid) {
          this.projectGateway.broadcastToProject(pid, 'subtask:moved', {
            taskId: tid,
            targetTaskId: targetTid,
            subtaskId: sid,
            beforeId: body.beforeId ?? null,
            afterId: body.afterId ?? null,
            rank: updated.rank,
          });
        }

        return updated;
      } catch (e: any) {
        if (this.isUniqueConstraintError(e) && attempt < MAX_RETRY) {
          await this.rebalanceTaskSubTasks(targetTid);
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException('Unable to move subtask');
  }

  /**
   * Promote subtask → standalone task.
   * Neighbors (beforeId/afterId) are tasks in the destination section.
   */
  async promoteSubTask(
    projectId: string,
    subtaskId: string,
    body: {
      targetSectionId?: string | null;
      beforeId?: string | null;
      afterId?: string | null;
    },
  ): Promise<{ id: string; shortId: string | null }> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const sid = this.normalizeGuid(subtaskId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!sid) throw new BadRequestException('Invalid subtaskId');

    const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
      where: { id: sid },
      include: {
        assignees: { select: { nik: true } },
        task: {
          select: {
            id: true,
            id_dt_project: true,
            id_dt_section: true,
            id_dt_view: true,
            createdBy: true,
          },
        },
      },
    });
    if (!subtask) throw new NotFoundException(`Subtask ${sid} not found`);
    if (subtask.task.id_dt_project !== pid) {
      throw new BadRequestException('Subtask does not belong to this project');
    }

    let destSectionId: string | null;
    if ('targetSectionId' in body) {
      const raw = body.targetSectionId;
      destSectionId =
        raw === 'unlocated' || raw === 'null' || raw == null ? null : this.normalizeGuid(raw);
    } else {
      destSectionId = subtask.task.id_dt_section;
    }
    if (destSectionId) {
      await this.ensureSectionExists(pid, destSectionId);
    }

    const beforeResolved =
      (await this.resolveTaskId(body.beforeId ?? null, pid)) ||
      this.normalizeGuid(body.beforeId ?? null);
    const afterResolved =
      (await this.resolveTaskId(body.afterId ?? null, pid)) ||
      this.normalizeGuid(body.afterId ?? null);

    const newRank = await this.computeTaskRankInSection(
      pid,
      destSectionId,
      beforeResolved,
      afterResolved,
    );

    const creatorNik =
      this.normalizeNik(subtask.createdBy) || this.normalizeNik(subtask.task.createdBy);
    if (!creatorNik) throw new BadRequestException('Missing creator for promoted task');

    const created = await this.prismaService.$transaction(async (tx) => {
      const task = await tx.dT_TASK.create({
        data: {
          name: subtask.name,
          createdBy: creatorNik,
          dueDate: subtask.dueDate,
          doneDate: subtask.doneDate,
          status: subtask.status,
          customFields: subtask.customFields,
          id_dt_project: pid,
          id_dt_section: destSectionId,
          id_dt_view: subtask.task.id_dt_view,
          rank: newRank,
          shortId: this.generateShortId(7),
        },
      });

      const niks = Array.from(
        new Set(subtask.assignees.map((a) => this.normalizeNik(a.nik)).filter(Boolean)),
      );
      if (niks.length > 0) {
        await tx.dT_ASSIGNEE_TASK.createMany({
          data: niks.map((nik) => ({ taskId: task.id, nik })),
        });
      }

      await tx.dT_ASSIGNEE_SUBTASK.deleteMany({ where: { subTaskId: sid } });
      await tx.dT_SUB_TASK.delete({ where: { id: sid } });

      return task;
    });

    return { id: created.shortId || created.id, shortId: created.shortId };
  }

  /**
   * Demote task → subtask under another task.
   * Former child subtasks are re-parented under the target task.
   * Neighbors (beforeId/afterId) are subtasks under the target.
   */
  async demoteTask(
    projectId: string,
    taskId: string,
    body: {
      targetTaskId: string;
      beforeId?: string | null;
      afterId?: string | null;
    },
  ): Promise<DT_SUB_TASK> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const tid = (await this.resolveTaskId(taskId, pid)) || this.normalizeGuid(taskId);
    const targetTid =
      (await this.resolveTaskId(body.targetTaskId, pid)) || this.normalizeGuid(body.targetTaskId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!tid) throw new BadRequestException('Invalid taskId');
    if (!targetTid) throw new BadRequestException('Invalid targetTaskId');
    if (tid === targetTid) {
      throw new BadRequestException('Cannot demote a task under itself');
    }

    const [task, target] = await Promise.all([
      this.prismaService.dT_TASK.findFirst({
        where: { id: tid, id_dt_project: pid },
        include: {
          assignees: { select: { nik: true } },
          subTask: {
            select: { id: true },
            orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
          },
        },
      }),
      this.prismaService.dT_TASK.findFirst({
        where: { id: targetTid, id_dt_project: pid },
        select: { id: true },
      }),
    ]);
    if (!task) {
      const existingSub = await this.prismaService.dT_SUB_TASK.findUnique({
        where: { id: tid },
        include: { task: true },
      });
      if (existingSub && existingSub.task.id_dt_project === pid) {
        return this.moveSubTask(tid, {
          beforeId: body.beforeId,
          afterId: body.afterId,
          targetTaskId: targetTid,
        }) as any;
      }
      throw new NotFoundException(`Task ${tid} not found in project ${pid}`);
    }
    if (!target) throw new NotFoundException(`Target task ${targetTid} not found`);

    const beforeIdRaw = this.normalizeGuid(body.beforeId ?? null);
    const afterIdRaw = this.normalizeGuid(body.afterId ?? null);

    return this.prismaService.$transaction(async (tx) => {
      // Rank among target's current subtasks (excluding none yet)
      const fetchNeighbor = async (nid: string | null) => {
        if (!nid) return null;
        const n = await tx.dT_SUB_TASK.findUnique({
          where: { id: nid },
          select: { id: true, id_dt_task: true, rank: true },
        });
        return !n || n.id_dt_task !== targetTid ? null : n;
      };

      const [prevItem, nextItem] = await Promise.all([
        fetchNeighbor(beforeIdRaw),
        fetchNeighbor(afterIdRaw),
      ]);

      let newRank: string;
      if (prevItem && nextItem) {
        newRank = this.rankBetween(prevItem.rank ?? null, nextItem.rank ?? null);
      } else if (prevItem && !nextItem) {
        newRank = this.rankAfter(prevItem.rank ?? null);
      } else if (!prevItem && nextItem) {
        newRank = this.rankBetween(null, nextItem.rank ?? null);
      } else {
        const max = await tx.dT_SUB_TASK.findFirst({
          where: { id_dt_task: targetTid },
          orderBy: { rank: 'desc' },
          select: { rank: true },
        });
        newRank = this.rankAfter(max?.rank ?? null);
      }

      const created = await tx.dT_SUB_TASK.create({
        data: {
          name: task.name,
          id_dt_task: targetTid,
          createdBy: task.createdBy,
          dueDate: task.dueDate,
          doneDate: task.doneDate,
          status: task.status,
          customFields: task.customFields,
          rank: newRank,
        },
      });

      const taskNiks = Array.from(
        new Set(task.assignees.map((a) => this.normalizeNik(a.nik)).filter(Boolean)),
      );
      for (const nik of taskNiks) {
        await tx.dT_ASSIGNEE_TASK.upsert({
          where: { taskId_nik: { taskId: targetTid, nik } },
          create: { taskId: targetTid, nik },
          update: {},
        });
      }
      if (taskNiks.length > 0) {
        await tx.dT_ASSIGNEE_SUBTASK.createMany({
          data: taskNiks.map((nik) => ({ subTaskId: created.id, nik })),
        });
      }

      // Flatten former children under the new parent (after the demoted row)
      const childIds = task.subTask.map((s) => s.id);
      if (childIds.length > 0) {
        let cursor = created.rank ?? newRank;
        for (const childId of childIds) {
          cursor = this.rankAfter(cursor);
          await tx.dT_SUB_TASK.update({
            where: { id: childId },
            data: { id_dt_task: targetTid, rank: cursor },
          });
        }
      }

      // Tear down original task (children already re-parented)
      await tx.dT_ASSIGNEE_TASK.deleteMany({ where: { taskId: tid } });
      await tx.dT_TASK_ATTACHMENT.deleteMany({ where: { taskId: tid } });
      await tx.dT_TAG.deleteMany({ where: { id_dt_task: tid } });
      await tx.dT_TASK.delete({ where: { id: tid } });

      return created;
    });
  }

  /** Shared rank insert helper for tasks within a section (LIST ASC). */
  private async computeTaskRankInSection(
    projectId: string,
    destSectionId: string | null,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<string> {
    const [before, after] = await Promise.all([
      beforeId
        ? this.prismaService.dT_TASK.findFirst({
            where: {
              id: beforeId,
              id_dt_project: projectId,
              id_dt_section: destSectionId ?? null,
            },
            select: { rank: true },
          })
        : Promise.resolve(null),
      afterId
        ? this.prismaService.dT_TASK.findFirst({
            where: {
              id: afterId,
              id_dt_project: projectId,
              id_dt_section: destSectionId ?? null,
            },
            select: { rank: true },
          })
        : Promise.resolve(null),
    ]);

    const top = after;
    const bottom = before;

    if (top && bottom) {
      return this.rankBetween(top.rank ?? null, bottom.rank ?? null);
    }
    if (top && !bottom) {
      const nextBelow = await this.prismaService.dT_TASK.findFirst({
        where: {
          id_dt_project: projectId,
          id_dt_section: destSectionId ?? null,
          rank: { gt: top.rank ?? undefined },
        },
        orderBy: { rank: 'asc' },
        select: { rank: true },
      });
      return this.rankBetween(top.rank ?? null, nextBelow?.rank ?? null);
    }
    if (!top && bottom) {
      const prevAbove = await this.prismaService.dT_TASK.findFirst({
        where: {
          id_dt_project: projectId,
          id_dt_section: destSectionId ?? null,
          rank: { lt: bottom.rank ?? undefined },
        },
        orderBy: { rank: 'desc' },
        select: { rank: true },
      });
      return this.rankBetween(prevAbove?.rank ?? null, bottom.rank ?? null);
    }

    const max = await this.prismaService.dT_TASK.findFirst({
      where: { id_dt_project: projectId, id_dt_section: destSectionId ?? null },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    return this.rankAfter(max?.rank ?? null);
  }

  // =========================================================
  // 🔹 SECTION MANAGEMENT (ordered)
  // =========================================================
  private mapTask(t: {
    id: string;
    shortId?: string | null;
    name: string;
    desc: string | null;
    dueDate: Date | null;
    status: boolean;
    doneDate?: Date | string | null;
    createdAt?: Date | string | null;
    id_dt_view?: string | null;
    view?: { id: string; shortId?: string | null; name: string; type: string } | null;
    assignees: { user: { nik: string; nama: string; photo?: string | null } }[];
    creator: { nik?: string; nama: string; photo?: string | null } | null;
    subTask?: {
      id: string;
      name: string;
      dueDate: Date | null;
      status: boolean;
      doneDate?: Date | string | null;
      createdAt?: Date | string | null;
      assignees: { user: { nik: string; nama: string; photo?: string | null } }[];
    }[];
  }): TaskNonSection {
    const taskSlug = t.shortId || t.id;
    const viewSlug = t.view?.shortId || t.view?.id || t.id_dt_view || null;
    return {
      id: taskSlug,
      guid: t.id,
      shortId: t.shortId ?? null,
      name: t.name,
      desc: t.desc,
      dueDate: t.dueDate,
      status: Boolean(t.status),
      doneDate: t.doneDate ?? null,
      createdAt: t.createdAt ?? null,
      id_dt_view: viewSlug,
      view: t.view
        ? {
            id: t.view.shortId || t.view.id,
            name: t.view.name,
            type: t.view.type,
            shortId: t.view.shortId,
          }
        : null,

      assignees: (t.assignees ?? []).map((a) => ({
        nik: a.user.nik,
        nama: a.user.nama,
        photo: a.user.photo ?? null,
      })),

      creator: {
        nik: t.creator?.nik ?? '',
        nama: t.creator?.nama ?? '',
        photo: t.creator?.photo ?? null,
      },
      customFields: (t as any).customFields ?? null,

      subTask:
        t.subTask?.map<SubTask>((st) => ({
          id: st.id,
          name: st.name,
          dueDate: st.dueDate,
          status: st.status,
          doneDate: st.doneDate ?? null,
          createdAt: st.createdAt ?? null,
          createdBy: (st as any).createdBy ?? null,
          creator: (st as any).creator
            ? {
                nik: (st as any).creator.nik ?? '',
                nama: (st as any).creator.nama ?? '',
                photo: (st as any).creator.photo ?? null,
              }
            : null,
          customFields: (st as any).customFields ?? null,
          assignees:
            st.assignees?.map((sa) => ({
              nik: sa.user.nik,
              nama: sa.user.nama,
              photo: sa.user.photo ?? null,
            })) ?? [],
        })) ?? [],
    };
  }

  private get taskSelect() {
    return {
      id: true,
      shortId: true,
      name: true,
      desc: true,
      dueDate: true,
      status: true,
      doneDate: true,
      createdAt: true,
      id_dt_view: true,
      customFields: true,
      view: {
        select: {
          id: true,
          shortId: true,
          name: true,
          type: true,
        },
      },

      assignees: {
        select: {
          user: {
            select: {
              nik: true,
              nama: true,
              photo: true,
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
          nik: true,
          nama: true,
          photo: true,
        },
      },
      subTask: {
        select: {
          id: true,
          name: true,
          dueDate: true,
          status: true,
          doneDate: true,
          createdAt: true,
          createdBy: true,
          customFields: true,
          creator: {
            select: {
              nik: true,
              nama: true,
              photo: true,
            },
          },
          assignees: {
            select: {
              user: {
                select: {
                  nik: true,
                  nama: true,
                  photo: true,
                },
              },
            },
          },
        },
        orderBy: { rank: 'asc' as const },
      },
    } as const;
  }

  async findTasksAndSections(projectId: string, viewId?: string): Promise<TaskSectionResponse> {
    const pid =
      (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId) || projectId;
    void viewId;

    const unlocatedWhere: any = { id_dt_project: pid, id_dt_section: null };

    const taskQuery: any = {
      select: this.taskSelect,
      orderBy: [{ rank: 'asc' }],
    };

    const [unlocatedTasks, sections] = await Promise.all([
      this.prismaService.dT_TASK.findMany({
        where: unlocatedWhere,
        select: this.taskSelect,
        orderBy: [{ rank: 'asc' }],
      }),
      this.prismaService.dT_SECTION.findMany({
        where: { id_dt_project: pid },
        select: {
          id: true,
          name: true,
          category: true,
          rank: true,
          tasks: taskQuery,
        },
        orderBy: { rank: 'asc' },
      }) as Promise<any[]>,
    ]);
    return {
      unlocated: unlocatedTasks.map((t) => this.mapTask(t)),
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category || 'active',
        tasks: (s.tasks ?? []).map((t: any) => this.mapTask(t)),
      })),
    };
  }

  async createSection(
    projectId: string,
    name: string,
    category: string = 'active',
    nik?: string,
  ): Promise<DT_SECTION> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    const last = await this.prismaService.dT_SECTION.findFirst({
      where: { id_dt_project: pid },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    let rank = last ? this.rankAfter(last.rank) : '8888888888888888';

    let created: DT_SECTION | null = null;
    for (let i = 0; i < 3; i += 1) {
      try {
        created = await this.prismaService.dT_SECTION.create({
          data: { name, id_dt_project: pid, rank, category },
        });
        break;
      } catch (e) {
        if (this.isUniqueConstraintError(e) && i < 2) {
          const next = await this.prismaService.dT_SECTION.findFirst({
            where: { id_dt_project: pid },
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

    if (!created) {
      created = await this.prismaService.dT_SECTION.create({
        data: { name, id_dt_project: pid, rank, category },
      });
    }

    this.projectGateway.broadcastToProject(pid, 'section:created', {
      sectionId: created.id,
      name: created.name,
      rank: created.rank,
      category: created.category,
    });

    if (created && nik) {
      await this.logActivity({
        projectId: pid,
        nik,
        action: 'SECTION_CREATED',
        details: { sectionName: created.name },
      });
    }

    return created;
  }

  async updateSection(
    sectionId: string,
    payload: { name?: string; category?: string } | string,
  ): Promise<DT_SECTION> {
    const data: any = {};
    if (typeof payload === 'string') {
      data.name = payload;
    } else {
      if (payload.name !== undefined) data.name = payload.name;
      if (payload.category !== undefined) data.category = payload.category;
    }
    const updated = await this.prismaService.dT_SECTION.update({
      where: { id: sectionId },
      data,
    });

    if (updated.id_dt_project) {
      this.projectGateway.broadcastToProject(updated.id_dt_project, 'section:updated', {
        sectionId: updated.id,
        name: updated.name,
        category: updated.category,
      });
    }

    return updated;
  }

  async removeSection(
    { projectId, sectionId, includeTask }: RemoveSectionArgs,
    nik?: string,
  ): Promise<string> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    let deletedSecName: string | null = null;
    await this.prismaService.$transaction(async (tx) => {
      const sec = await tx.dT_SECTION.findFirst({
        where: { id: sectionId, id_dt_project: pid },
        select: { id: true, name: true },
      });

      if (!sec) {
        throw new Error('Section tidak ditemukan untuk project tersebut');
      }
      deletedSecName = sec.name;

      if (includeTask) {
        await tx.dT_TASK.deleteMany({
          where: { id_dt_section: sectionId, id_dt_project: pid },
        });
      } else {
        await tx.dT_TASK.updateMany({
          where: { id_dt_section: sectionId, id_dt_project: pid },
          data: { id_dt_section: null },
        });
      }
      await tx.dT_SECTION.delete({
        where: { id: sectionId },
      });
    });

    this.projectGateway.broadcastToProject(pid, 'section:deleted', {
      sectionId,
      includeTask,
    });

    if (nik && deletedSecName) {
      await this.logActivity({
        projectId: pid,
        nik,
        action: 'SECTION_DELETED',
        details: { sectionName: deletedSecName },
      });
    }

    return 'Delete Section Successfully';
  }

  async moveSection(
    projectId: string,
    sectionId: string,
    opts: { beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_SECTION> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const sid = this.normalizeGuid(sectionId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!sid) throw new BadRequestException('Invalid sectionId');

    const beforeIdRaw = this.normalizeGuid(opts.beforeId ?? null);
    const afterIdRaw = this.normalizeGuid(opts.afterId ?? null);
    const beforeId = beforeIdRaw === sid ? null : beforeIdRaw;
    const afterId = afterIdRaw === sid ? null : afterIdRaw;

    const MAX_RETRY = 5;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const result = await this.prismaService.$transaction(async (tx) => {
          // 🔒 Lock project row to serialize section moves for this project
          await tx.$executeRaw`
            SELECT id FROM dbo.DT_PROJECT WITH (UPDLOCK, ROWLOCK)
            WHERE id = ${pid}
          `;

          const section = await tx.dT_SECTION.findFirst({
            where: { id: sid, id_dt_project: pid },
            select: { id: true, rank: true },
          });
          if (!section) throw new NotFoundException('Section not found in this project');

          const [before, after] = await Promise.all([
            beforeId
              ? tx.dT_SECTION.findFirst({
                  where: { id: beforeId, id_dt_project: pid },
                  select: { rank: true },
                })
              : Promise.resolve(null),
            afterId
              ? tx.dT_SECTION.findFirst({
                  where: { id: afterId, id_dt_project: pid },
                  select: { rank: true },
                })
              : Promise.resolve(null),
          ]);

          // FE: afterId = atas, beforeId = bawah
          const newRank = this.rankBetween(after?.rank ?? null, before?.rank ?? null);

          if (section.rank === newRank) {
            const current = await tx.dT_SECTION.findUnique({ where: { id: sid } });
            if (!current) throw new NotFoundException(`Section ${sid} not found`);
            return current;
          }

          return await tx.dT_SECTION.update({
            where: { id: sid },
            data: { rank: newRank },
          });
        });

        this.projectGateway.broadcastToProject(pid, 'section:moved', {
          sectionId: sid,
          rank: result.rank,
          beforeId: opts.beforeId ?? null,
          afterId: opts.afterId ?? null,
        });

        return result;
      } catch (e: any) {
        if (attempt < MAX_RETRY) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 30 + Math.floor(Math.random() * 30)),
          );
          continue;
        }
        throw e;
      }
    }

    throw new BadRequestException('Unable to move section due to concurrent updates');
  }

  // =========================================================
  // 🔹 TAG MANAGEMENT
  // =========================================================

  async findTags(projectId: string): Promise<DT_TAG[]> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    return this.prismaService.dT_TAG.findMany({
      where: { id_dt_project: pid },
      orderBy: { name: 'asc' },
    });
  }

  async findTag(projectId: string, tagId: string): Promise<DT_TAG> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    const tag = await this.prismaService.dT_TAG.findFirst({
      where: { id_dt_project: pid, id: tagId },
    });
    if (!tag) throw new NotFoundException(`Tag with id ${tagId} not found in project ${projectId}`);
    return tag;
  }

  async createTag(projectId: string, tagName: string): Promise<string> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    const existing = await this.prismaService.dT_TAG.findFirst({
      where: { id_dt_project: pid, name: tagName },
    });
    if (existing) throw new ConflictException(`Tag '${tagName}' already exists`);
    await this.prismaService.dT_TAG.create({ data: { name: tagName, id_dt_project: pid } });
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
  private static readonly SHORT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
  generateShortId(length = 7): string {
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result +=
        ProjectService.SHORT_ID_ALPHABET[bytes[i] % ProjectService.SHORT_ID_ALPHABET.length];
    }
    return result;
  }

  async resolveProjectId(idOrShort?: string | null): Promise<string | null> {
    if (!idOrShort) return null;
    const raw = this.stripSectionPrefix(idOrShort)?.trim();
    if (!raw) return null;
    if (ProjectService.UUID_REGEX.test(raw)) return raw.toLowerCase();
    const project = await this.prismaService.dT_PROJECT.findFirst({
      where: { shortId: raw.toLowerCase() },
      select: { id: true },
    });
    return project?.id ? project.id.toLowerCase() : null;
  }

  async resolveTaskId(
    idOrShort?: string | null,
    projectId?: string | null,
  ): Promise<string | null> {
    if (!idOrShort) return null;
    const raw = idOrShort.trim();
    if (ProjectService.UUID_REGEX.test(raw)) return raw.toLowerCase();
    const where: any = { shortId: raw.toLowerCase() };
    if (projectId) {
      const pid = (await this.resolveProjectId(projectId)) || projectId;
      where.id_dt_project = pid;
    }
    const task = await this.prismaService.dT_TASK.findFirst({
      where,
      select: { id: true },
    });
    return task?.id ? task.id.toLowerCase() : null;
  }

  async resolveViewId(
    idOrShort?: string | null,
    projectId?: string | null,
  ): Promise<string | null> {
    if (!idOrShort) return null;
    const raw = idOrShort.trim();
    if (ProjectService.UUID_REGEX.test(raw)) return raw.toLowerCase();
    const where: any = { shortId: raw.toLowerCase() };
    if (projectId) {
      const pid = (await this.resolveProjectId(projectId)) || projectId;
      where.projectId = pid;
    }
    const view = await this.prismaService.dT_VIEWS.findFirst({
      where,
      select: { id: true },
    });
    return view?.id ? view.id.toLowerCase() : null;
  }

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

  // =========================================================
  // 🔹 VIEW MANAGEMENT
  // =========================================================
  async getProjectViews(projectId: string): Promise<DT_VIEWS[]> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    await this.ensureProjectExists(pid);

    const views = await this.prismaService.dT_VIEWS.findMany({
      where: { projectId: pid },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
    });
    return views.map((v) => ({
      ...v,
      id: v.shortId || v.id,
      projectId: projectId,
    }));
  }

  async createView(
    projectId: string,
    name: string,
    type: string,
    settings?: string,
  ): Promise<DT_VIEWS> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    await this.ensureProjectExists(pid);

    const trimmedName = name?.trim();
    if (!trimmedName) throw new BadRequestException('View name cannot be empty');
    const viewType = (type || 'list').trim().toLowerCase();

    const last = await this.prismaService.dT_VIEWS.findFirst({
      where: { projectId: pid },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    const newRank = last?.rank ? this.rankAfter(last.rank) : '8000000000000000';

    const created = await this.prismaService.dT_VIEWS.create({
      data: {
        projectId: pid,
        name: trimmedName,
        type: viewType,
        rank: newRank,
        shortId: this.generateShortId(7),
        ...(settings !== undefined ? { settings } : {}),
      },
    });

    this.projectGateway.broadcastToProject(pid, 'view:created', {
      view: {
        ...created,
        id: created.shortId || created.id,
        projectId,
      },
    });

    return {
      ...created,
      id: created.shortId || created.id,
      projectId: projectId,
    };
  }

  private async rebalanceProjectViews(
    projectId: string,
    tx: Prisma.TransactionClient = this.prismaService,
  ): Promise<void> {
    const views = await tx.dT_VIEWS.findMany({
      where: { projectId },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    const base = 8000000000000000n;
    const step = 100000000000000n;

    for (let i = 0; i < views.length; i++) {
      const rankStr = (base + BigInt(i) * step).toString().padStart(ProjectService.WIDTH, '0');
      await tx.dT_VIEWS.update({
        where: { id: views[i].id },
        data: { rank: rankStr },
      });
    }
  }

  async moveView(
    projectId: string,
    viewId: string,
    opts: { beforeId?: string | null; afterId?: string | null },
  ): Promise<DT_VIEWS> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const vid = (await this.resolveViewId(viewId, pid)) || this.normalizeGuid(viewId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!vid) throw new BadRequestException('Invalid viewId');

    const beforeIdRaw =
      (await this.resolveViewId(opts.beforeId, pid)) || this.normalizeGuid(opts.beforeId ?? null);
    const afterIdRaw =
      (await this.resolveViewId(opts.afterId, pid)) || this.normalizeGuid(opts.afterId ?? null);
    const beforeId = beforeIdRaw === vid ? null : beforeIdRaw;
    const afterId = afterIdRaw === vid ? null : afterIdRaw;

    const MAX_RETRY = 5;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return await this.prismaService.$transaction(async (tx) => {
          // 🔒 Critical section: lock project row with UPDLOCK to serialize concurrent moves for this project
          await tx.$executeRaw`
            SELECT id FROM dbo.DT_PROJECT WITH (UPDLOCK, ROWLOCK)
            WHERE id = ${pid}
          `;

          const view = await tx.dT_VIEWS.findFirst({
            where: { id: vid, projectId: pid },
            select: { id: true, rank: true },
          });
          if (!view) throw new NotFoundException('View not found in this project');

          const fetchNeighbor = async (id: string | null) => {
            if (!id) return null;
            return tx.dT_VIEWS.findFirst({
              where: { id, projectId: pid },
              select: { id: true, rank: true },
            });
          };

          const [bottom, top] = await Promise.all([
            fetchNeighbor(beforeId),
            fetchNeighbor(afterId),
          ]);

          let newRank: string;

          if (top && bottom) {
            // Check if concurrent reordering inverted neighbors
            if (top.rank >= bottom.rank) {
              await this.rebalanceProjectViews(pid, tx);
              const [reBottom, reTop] = await Promise.all([
                fetchNeighbor(beforeId),
                fetchNeighbor(afterId),
              ]);
              newRank = this.rankBetween(reTop?.rank ?? null, reBottom?.rank ?? null);
            } else {
              newRank = this.rankBetween(top.rank, bottom.rank);
              if (newRank === top.rank || newRank === bottom.rank) {
                await this.rebalanceProjectViews(pid, tx);
                const [reBottom, reTop] = await Promise.all([
                  fetchNeighbor(beforeId),
                  fetchNeighbor(afterId),
                ]);
                newRank = this.rankBetween(reTop?.rank ?? null, reBottom?.rank ?? null);
              }
            }
          } else if (top && !bottom) {
            const nextBelow = await tx.dT_VIEWS.findFirst({
              where: { projectId: pid, rank: { gt: top.rank } },
              orderBy: { rank: 'asc' },
              select: { rank: true },
            });
            newRank = this.rankBetween(top.rank, nextBelow?.rank ?? null);
          } else if (!top && bottom) {
            const prevAbove = await tx.dT_VIEWS.findFirst({
              where: { projectId: pid, rank: { lt: bottom.rank } },
              orderBy: { rank: 'desc' },
              select: { rank: true },
            });
            newRank = this.rankBetween(prevAbove?.rank ?? null, bottom.rank);
          } else {
            const max = await tx.dT_VIEWS.findFirst({
              where: { projectId: pid },
              orderBy: { rank: 'desc' },
              select: { rank: true },
            });
            newRank = this.rankAfter(max?.rank ?? null);
          }

          const colliding = await tx.dT_VIEWS.findFirst({
            where: { projectId: pid, rank: newRank, id: { not: vid } },
            select: { id: true },
          });

          if (colliding) {
            await this.rebalanceProjectViews(pid, tx);
            const [reBottom, reTop] = await Promise.all([
              fetchNeighbor(beforeId),
              fetchNeighbor(afterId),
            ]);
            newRank = this.rankBetween(reTop?.rank ?? null, reBottom?.rank ?? null);
          }

          if (view.rank === newRank) {
            return tx.dT_VIEWS.findUniqueOrThrow({ where: { id: vid } });
          }

          const updated = await tx.dT_VIEWS.update({
            where: { id: vid },
            data: { rank: newRank },
          });

          this.projectGateway.broadcastToProject(pid, 'view:moved', {
            viewId: updated.shortId || updated.id,
            rank: updated.rank,
            beforeId: opts.beforeId ?? null,
            afterId: opts.afterId ?? null,
          });

          return updated;
        });
      } catch (e: any) {
        if (attempt < MAX_RETRY) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 30 + Math.floor(Math.random() * 30)),
          );
          continue;
        }
        throw e;
      }
    }

    throw new BadRequestException('Unable to move view due to concurrent updates');
  }

  async updateView(
    projectId: string,
    viewId: string,
    data: { name?: string; type?: string; settings?: string },
  ): Promise<DT_VIEWS> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const vid = (await this.resolveViewId(viewId, pid)) || this.normalizeGuid(viewId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!vid) throw new BadRequestException('Invalid viewId');

    const existing = await this.prismaService.dT_VIEWS.findFirst({
      where: { id: vid, projectId: pid },
    });
    if (!existing) throw new NotFoundException('View not found in this project');

    const trimmedName = data.name !== undefined ? data.name.trim() : undefined;
    if (trimmedName !== undefined && trimmedName.length === 0) {
      throw new BadRequestException('View name cannot be empty');
    }
    const viewType = data.type !== undefined ? data.type.trim().toLowerCase() : undefined;

    const updated = await this.prismaService.dT_VIEWS.update({
      where: { id: vid },
      data: {
        ...(trimmedName !== undefined ? { name: trimmedName } : {}),
        ...(viewType !== undefined ? { type: viewType } : {}),
        ...(data.settings !== undefined ? { settings: data.settings } : {}),
      },
    });

    this.projectGateway.broadcastToProject(pid, 'view:updated', {
      viewId: updated.shortId || updated.id,
      id: updated.id,
      shortId: updated.shortId,
      name: updated.name,
      type: updated.type,
      settings: updated.settings,
    });

    return {
      ...updated,
      id: updated.shortId || updated.id,
      projectId,
    };
  }

  async deleteView(
    projectId: string,
    viewId: string,
  ): Promise<{ message: string; fallbackViewId?: string }> {
    const pid = (await this.resolveProjectId(projectId)) || this.normalizeGuid(projectId);
    const vid = (await this.resolveViewId(viewId, pid)) || this.normalizeGuid(viewId);
    if (!pid) throw new BadRequestException('Invalid projectId');
    if (!vid) throw new BadRequestException('Invalid viewId');

    const existing = await this.prismaService.dT_VIEWS.findFirst({
      where: { id: vid, projectId: pid },
    });
    if (!existing) throw new NotFoundException('View not found in this project');

    // Pastikan tidak menghapus view satu-satunya
    const totalViews = await this.prismaService.dT_VIEWS.count({
      where: { projectId: pid },
    });
    if (totalViews <= 1) {
      throw new BadRequestException('Cannot delete the only view in the project');
    }

    // Cari fallback view lain untuk memindahkan task
    const fallbackView = await this.prismaService.dT_VIEWS.findFirst({
      where: { projectId: pid, id: { not: vid } },
    });

    await this.prismaService.$transaction(async (tx) => {
      // Reassign tasks to fallback view
      await tx.dT_TASK.updateMany({
        where: { id_dt_project: pid, id_dt_view: vid },
        data: { id_dt_view: fallbackView?.id ?? null },
      });

      // Delete view
      await tx.dT_VIEWS.delete({
        where: { id: vid },
      });
    });

    this.projectGateway.broadcastToProject(pid, 'view:deleted', {
      viewId: existing.shortId || existing.id,
      resolvedViewId: vid,
      fallbackViewId: fallbackView?.shortId || fallbackView?.id,
    });

    return {
      message: 'View deleted successfully',
      fallbackViewId: fallbackView?.shortId || fallbackView?.id,
    };
  }

  private async ensureProjectExists(projectId: string): Promise<ProjectDetail> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    const project = await this.prismaService.dT_PROJECT.findFirst({
      where: {
        OR: [
          ...(ProjectService.UUID_REGEX.test(pid) ? [{ id: pid }] : []),
          { shortId: projectId.toLowerCase() },
        ],
      },
      select: {
        id: true,
        shortId: true,
        name: true,
        desc: true,
        color: true,
        icon: true,
        views: { orderBy: [{ rank: 'asc' }, { id: 'asc' }] },
        isPrivate: true,
        defaultPermission: true,
        createdBy: true,
        createdAt: true,
        isArchive: true,
        members: {
          select: {
            nik: true,
            roleProject: { select: { name: true } },
            user: { select: { nama: true, photo: true } },
          },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            user: {
              select: {
                nik: true,
                nama: true,
                photo: true,
              },
            },
          },
        },
      },
    });
    if (!project) throw new NotFoundException(`Project with id ${projectId} not found`);

    const formattedMembers: ProjectMemberFlat[] = project.members.map((m) => ({
      nik: m.nik.trim(),
      role: m.roleProject?.name ?? null,
      nama: m.user?.nama ?? null,
      photo: m.user?.photo ?? null,
    }));

    const projectSlug = project.shortId || project.id;
    return {
      id: projectSlug,
      shortId: project.shortId,
      name: project.name,
      desc: project.desc,
      color: project.color,
      icon: project.icon,
      views: project.views.map((v) => ({
        ...v,
        id: v.shortId || v.id,
        projectId: projectSlug,
      })),
      isPrivate: project.isPrivate,
      defaultPermission: project.defaultPermission,
      createdBy: project.createdBy,
      createdAt: project.createdAt,
      isArchive: project.isArchive,
      members: formattedMembers,
      activities: (project.activities || []).map((act) => ({
        id: act.id,
        projectId: projectSlug,
        taskid: act.taskid,
        nik: act.nik.trim(),
        action: act.action,
        details: act.details,
        createdAt: act.createdAt,
        user: act.user
          ? {
              nik: act.user.nik.trim(),
              nama: act.user.nama,
              photo: act.user.photo,
            }
          : null,
      })),
    };
  }

  // =========================================================
  // 🔹 ACTIVITY LOGGING
  // =========================================================

  async logActivity(
    params: {
      projectId: string;
      taskid?: string | null;
      nik: string;
      action: string;
      details?: Record<string, any> | string;
      createdAt?: Date;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<ActivityResponse | null> {
    try {
      const pid = (await this.resolveProjectId(params.projectId)) || params.projectId;
      const detailsStr =
        typeof params.details === 'object'
          ? JSON.stringify(params.details)
          : (params.details ?? null);
      const client = tx || this.prismaService;

      const created = await client.lOG_ACTIVITY.create({
        data: {
          projectId: pid,
          taskid: params.taskid ?? null,
          nik: params.nik,
          action: params.action,
          details: detailsStr,
          ...(params.createdAt ? { createdAt: params.createdAt } : {}),
        },
        include: {
          user: {
            select: {
              nik: true,
              nama: true,
              photo: true,
            },
          },
        },
      });

      const activityRes: ActivityResponse = {
        id: created.id,
        projectId: pid,
        taskid: created.taskid,
        nik: created.nik.trim(),
        action: created.action,
        details: created.details,
        createdAt: created.createdAt,
        user: created.user
          ? {
              nik: created.user.nik.trim(),
              nama: created.user.nama,
              photo: created.user.photo,
            }
          : null,
      };

      // Broadcast real-time activity to project room
      void this.projectGateway.broadcastToProject(pid, 'activity:created', activityRes);

      return activityRes;
    } catch (err: unknown) {
      this.logger.warn(`Failed to log activity: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getProjectActivities(projectId: string, limit: number = 50): Promise<ActivityResponse[]> {
    const pid = (await this.resolveProjectId(projectId)) || projectId;
    const activities = await this.prismaService.lOG_ACTIVITY.findMany({
      where: {
        projectId: pid,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: Math.min(Math.max(Number(limit) || 50, 1), 100),
      include: {
        user: {
          select: {
            nik: true,
            nama: true,
            photo: true,
          },
        },
      },
    });

    return activities.map((act) => ({
      id: act.id,
      projectId: pid,
      taskid: act.taskid,
      nik: act.nik.trim(),
      action: act.action,
      details: act.details,
      createdAt: act.createdAt,
      user: act.user
        ? {
            nik: act.user.nik.trim(),
            nama: act.user.nama,
            photo: act.user.photo,
          }
        : null,
    }));
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

  /** Trigger manual untuk daily digest / reminder email */
  async triggerDailyDigest() {
    return this.cronjobService.sendDailyTaskRemindersAndDigest();
  }

  private checkNotificationPref(prefsJson: string | null | undefined, key: string): boolean {
    if (!prefsJson) return true; // Default ON
    try {
      const parsed = JSON.parse(prefsJson);
      return parsed[key] !== false;
    } catch {
      return true;
    }
  }

  private async sendTaskAssignedEmailsAsync(
    targetNiks: string[],
    projectId: string,
    taskId: string,
    taskName: string,
    assignerNik: string,
    dueDate?: Date | null,
    isSubtask = false,
  ): Promise<void> {
    try {
      const [users, assignerUser, project] = await Promise.all([
        this.prismaService.dT_USER.findMany({
          where: { nik: { in: targetNiks } },
          select: { nik: true, nama: true, email: true, notificationPrefs: true },
        }),
        this.prismaService.dT_USER.findUnique({
          where: { nik: assignerNik },
          select: { nama: true },
        }),
        this.prismaService.dT_PROJECT.findUnique({
          where: { id: projectId },
          select: { name: true, shortId: true },
        }),
      ]);

      const projectName = project?.name || 'Project';
      const assignerName = assignerUser?.nama || assignerNik;
      const effectiveProjectId = project?.shortId || projectId;

      const pushType = isSubtask ? 'task.subtask_assigned' : 'task.assigned';
      const pushTitle = isSubtask ? 'Ditugaskan ke subtask' : 'Ditugaskan ke task';
      const taskUrl = `/dashboard/project/${effectiveProjectId}?task=${taskId}`;

      this.pushService.notifyUsers(targetNiks, {
        type: pushType,
        title: pushTitle,
        body: taskName,
        url: taskUrl,
      });

      for (const u of users) {
        if (!u.email) continue;
        if (!this.checkNotificationPref(u.notificationPrefs, 'emailTaskAssigned')) {
          this.logger.debug(`User ${u.nik} disabled emailTaskAssigned preference. Skipping email.`);
          continue;
        }

        await this.mailService.sendTaskAssignedEmail({
          to: u.email,
          taskId,
          taskName,
          projectId: effectiveProjectId,
          projectName,
          assignedByName: assignerName,
          dueDate,
          isSubtask,
        });
      }
    } catch (err) {
      this.logger.warn(`Failed sending task assigned emails: ${err}`);
    }
  }

  private async sendSubTaskAssignedEmailsAsync(
    subTaskId: string,
    insertedNiks: string[],
  ): Promise<void> {
    try {
      const subtask = await this.prismaService.dT_SUB_TASK.findUnique({
        where: { id: subTaskId },
        include: {
          task: {
            select: {
              id: true,
              shortId: true,
              name: true,
              id_dt_project: true,
              project: { select: { id: true, shortId: true, name: true } },
            },
          },
        },
      });

      if (!subtask?.task?.id_dt_project) return;

      await this.sendTaskAssignedEmailsAsync(
        insertedNiks,
        subtask.task.id_dt_project,
        subtask.task.shortId || subtask.task.id,
        subtask.name,
        subtask.createdBy || 'Lead',
        subtask.dueDate,
        true,
      );
    } catch (err) {
      this.logger.warn(`Failed sending subtask assigned emails: ${err}`);
    }
  }

  private async checkAndSendProjectCompletedEmailAsync(projectId: string): Promise<void> {
    try {
      const remainingIncomplete = await this.prismaService.dT_TASK.count({
        where: {
          id_dt_project: projectId,
          status: false,
        },
      });

      if (remainingIncomplete === 0) {
        const totalTasks = await this.prismaService.dT_TASK.count({
          where: { id_dt_project: projectId },
        });

        if (totalTasks > 0) {
          const [project, members] = await Promise.all([
            this.prismaService.dT_PROJECT.findUnique({
              where: { id: projectId },
              include: { user: { select: { email: true, notificationPrefs: true } } },
            }),
            this.prismaService.dT_MEMBER_PROJECT.findMany({
              where: { projectId },
              include: { user: { select: { email: true, notificationPrefs: true } } },
            }),
          ]);

          if (project) {
            const candidateUsers = [project.user, ...members.map((m) => m.user)].filter(Boolean);
            const allEmails = Array.from(
              new Set(
                candidateUsers
                  .filter(
                    (u) =>
                      u?.email &&
                      this.checkNotificationPref(u.notificationPrefs, 'emailProjectCompleted'),
                  )
                  .map((u) => u!.email!),
              ),
            );

            if (allEmails.length > 0) {
              await this.mailService.sendProjectCompletedEmail({
                to: allEmails,
                projectId: project.shortId || project.id,
                projectName: project.name,
                totalTasks,
              });
            }

            const memberNiks = members.map((m) => m.nik).filter(Boolean);
            const effectiveProjectId = project.shortId || project.id;
            this.pushService.notifyUsers(memberNiks, {
              type: 'project.completed',
              title: 'Project selesai',
              body: project.name,
              url: `/dashboard/project/${effectiveProjectId}`,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Failed checking project completion email: ${err}`);
    }
  }
}
