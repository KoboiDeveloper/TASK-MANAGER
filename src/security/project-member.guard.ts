import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
import { ALLOW_ARCHIVED_PROJECT_KEY } from './AllowArchivedProject.decorator';
import { Request } from 'express';

// =====================================================
// 🔹 AUTHENTICATED REQUEST TYPE
// =====================================================
interface AuthenticatedUser {
  nik: string;
  [key: string]: unknown;
}

interface ProjectRequest extends Request {
  user?: AuthenticatedUser;
  projectRole?: string;
  params: Record<string, string>;
  body: Record<string, any>;
  query: Record<string, any>;
}

// Helper: cek GUID (uniqueidentifier) valid
const GUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asGuidOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return GUID_REGEX.test(value) ? value : null;
}

// =====================================================
// 🔹 PROJECT MEMBER GUARD
// =====================================================
@Injectable()
export class ProjectMemberGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ProjectRequest>();

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const allowArchived = this.reflector.getAllAndOverride<boolean>(ALLOW_ARCHIVED_PROJECT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // ✅ 1️⃣ Pastikan user login
    const user = req.user;
    if (!user?.nik) {
      throw new ForbiddenException('User not authenticated');
    }

    // ✅ 2️⃣ Ambil param/body/query dengan aman
    const params = req.params ?? {};
    const body = req.body ?? {};
    const query = req.query ?? {};

    // ✅ 3️⃣ Cari projectId dari berbagai sumber (hanya kalau GUID valid)
    const candidateFromParams =
      asGuidOrNull(params.projectId) ?? asGuidOrNull(params.idProject) ?? asGuidOrNull(params.id);

    const candidateFromBody = asGuidOrNull(body.projectId) ?? asGuidOrNull(body.idProject);

    const candidateFromQuery = asGuidOrNull(query.projectId) ?? asGuidOrNull(query.idProject);

    let projectId: string | null =
      candidateFromParams || candidateFromBody || candidateFromQuery || null;

    // ✅ 4️⃣ Kalau belum ketemu, cari via taskId (yang valid GUID saja)
    const taskId = asGuidOrNull(params.taskId);
    if (!projectId && taskId) {
      const task = await this.prisma.dT_TASK.findUnique({
        where: { id: taskId }, // id di DB = uniqueidentifier, kita pastikan taskId sudah GUID
        select: { id_dt_project: true },
      });
      projectId = asGuidOrNull(task?.id_dt_project);
    }

    // ✅ 5️⃣ Kalau belum juga, cari via subtaskId (yang valid GUID saja)
    const subtaskId = asGuidOrNull(params.subtaskId);
    if (!projectId && subtaskId) {
      const sub = await this.prisma.dT_SUB_TASK.findUnique({
        where: { id: subtaskId },
        select: { id_dt_task: true },
      });

      const subTaskTaskId = asGuidOrNull(sub?.id_dt_task);
      if (subTaskTaskId) {
        const task = await this.prisma.dT_TASK.findUnique({
          where: { id: subTaskTaskId },
          select: { id_dt_project: true },
        });
        projectId = asGuidOrNull(task?.id_dt_project);
      }
    }

    // ✅ 6️⃣ Kalau tetap nggak ketemu / invalid → tolak sebelum kena Prisma
    if (!projectId) {
      throw new ForbiddenException('Missing or invalid projectId');
    }

    // ✅ 7️⃣ Cek project (hanya pakai projectId yang sudah terbukti GUID)
    const project = await this.prisma.dT_PROJECT.findFirst({
      where: {
        id: projectId,
        ...(allowArchived ? {} : { isArchive: false }),
      },
      select: {
        id: true,
        isArchive: true,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // ✅ 8️⃣ Cek membership
    const member = await this.prisma.dT_MEMBER_PROJECT.findFirst({
      where: { projectId, nik: user.nik },
    });

    const userRow = await this.prisma.dT_USER.findFirst({
      where: { nik: user.nik },
      select: { roleId: true },
    });
    const roleId = userRow?.roleId;

    // SUPER boleh akses tanpa jadi member
    if (roleId === 'SUPER') {
      return true;
    }

    if (!member) {
      throw new ForbiddenException('Access denied: you are not a member of this project');
    }

    // ✅ 9️⃣ Cek role jika ada batasan
    if (requiredRoles?.length && !requiredRoles.includes(member.id_dt_project_role)) {
      throw new ForbiddenException('Access denied: insufficient role');
    }

    // ✅ 🔟 Simpan role ke req (opsional)
    req.projectRole = member.id_dt_project_role;
    return true;
  }
}
