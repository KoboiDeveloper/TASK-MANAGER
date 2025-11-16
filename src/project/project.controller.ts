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
  Query,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { Request } from 'express';
import { ProjectService } from './project.service';
import {
  AddSubTaskRequest,
  CreateProjectRequest,
  CreateTaskProjectRequest,
  MemberRequest,
  RemoveSectionParamsDto,
  RemoveSectionQueryDto,
  SyncSubTaskAssigneeRequest,
  UpdateProjectRequest,
  UpdateSubTaskRequest,
  UpdateTaskRequest,
} from './dto/request';
import { AuthGuard } from '../security/authGuard';
import { ProjectMemberGuard } from '../security/project-member.guard';
import { ProjectRoles } from '../security/project-roles.decorator';
import { EProjectRole } from '../constant/EProjectRole';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AllowArchivedProject } from '../security/AllowArchivedProject.decorator';
import { FilesInterceptor } from '@nestjs/platform-express';

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
  async getOwnProjects(@Req() req: Request & { user?: Pick<AuthUser, 'nik' | 'roleId'> }) {
    try {
      const roleId = req.user?.roleId ? String(req.user.roleId) : undefined;
      const data = await this.projectService.ownProjects(req.user!.nik, roleId);
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

  @Patch(':projectId/update')
  @AllowArchivedProject()
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER)
  async updateProject(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: UpdateProjectRequest,
  ) {
    const updateResponse: string = await this.projectService.updateProjectById(projectId, body);
    return new CommonResponse('Project updated successfully', HttpStatus.OK, updateResponse);
  }

  @Delete('/:projectId/delete')
  @AllowArchivedProject()
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER)
  async deleteProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    try {
      const deleteProject = await this.projectService.deleteProjectById(projectId);
      return new CommonResponse('Project deleted successfully', HttpStatus.OK, deleteProject);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 MEMBER MANAGEMENT
  // =========================================================

  @Patch(':projectId/members')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER)
  async syncProjectMembers(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: { members: MemberRequest[] },
  ): Promise<CommonResponse<{ nik: string; nama: string }[] | null>> {
    try {
      const finalMembers = await this.projectService.syncProjectMembers(projectId, body.members);

      return new CommonResponse('Project members synced successfully', HttpStatus.OK, finalMembers);
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

  // ====== UPLOAD / TAMBAH ATTACHMENT KE TASK ======
  @Post('tasks/:taskId/attachments')
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  @UseInterceptors(FilesInterceptor('attachments', 10)) // field name: attachments
  async uploadTaskAttachments(
    @Param('taskId') taskId: string,
    @UploadedFiles() attachments: Express.Multer.File[],
  ) {
    try {
      const message = await this.projectService.AddTaskAttachments(taskId, attachments);
      return new CommonResponse(message || 'Attachments uploaded successfully', HttpStatus.OK, {
        taskId,
        count: attachments?.length ?? 0,
      });
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get('tasks/:taskId/attachments')
  async getTaskAttachments(@Param('taskId', new ParseUUIDPipe()) taskId: string) {
    try {
      const attachmentsTask = await this.projectService.getTaskAttachments(taskId);
      return new CommonResponse(
        'get Attachment by TaskId Successfully',
        HttpStatus.OK,
        attachmentsTask,
      );
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // ====== DELETE ATTACHMENT BULK DARI TASK ======
  @Delete('tasks/:taskId/attachments')
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteTaskAttachments(@Param('taskId') taskId: string, @Body() body: { id: string[] }) {
    try {
      const message = await this.projectService.deleteTaskAttachments(taskId, body.id);

      return new CommonResponse(message || 'Attachments deleted successfully', HttpStatus.OK, {
        taskId,
        deletedIds: body.id,
      });
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

  @Delete('tasks/:taskId/delete')
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteTask(@Param('taskId', ParseUUIDPipe) taskId: string) {
    try {
      const deleteTask = await this.projectService.deleteTaskId(taskId);
      return new CommonResponse('Task delete successfully', HttpStatus.OK, deleteTask);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 TASK DETAIL MANAGEMENT
  // =========================================================

  @Post('task/:taskId/subtask')
  @UseGuards(ProjectMemberGuard)
  async addSubTask(@Param('taskId') taskId: string, @Body() dto: AddSubTaskRequest) {
    try {
      const detail = await this.projectService.addSubTask(taskId, dto);
      return new CommonResponse('Task detail added successfully', HttpStatus.CREATED, detail);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Put('subtask/:subtaskId')
  @UseGuards(ProjectMemberGuard)
  async updateSubTask(@Param('subtaskId') subtaskId: string, @Body() dto: UpdateSubTaskRequest) {
    const updated = await this.projectService.updateSubTask(subtaskId, dto);
    return new CommonResponse('Subtask updated successfully', HttpStatus.OK, updated);
  }

  @Delete('subtask/:subtaskId')
  @UseGuards(ProjectMemberGuard)
  async deleteSubTask(@Param('subtaskId') subtaskId: string) {
    const res = await this.projectService.deleteSubTask(subtaskId);
    return new CommonResponse(res.message, HttpStatus.OK, null);
  }

  @Patch('subtask/:subtaskId/move')
  @UseGuards(ProjectMemberGuard)
  async moveSubTask(
    @Param('subtaskId') subtaskId: string,
    @Body() body: { beforeId?: string | null; afterId?: string | null },
  ) {
    const updated = await this.projectService.moveSubTask(subtaskId, body);
    return new CommonResponse('Subtask moved successfully', HttpStatus.OK, updated);
  }

  @Patch('tasks/:taskId/subtasks/:subTaskId/assignees')
  async syncSubTaskAssignees(
    @Param('taskId') taskId: string,
    @Param('subTaskId') subTaskId: string,
    @Body() body: SyncSubTaskAssigneeRequest,
  ): Promise<CommonResponse<string | null>> {
    try {
      const syncSubTaskAssignees = await this.projectService.syncSubTaskAssignees(
        taskId,
        subTaskId,
        body,
      );
      return new CommonResponse(
        'Sync Assignee subtask successfully',
        HttpStatus.OK,
        syncSubTaskAssignees,
      );
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
    @Param() { projectId, sectionId }: RemoveSectionParamsDto,
    @Query() query: RemoveSectionQueryDto,
  ) {
    try {
      const includeTask = query.includeTask ?? false;
      const deleted = await this.projectService.removeSection({
        projectId,
        sectionId,
        includeTask,
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
