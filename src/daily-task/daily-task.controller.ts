import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import multer from 'multer';
import { DailyTaskService } from './daily-task.service';
import { DailyTaskKpiService } from './daily-task-kpi.service';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AuthGuard } from '../security/authGuard';

type AuthRequest = Request & { user?: { nik: string } };

@UseGuards(AuthGuard)
@Controller('api/daily-task')
export class DailyTaskController {
  constructor(
    private readonly dailyTaskService: DailyTaskService,
    private readonly kpiService: DailyTaskKpiService,
  ) {}

  @Get('access')
  async access(@Req() request: AuthRequest) {
    try {
      const data = await this.kpiService.access(this.actor(request));
      return new CommonResponse('Daily task access', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('masters')
  async masters() {
    try {
      const data = await this.kpiService.masters();
      return new CommonResponse('Daily task masters', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Put('masters/methods')
  async saveMethod(@Req() request: AuthRequest, @Body() body: { id?: string; name: string; hint?: string; formula: string }) {
    try {
      const data = await this.kpiService.saveMethod(this.actor(request), body);
      return new CommonResponse('Metode disimpan', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Put('masters/categories')
  async saveCategory(@Req() request: AuthRequest, @Body() body: { id?: string; min: number; label: string }) {
    try {
      const data = await this.kpiService.saveCategory(this.actor(request), body);
      return new CommonResponse('Kategori disimpan', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('departments')
  async departments() {
    try {
      const data = await this.dailyTaskService.departments();
      return new CommonResponse('Daily task departments', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('departments/:id/employees')
  async employees(@Param('id') id: string) {
    try {
      const data = await this.dailyTaskService.employees(id);
      return new CommonResponse('Daily task employees', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('departments/:id/sheet')
  async sheet(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Query('nik') nik: string,
    @Query('month') month: string,
  ) {
    try {
      const data = await this.kpiService.sheet(this.actor(request), id, nik, month);
      return new CommonResponse('Daily task sheet', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('departments/:id/progress')
  async progress(@Param('id') id: string, @Query('month') month: string) {
    try {
      const data = await this.kpiService.progress(id, month);
      return new CommonResponse('Daily task progress', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Get('departments/:id/logs')
  async logs(@Param('id') id: string, @Query('nik') nik: string | undefined, @Query('month') month: string) {
    try {
      const data = await this.kpiService.logs(id, nik, month);
      return new CommonResponse('Daily task logs', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Post('departments/:id/kpis')
  async createKpi(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: { nik: string; month: string; title: string; weight: number; seasonal?: boolean; breakdown?: string[]; escalation?: string[]; targets: [] },
  ) {
    try {
      const data = await this.kpiService.createKpi(this.actor(request), id, body.nik, body.month, body);
      return new CommonResponse('KPI disimpan', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Patch('kpis/:id')
  async updateKpi(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: { departmentId: string; nik: string; month: string; title: string; weight: number; seasonal?: boolean; breakdown?: string[]; escalation?: string[]; targets: [] },
  ) {
    try {
      const data = await this.kpiService.updateKpi(this.actor(request), id, body.departmentId, body.nik, body.month, body);
      return new CommonResponse('KPI diperbarui', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Post('targets/:targetId/realisasi')
  async realisasi(
    @Req() request: AuthRequest,
    @Param('targetId') targetId: string,
    @Body() body: { departmentId: string; nik: string; month: string; realisasi: string },
  ) {
    try {
      const data = await this.kpiService.submitRealisasi(
        this.actor(request),
        body.departmentId,
        targetId,
        body.nik,
        body.month,
        body.realisasi,
      );
      return new CommonResponse('Realisasi disimpan', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  @Post('targets/:targetId/files')
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'files', maxCount: 10 }], {
      storage: multer.memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
    }),
  )
  async files(
    @Req() request: AuthRequest,
    @Param('targetId') targetId: string,
    @Body() body: { departmentId: string; nik: string; month: string; note?: string },
    @UploadedFiles() uploaded?: { files?: Express.Multer.File[] },
  ) {
    try {
      const data = await this.kpiService.submitFiles(
        this.actor(request),
        body.departmentId,
        targetId,
        body.nik,
        body.month,
        body.note ?? '',
        uploaded?.files ?? [],
      );
      return new CommonResponse('Task disimpan', HttpStatus.OK, data);
    } catch (error) {
      return handleException(error);
    }
  }

  private actor(request: AuthRequest) {
    return request.user?.nik ?? '';
  }
}
