import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
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
  params: { [key: string]: string };
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
    const request = context.switchToHttp().getRequest<ProjectRequest>();
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // ✅ Pastikan user sudah login
    const user = request.user;
    if (!user?.nik) {
      throw new ForbiddenException('User not authenticated');
    }

    let resolvedProjectId: string | null =
      (typeof request.params?.projectId === 'string' && request.params.projectId) ||
      (typeof request.body?.projectId === 'string' && request.body.projectId) ||
      (typeof request.query?.projectId === 'string' && request.query.projectId) ||
      null;

    // 🧩 Handle kasus: akses task tanpa param projectId
    if (!resolvedProjectId && typeof request.params?.taskId === 'string') {
      const task = await this.prisma.dT_TASK.findUnique({
        where: { id: request.params.taskId },
        select: { id_dt_project: true },
      });

      resolvedProjectId = task?.id_dt_project ?? null;
    }

    if (!resolvedProjectId && request.params?.taskId) {
      const task = await this.prisma.dT_TASK.findUnique({
        where: { id: request.params.taskId },
        select: { id_dt_project: true },
      });
      resolvedProjectId = task?.id_dt_project ?? null;
    }

    if (!resolvedProjectId) {
      throw new ForbiddenException('Missing projectId in request');
    }

    // ✅ Cek membership user di project
    const member = await this.prisma.dT_MEMBER_PROJECT.findFirst({
      where: {
        projectId: resolvedProjectId,
        nik: user.nik,
      },
    });

    if (!member) {
      throw new ForbiddenException('Access denied: you are not a member of this project');
    }

    // ✅ Cek role (jika route butuh role tertentu)
    if (requiredRoles?.length && !requiredRoles.includes(member.id_dt_project_role)) {
      throw new ForbiddenException('Access denied: insufficient role');
    }

    // ✅ Simpan role ke request agar bisa dipakai di controller
    request.projectRole = member.id_dt_project_role;
    return true;
  }
}
