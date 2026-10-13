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
  UploadedFile,
} from '@nestjs/common';
import { Request } from 'express';
import { ProjectService } from './project.service';
import {
  AddSubTaskRequest,
  CreateProjectRequest,
  CreateTaskCommentRequest,
  CreateTaskProjectRequest,
  CreateViewRequest,
  MemberRequest,
  MoveViewRequest,
  RemoveSectionParamsDto,
  RemoveSectionQueryDto,
  SyncSubTaskAssigneeRequest,
  ToggleTaskCommentReactionRequest,
  UpdateProjectRequest,
  UpdateSubTaskRequest,
  MoveSubTaskRequest,
  PromoteSubTaskRequest,
  DemoteTaskRequest,
  UpdateTaskRequest,
  UpdateViewRequest,
} from './dto/request';
import { AuthGuard } from '../security/authGuard';
import { ProjectMemberGuard } from '../security/project-member.guard';
import { ProjectRoles } from '../security/project-roles.decorator';
import { EProjectRole } from '../constant/EProjectRole';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AllowArchivedProject } from '../security/AllowArchivedProject.decorator';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { DT_USER } from '@prisma/client';
import { ownTaskResponse } from './dto/response';

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

  @Get('own-tasks')
  async getOwnTask(@Req() request: Request) {
    const user = request['user'] as DT_USER;
    try {
      const responseGetOwnTask: ownTaskResponse[] = await this.projectService.taskOwn(user.nik);
      return new CommonResponse('Get Own Tasks successfully', HttpStatus.OK, responseGetOwnTask);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

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
  async findOne(@Param('projectId') projectId: string) {
    try {
      const data = await this.projectService.findOne(projectId);
      return new CommonResponse('Get project success', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get(':projectId/activities')
  @UseGuards(ProjectMemberGuard)
  async getActivities(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    try {
      const data = await this.projectService.getProjectActivities(
        projectId,
        limit ? parseInt(limit, 10) : 50,
      );
      return new CommonResponse('Get project activities success', HttpStatus.OK, data);
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
    @Param('projectId') projectId: string,
    @Body() body: UpdateProjectRequest,
    @Req() req: Request & { user?: AuthUser },
  ) {
    const updateResponse: string = await this.projectService.updateProjectById(
      projectId,
      body,
      req.user?.nik,
    );
    return new CommonResponse('Project updated successfully', HttpStatus.OK, updateResponse);
  }

  @Delete('/:projectId/delete')
  @AllowArchivedProject()
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER)
  async deleteProject(@Param('projectId') projectId: string) {
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
    @Param('projectId') projectId: string,
    @Body() body: { members: MemberRequest[] },
    @Req() req: Request & { user?: Pick<AuthUser, 'nik'> },
  ): Promise<CommonResponse<{ nik: string; nama: string }[] | null>> {
    try {
      const finalMembers = await this.projectService.syncProjectMembers(
        projectId,
        body.members,
        req.user?.nik,
      );

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
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
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
    @Param('projectId') projectId: string,
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

  // ====== TASK COVER (header background) ======
  @Post('tasks/:taskId/cover')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  @UseInterceptors(
    FileInterceptor('cover', {
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadTaskCover(
    @Param('taskId') taskId: string,
    @UploadedFile() cover: Express.Multer.File,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.setTaskCover(taskId, cover, req.user?.nik);
      return new CommonResponse('Task cover uploaded successfully', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete('tasks/:taskId/cover')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteTaskCover(
    @Param('taskId') taskId: string,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.clearTaskCover(taskId, req.user?.nik);
      return new CommonResponse('Task cover removed successfully', HttpStatus.OK, data);
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
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const message = await this.projectService.AddTaskAttachments(
        taskId,
        attachments,
        req.user?.nik,
      );
      return new CommonResponse(message || 'Attachments uploaded successfully', HttpStatus.OK, {
        taskId,
        count: attachments?.length ?? 0,
      });
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get('tasks/:taskId/attachments')
  async getTaskAttachments(@Param('taskId') taskId: string) {
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

  // ====== TASK COMMENTS ======
  @Get('tasks/:taskId/comments')
  async listTaskComments(
    @Param('taskId') taskId: string,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.listTaskComments(taskId, req.user?.nik || '');
      return new CommonResponse('Get task comments successfully', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post('tasks/:taskId/comments')
  async createTaskComment(
    @Param('taskId') taskId: string,
    @Body() body: CreateTaskCommentRequest,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.createTaskComment(
        taskId,
        req.user?.nik || '',
        body,
      );
      return new CommonResponse('Comment created successfully', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post('comments/:commentId/reactions')
  async toggleTaskCommentReaction(
    @Param('commentId') commentId: string,
    @Body() body: ToggleTaskCommentReactionRequest,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.toggleTaskCommentReaction(
        commentId,
        req.user?.nik || '',
        body,
      );
      return new CommonResponse('Reaction updated successfully', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch('task/:taskId')
  @UseGuards(ProjectMemberGuard)
  async updateTask(
    @Req() _req: Request & { user?: AuthUser },
    @Param('taskId') taskId: string,
    @Body()
    data: UpdateTaskRequest,
  ) {
    try {
      const updated = await this.projectService.updateTask(taskId, data, _req.user?.nik);
      return new CommonResponse('Task updated successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete('tasks/:taskId/delete')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteTask(@Param('taskId') taskId: string, @Req() req: Request & { user?: AuthUser }) {
    try {
      const deleteTask = await this.projectService.deleteTaskId(taskId, req.user?.nik);
      return new CommonResponse('Task delete successfully', HttpStatus.OK, deleteTask);
    } catch (e: any) {
      return handleException(e?.message || String(e));
    }
  }

  // =========================================================
  // 🔹 TASK DETAIL MANAGEMENT
  // =========================================================

  @Post('task/:taskId/subtask')
  @UseGuards(ProjectMemberGuard)
  async addSubTask(
    @Param('taskId') taskId: string,
    @Body() dto: AddSubTaskRequest,
    @Req() req: Request & { user?: Pick<AuthUser, 'nik' | 'nama' | 'roleId'> },
  ) {
    try {
      const detail = await this.projectService.addSubTask(taskId, dto, req.user!.nik);
      return new CommonResponse('Task detail added successfully', HttpStatus.CREATED, detail);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Put('subtask/:subtaskId')
  @UseGuards(ProjectMemberGuard)
  async updateSubTask(
    @Param('subtaskId') subtaskId: string,
    @Body() dto: UpdateSubTaskRequest,
    @Req() req: Request & { user?: AuthUser },
  ) {
    const updated = await this.projectService.updateSubTask(subtaskId, dto, req.user?.nik);
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
  async moveSubTask(@Param('subtaskId') subtaskId: string, @Body() body: MoveSubTaskRequest) {
    const updated = await this.projectService.moveSubTask(subtaskId, body);
    return new CommonResponse('Subtask moved successfully', HttpStatus.OK, updated);
  }

  @Post(':projectId/subtask/:subtaskId/promote')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async promoteSubTask(
    @Param('projectId') projectId: string,
    @Param('subtaskId') subtaskId: string,
    @Body() body: PromoteSubTaskRequest,
  ) {
    try {
      const payload: PromoteSubTaskRequest = {};
      if ('targetSectionId' in body) {
        const raw = body.targetSectionId;
        payload.targetSectionId = raw === 'unlocated' || raw === 'null' ? null : (raw ?? null);
      }
      if ('beforeId' in body) payload.beforeId = body.beforeId ?? null;
      if ('afterId' in body) payload.afterId = body.afterId ?? null;

      const created = await this.projectService.promoteSubTask(projectId, subtaskId, payload);
      return new CommonResponse('Subtask promoted to task successfully', HttpStatus.OK, created);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post(':projectId/task/:taskId/demote')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async demoteTask(
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: DemoteTaskRequest,
  ) {
    try {
      const created = await this.projectService.demoteTask(projectId, taskId, body);
      return new CommonResponse('Task demoted to subtask successfully', HttpStatus.OK, created);
    } catch ({ message }) {
      return handleException(message as string);
    }
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
    @Param('projectId') projectId: string,
    @Body() data: { name: string; category?: string },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const section = await this.projectService.createSection(
        projectId,
        data.name,
        data.category,
        req.user?.nik,
      );
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
    @Param('projectId') projectId: string,
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
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const includeTask = query.includeTask ?? false;
      const deleted = await this.projectService.removeSection(
        {
          projectId,
          sectionId,
          includeTask,
        },
        req.user?.nik,
      );
      return new CommonResponse('Section deleted successfully', HttpStatus.OK, deleted);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/section/:sectionId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async renameSection(
    @Param('projectId') projectId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: { name?: string; category?: string },
  ) {
    try {
      const updated = await this.projectService.updateSection(sectionId, body);
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
  async findtasks(@Param('projectId') projectId: string, @Query('viewId') viewId?: string) {
    try {
      const tasks = await this.projectService.findTasksAndSections(projectId, viewId);
      return new CommonResponse('Get Tasks success', HttpStatus.OK, tasks);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // =========================================================
  // 🔹 VIEW MANAGEMENT
  // =========================================================

  @Get(':projectId/views')
  @UseGuards(ProjectMemberGuard)
  async getProjectViews(@Param('projectId') projectId: string) {
    try {
      const views = await this.projectService.getProjectViews(projectId);
      return new CommonResponse('Get project views success', HttpStatus.OK, views);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get(':projectId/view')
  @UseGuards(ProjectMemberGuard)
  async getProjectViewList(@Param('projectId') projectId: string) {
    try {
      const views = await this.projectService.getProjectViews(projectId);
      return new CommonResponse('Get project views success', HttpStatus.OK, views);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post(':projectId/view')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async createView(@Param('projectId') projectId: string, @Body() dto: CreateViewRequest) {
    try {
      const view = await this.projectService.createView(
        projectId,
        dto.name,
        dto.type,
        dto.settings,
      );
      return new CommonResponse('View created successfully', HttpStatus.CREATED, view);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  // ====== PROJECT GALLERY (items + multi-files + comments → Dropbox) ======
  @Get(':projectId/gallery')
  @UseGuards(ProjectMemberGuard)
  async listProjectGallery(@Param('projectId') projectId: string) {
    try {
      const items = await this.projectService.listProjectGalleryItems(projectId);
      return new CommonResponse('Get project gallery success', HttpStatus.OK, items);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get(':projectId/gallery/items/:itemId')
  @UseGuards(ProjectMemberGuard)
  async getProjectGalleryItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const item = await this.projectService.getProjectGalleryItem(
        projectId,
        itemId,
        req.user?.nik,
      );
      return new CommonResponse('Get gallery item success', HttpStatus.OK, item);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post(':projectId/gallery')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async uploadProjectGallery(
    @Param('projectId') projectId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Query('viewId') viewId: string | undefined,
    @Body()
    body: {
      title?: string;
      description?: string;
      notes?: string | string[];
      note?: string;
    },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      let notes: string[] | undefined;
      const rawNotes = body?.notes ?? body?.note;
      if (Array.isArray(rawNotes)) {
        notes = rawNotes.map((n) => String(n ?? ''));
      } else if (typeof rawNotes === 'string' && rawNotes.trim()) {
        try {
          const parsed = JSON.parse(rawNotes);
          notes = Array.isArray(parsed)
            ? parsed.map((n) => String(n ?? ''))
            : files?.map(() => rawNotes);
        } catch {
          notes = files?.map(() => rawNotes);
        }
      }

      const data = await this.projectService.createProjectGalleryItem(
        projectId,
        files,
        req.user?.nik || '',
        {
          title: body?.title || files?.[0]?.originalname || 'Untitled',
          description: body?.description,
          viewId,
          notes,
        },
      );
      return new CommonResponse('Gallery item created successfully', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/gallery/items/:itemId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async updateProjectGalleryItem(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() body: { title?: string; description?: string | null },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.updateProjectGalleryItem(
        projectId,
        itemId,
        body || {},
        req.user?.nik,
      );
      return new CommonResponse('Gallery item updated', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/gallery/files/:fileId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async updateProjectGalleryNote(
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Body() body: { note?: string | null },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const data = await this.projectService.updateProjectGalleryFileNote(
        projectId,
        fileId,
        body?.note ?? null,
        req.user?.nik,
      );
      return new CommonResponse('Gallery file note updated', HttpStatus.OK, data);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete(':projectId/gallery')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteProjectGallery(
    @Param('projectId') projectId: string,
    @Body() body: { ids?: string[] },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const message = await this.projectService.deleteProjectGalleryItems(
        projectId,
        body?.ids || [],
        req.user?.nik,
      );
      return new CommonResponse(message, HttpStatus.OK, { projectId, deletedIds: body?.ids || [] });
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get(':projectId/gallery/items/:itemId/comments')
  @UseGuards(ProjectMemberGuard)
  async listGalleryComments(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const comments = await this.projectService.listGalleryComments(
        projectId,
        itemId,
        req.user?.nik,
      );
      return new CommonResponse('Get gallery comments success', HttpStatus.OK, comments);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post(':projectId/gallery/items/:itemId/comments')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async createGalleryComment(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() body: { body?: string },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const comment = await this.projectService.createGalleryComment(
        projectId,
        itemId,
        body?.body || '',
        req.user?.nik || '',
      );
      return new CommonResponse('Gallery comment created', HttpStatus.OK, comment);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post(':projectId/gallery/items/:itemId/comments/:commentId/reactions')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async toggleGalleryCommentReaction(
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Param('commentId') commentId: string,
    @Body() body: { emoji?: string },
    @Req() req: Request & { user?: AuthUser },
  ) {
    try {
      const comment = await this.projectService.toggleGalleryCommentReaction(
        projectId,
        itemId,
        commentId,
        body?.emoji || '👍',
        req.user?.nik || '',
      );
      return new CommonResponse('Gallery reaction updated', HttpStatus.OK, comment);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/view/:viewId/move')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async moveView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @Body() dto: MoveViewRequest,
  ) {
    try {
      const moved = await this.projectService.moveView(projectId, viewId, dto);
      return new CommonResponse('View moved successfully', HttpStatus.OK, moved);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch(':projectId/view/:viewId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async updateView(
    @Param('projectId') projectId: string,
    @Param('viewId') viewId: string,
    @Body() dto: UpdateViewRequest,
  ) {
    try {
      const updated = await this.projectService.updateView(projectId, viewId, dto);
      return new CommonResponse('View updated successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete(':projectId/view/:viewId')
  @UseGuards(ProjectMemberGuard)
  @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
  async deleteView(@Param('projectId') projectId: string, @Param('viewId') viewId: string) {
    try {
      const res = await this.projectService.deleteView(projectId, viewId);
      return new CommonResponse('View deleted successfully', HttpStatus.OK, res);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post('cron/trigger-daily-digest')
  async triggerDailyDigest() {
    try {
      const result = await this.projectService.triggerDailyDigest();
      return new CommonResponse('Daily digest triggered successfully', HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}

