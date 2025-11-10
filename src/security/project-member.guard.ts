import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
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

    // ✅ 1️⃣ Pastikan user login
    const user = req.user;
    if (!user?.nik) {
      throw new ForbiddenException('User not authenticated');
    }

    // ✅ 2️⃣ Aman ambil param — kalau undefined, jangan error
    const params = req.params ?? {};
    const body = req.body ?? {};
    const query = req.query ?? {};

    // ✅ 3️⃣ Cari projectId dari berbagai sumber
    let projectId: string | null =
      (typeof params.projectId === 'string' && params.projectId) ||
      (typeof body.projectId === 'string' && body.projectId) ||
      (typeof query.projectId === 'string' && query.projectId) ||
      null;

    // ✅ 4️⃣ Kalau belum ketemu, cari via taskId
    if (!projectId && typeof params.taskId === 'string') {
      const task = await this.prisma.dT_TASK.findUnique({
        where: { id: params.taskId },
        select: { id_dt_project: true },
      });
      projectId = task?.id_dt_project ?? null;
    }

    // ✅ 5️⃣ Kalau belum juga, cari via subtaskId
    if (!projectId && typeof params.subtaskId === 'string') {
      const sub = await this.prisma.dT_SUB_TASK.findUnique({
        where: { id: params.subtaskId },
        select: { id_dt_task: true },
      });

      if (sub?.id_dt_task) {
        const task = await this.prisma.dT_TASK.findUnique({
          where: { id: sub.id_dt_task },
          select: { id_dt_project: true },
        });
        projectId = task?.id_dt_project ?? null;
      }
    }

    // ✅ 6️⃣ Kalau tetap nggak ketemu → tolak
    if (!projectId) {
      throw new ForbiddenException('Missing projectId in request');
    }

    // ✅ 7️⃣ Cek membership
    const member = await this.prisma.dT_MEMBER_PROJECT.findFirst({
      where: { projectId, nik: user.nik },
    });

    if (!member) {
      throw new ForbiddenException('Access denied: you are not a member of this project');
    }

    // ✅ 8️⃣ Cek role jika ada batasan
    if (requiredRoles?.length && !requiredRoles.includes(member.id_dt_project_role)) {
      throw new ForbiddenException('Access denied: insufficient role');
    }

    // ✅ 9️⃣ Simpan role ke req (opsional)
    req.projectRole = member.id_dt_project_role;
    return true;
  }
}
