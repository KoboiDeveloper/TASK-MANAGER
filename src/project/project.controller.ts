// src/project/project.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
  Patch,
} from '@nestjs/common';
import { Request } from 'express';
import { ProjectService } from './project.service';
import {
  AddTaskDetailRequest,
  CreateProjectRequest,
  CreateTaskProjectRequest,
  UpdateTaskDetailRequest, UpdateTaskRequest,
} from './dto/request';
import { AuthGuard } from '../security/authGuard';
import { ProjectMemberGuard } from '../security/project-member.guard';
import { ProjectRoles } from '../security/project-roles.decorator';
import { EProjectRole } from '../constant/EProjectRole';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';

type AuthUser = {
  nik: string;
  nama: string;
  roleId: string | number;
};

@Controller('api/projects')
@UseGuards(AuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  // =========================================================
  // 🔹 PROJECT MANAGEMENT
  // =========================================================

  @Get()
  async getOwnProjects(@Req() req: Request & { user?: Pick<AuthUser, 'nik'> }) {
    try {
      const data = await this.projectService.ownProjects(req.user!.nik);
      return new CommonResponse('Get Own projects success', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get(':projectId')
  @UseGuards(ProjectMemberGuard)
  async findOne(@Param('projectId', ParseUUIDPipe) projectId: string) {
    try {
      const data = await this.projectService.findOne(projectId);
      return new CommonResponse('Get project success', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post()
  async create(
    @Body() dto: CreateProjectRequest,
    @Req() req: Request & { user?: Pick<AuthUser, 'nik'> },
  ) {
    try {
      const projectId = await this.projectService.create(req.user!.nik, dto);
      return new CommonResponse('Project created successfully', HttpStatus.CREATED, { projectId });
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 TASK MANAGEMENT
  // =========================================================

  @Put(':projectId/task/:taskId/move')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async moveTask(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body()
    body: {
      // semua opsional agar reorder in-place bisa terdeteksi di service
      targetSectionId?: string | null;
      beforeId?: string | null;
      afterId?: string | null;
    },
  ) {
    try {
      // Bangun payload SECARA KONDISIONAL (pakai operator 'in', bukan hasOwnProperty)
      const payload: {
        targetSectionId?: string | null;
        beforeId?: string | null;
        afterId?: string | null;
      } = {};

      if ('targetSectionId' in body) {
        // Normalisasi nilai spesial dari UI
        const raw = body.targetSectionId;
        payload.targetSectionId = raw === 'unlocated' || raw === 'null' ? null : (raw ?? null);
        // (prefix "section-" dan validasi UUID akan ditangani di service.normalizeGuid)
      }

      if ('beforeId' in body) {
        payload.beforeId = body.beforeId ?? null;
      }
      if ('afterId' in body) {
        payload.afterId = body.afterId ?? null;
      }

      const updated = await this.projectService.moveTask(projectId, taskId, payload);
      return new CommonResponse('Task moved successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
  @Post(':projectId/task')
  @UseGuards(ProjectMemberGuard)
  async createTask(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTaskProjectRequest,
    @Req() req: Request & { user?: Pick<AuthUser, 'nik' | 'nama' | 'roleId'> },
  ) {
    try {
      const taskId = await this.projectService.createTask(projectId, req.user!.nik, dto);
      return new CommonResponse('Task created successfully', HttpStatus.CREATED, { taskId });
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch('task/:taskId')
  @UseGuards(ProjectMemberGuard)
  async updateTask(
    @Req() _req: Request & { user?: AuthUser },
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body()
    data: UpdateTaskRequest,
  ) {
    try {
      const updated = await this.projectService.updateTask(taskId, data);
      return new CommonResponse('Task updated successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
  // =========================================================
  // 🔹 TASK DETAIL MANAGEMENT
  // =========================================================

  @Post('task/:taskId/detail')
  @UseGuards(ProjectMemberGuard)
  async addTaskDetail(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: AddTaskDetailRequest,
  ) {
    try {
      const detail = await this.projectService.addTaskDetail(taskId, dto);
      return new CommonResponse('Task detail added successfully', HttpStatus.CREATED, detail);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Put('task/detail/:detailId')
  @UseGuards(ProjectMemberGuard)
  async updateTaskDetail(
    @Param('detailId', ParseUUIDPipe) detailId: string,
    @Body() dto: UpdateTaskDetailRequest,
  ) {
    try {
      const updated = await this.projectService.updateTaskDetail(detailId, dto);
      return new CommonResponse('Task detail updated successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete('task/detail/:detailId')
  @UseGuards(ProjectMemberGuard)
  async deleteTaskDetail(@Param('detailId', ParseUUIDPipe) detailId: string) {
    try {
      const res = await this.projectService.deleteTaskDetail(detailId);
      return new CommonResponse(res.message, HttpStatus.OK, null);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 SECTION MANAGEMENT
  // =========================================================

  @Post(':projectId/section')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async addSection(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() data: { name: string },
  ) {
    try {
      const section = await this.projectService.createSection(projectId, data.name);
      return new CommonResponse('Add section successfully', HttpStatus.OK, section);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // ⛑️ Penting: jangan ParseUUIDPipe untuk sectionId di endpoint move
  @Put(':projectId/section/:sectionId/move')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async moveSection(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: { beforeId?: string | null; afterId?: string | null },
  ) {
    try {
      const updated = await this.projectService.moveSection(projectId, sectionId, {
        beforeId: body.beforeId ?? null,
        afterId: body.afterId ?? null,
      });
      return new CommonResponse('Section moved successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete(':projectId/section/:sectionId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER)
  async deleteSection(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
  ) {
    try {
      // sebaiknya pakai method service khusus; sementara minimal:
      const deleted = await this.projectService['prismaService'].dT_SECTION.delete({
        where: { id: sectionId },
        select: { id: true, name: true },
      });
      return new CommonResponse('Section deleted successfully', HttpStatus.OK, deleted);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/section/:sectionId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async renameSection(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() body: { name: string },
  ) {
    try {
      // sebaiknya pakai method service khusus; sementara minimal:
      const updated = await this.projectService.updateSection(sectionId, body.name);
      return new CommonResponse('Section renamed successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 READ BOARD
  // =========================================================

  @Get(':projectId/tasks')
  @UseGuards(ProjectMemberGuard)
  async findtasks(@Param('projectId', ParseUUIDPipe) projectId: string) {
    try {
      const tasks = await this.projectService.findTasksAndSections(projectId);
      return new CommonResponse('Get Tasks success', HttpStatus.OK, tasks);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}
