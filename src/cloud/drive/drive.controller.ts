import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { DriveService } from './drive.service';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import {
  CreateFolderDto,
  DescriptionDto,
  MoveDto,
  RenameDto,
  StarDto,
} from './dto/drive.dto';

@Controller('api/cloud/drive')
@UseGuards(AuthGuard)
export class DriveController {
  constructor(private readonly driveService: DriveService) {}

  @Get('quota')
  async quota(@Req() req: Request) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.getQuota(user.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('list')
  async list(@Req() req: Request, @Query('folderId') folderId?: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.listMyDrive(user.nik, folderId || null);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('shared')
  async shared(@Req() req: Request) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.listSharedWithMe(user.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('recent')
  async recent(@Req() req: Request) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.listRecent(user.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('starred')
  async starred(@Req() req: Request) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.listStarred(user.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('trash')
  async trashList(@Req() req: Request) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.listTrash(user.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('breadcrumb')
  async breadcrumb(@Req() req: Request, @Query('folderId') folderId?: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.getBreadcrumb(user.nik, folderId || null);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('item/:itemType/:id')
  async getItem(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.getItem(user.nik, id, itemType);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('folders')
  async createFolder(@Req() req: Request, @Body() body: CreateFolderDto) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.createFolder(user.nik, body.name, body.parentId);
      return new CommonResponse('Folder created', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) => {
          cb(null, `cs-upload-${randomUUID()}-${file.originalname}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Query('folderId') folderId?: string,
  ) {
    try {
      if (!file) throw new Error('File is required');
      const user = req['user'] as { nik: string };
      const localPath = (file as any).path || join(file.destination || tmpdir(), file.filename);
      const data = await this.driveService.uploadFile(user.nik, file, folderId, localPath);
      return new CommonResponse('Uploaded', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('download/:id')
  async download(@Req() req: Request, @Param('id') id: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.getDownloadUrl(user.nik, id);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  /** Inline file stream for Quick View (PDF/image/etc) — does not trigger browser download. */
  @Get('preview/:id')
  async preview(
    @Req() req: Request,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const { buffer, name, mimeType } = await this.driveService.getPreviewBuffer(user.nik, id);
      const safeName = name.replace(/[^\w.\- ()[\]]+/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.setHeader('Content-Length', buffer.length);
      return new StreamableFile(buffer);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':itemType/:id/rename')
  async rename(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
    @Body() body: RenameDto,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.rename(user.nik, id, itemType, body.name);
      return new CommonResponse('Renamed', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':itemType/:id/move')
  async move(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
    @Body() body: MoveDto,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.move(user.nik, id, itemType, body.folderId);
      return new CommonResponse('Moved', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':itemType/:id/star')
  async star(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
    @Body() body: StarDto,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.setStarred(user.nik, id, itemType, body.starred);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':itemType/:id/description')
  async description(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
    @Body() body: DescriptionDto,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.setDescription(
        user.nik,
        id,
        itemType,
        body.description,
      );
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('files/:id/copy')
  async copy(@Req() req: Request, @Param('id') id: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.copyFileFull(user.nik, id);
      return new CommonResponse('Copied', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post(':itemType/:id/trash')
  async trash(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.trash(user.nik, id, itemType);
      return new CommonResponse('Moved to trash', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post(':itemType/:id/restore')
  async restore(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.restore(user.nik, id, itemType);
      return new CommonResponse('Restored', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Delete(':itemType/:id')
  async permanentDelete(
    @Req() req: Request,
    @Param('itemType') itemType: 'FILE' | 'FOLDER',
    @Param('id') id: string,
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.driveService.permanentDelete(user.nik, id, itemType);
      return new CommonResponse('Deleted', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }
}
