import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { extname } from 'path';
import type { Request, Response } from 'express';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { MailboxService } from './mailbox.service';
import {
  ConnectMailboxDto,
  FromAmsDriveAttachmentDto,
  FromGdriveAttachmentDto,
  MessageActionDto,
  SaveSignatureDto,
  SendMessageDto,
  SetActiveMailboxDto,
  CreateMailboxEventDto,
} from './dto/mailbox.dto';
import { MulterExceptionFilter } from './multer-exception.filter';

type AuthUser = { nik: string };

@Controller('api/mailbox')
@UseGuards(AuthGuard)
export class MailboxController {
  constructor(private readonly mailbox: MailboxService) {}

  @Get('status')
  async status(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getStatus(req.user!.nik);
      return new CommonResponse('Mailbox status', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('connect')
  async connect(@Req() req: Request & { user?: AuthUser }, @Body() dto: ConnectMailboxDto) {
    try {
      const data = await this.mailbox.connect(req.user!.nik, dto);
      return new CommonResponse('Mailbox connected', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Delete('connect')
  async disconnect(
    @Req() req: Request & { user?: AuthUser },
    @Query('email') email?: string,
  ) {
    try {
      if (!email?.trim()) {
        throw new BadRequestException('Query email wajib');
      }
      const data = await this.mailbox.disconnect(req.user!.nik, email);
      return new CommonResponse('Mailbox disconnected', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Put('active')
  async setActive(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: SetActiveMailboxDto,
  ) {
    try {
      const data = await this.mailbox.setActive(req.user!.nik, dto.email);
      return new CommonResponse('Active mailbox updated', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }


  @Get('calendars')
  async calendars(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getCalendars(req.user!.nik);
      return new CommonResponse('Calendars', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('google/picker-config')
  async pickerConfig(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getGooglePickerConfig(req.user!.nik);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('google/drive/list')
  async listGoogleDrive(
    @Req() req: Request & { user?: AuthUser },
    @Query('email') email?: string,
    @Query('folderId') folderId?: string,
    @Query('mode') mode?: string,
  ) {
    try {
      const allowed = ['my', 'shared', 'recent', 'starred', 'trash'] as const;
      const m = allowed.includes(mode as (typeof allowed)[number])
        ? (mode as (typeof allowed)[number])
        : 'my';
      const data = await this.mailbox.listGoogleDrive(req.user!.nik, {
        email,
        folderId: folderId || null,
        mode: m,
      });
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('events')
  async events(
    @Req() req: Request & { user?: AuthUser },
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('folderId') folderId?: string,
  ) {
    try {
      if (!start || !end) {
        throw new BadRequestException('Query start dan end (epoch ms) wajib');
      }
      const data = await this.mailbox.getEvents(req.user!.nik, {
        start: Number(start),
        end: Number(end),
        folderId,
      });
      return new CommonResponse('Events', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }


  @Post('events')
  async createEvent(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: CreateMailboxEventDto,
  ) {
    try {
      const data = await this.mailbox.createEvent(req.user!.nik, dto);
      return new CommonResponse('Event created', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('folders')
  async folders(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getFolders(req.user!.nik);
      return new CommonResponse('Folders', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('messages')
  async messages(
    @Req() req: Request & { user?: AuthUser },
    @Query('folderId') folderId?: string,
    @Query('query') query?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    try {
      const data = await this.mailbox.searchMessages(req.user!.nik, {
        folderId,
        query,
        offset: offset ? Number(offset) : 0,
        limit: limit ? Number(limit) : 50,
        pageToken: pageToken?.trim() || undefined,
      });
      return new CommonResponse('Messages', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('messages/:id')
  async message(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    try {
      const data = await this.mailbox.getMessage(req.user!.nik, id);
      return new CommonResponse('Message', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('messages/send')
  async send(@Req() req: Request & { user?: AuthUser }, @Body() dto: SendMessageDto) {
    try {
      const data = await this.mailbox.sendMessage(req.user!.nik, dto);
      return new CommonResponse('Sent', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('messages/draft')
  async draft(@Req() req: Request & { user?: AuthUser }, @Body() dto: SendMessageDto) {
    try {
      const data = await this.mailbox.saveDraft(req.user!.nik, dto);
      return new CommonResponse('Draft saved', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('messages/:id/action')
  async action(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: MessageActionDto,
  ) {
    try {
      const data = await this.mailbox.messageAction(req.user!.nik, id, dto);
      return new CommonResponse('Action ok', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('autocomplete')
  async autocomplete(@Req() req: Request & { user?: AuthUser }, @Query('q') q?: string) {
    try {
      const data = await this.mailbox.autocomplete(req.user!.nik, q || '');
      return new CommonResponse('Autocomplete', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('tags')
  async tags(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getTags(req.user!.nik);
      return new CommonResponse('Tags', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('signatures')
  async signatures(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getSignatures(req.user!.nik);
      return new CommonResponse('Signatures', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Put('signatures')
  async saveSignature(@Req() req: Request & { user?: AuthUser }, @Body() dto: SaveSignatureDto) {
    try {
      const data = await this.mailbox.saveSignature(req.user!.nik, dto);
      return new CommonResponse('Signature saved', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/from-gdrive')
  async fromGdrive(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: FromGdriveAttachmentDto,
  ) {
    try {
      const data = await this.mailbox.importGdriveAttachment(
        req.user!.nik,
        dto.fileId,
      );
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/from-ams-drive')
  async fromAmsDrive(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: FromAmsDriveAttachmentDto,
  ) {
    try {
      const data = await this.mailbox.importAmsDriveAttachment(
        req.user!.nik,
        dto.fileId,
      );
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/gdrive-to-ams-drive')
  async gdriveToAmsDrive(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: FromGdriveAttachmentDto,
  ) {
    try {
      const data = await this.mailbox.saveGdriveFileToAmsDrive(
        req.user!.nik,
        dto.fileId,
      );
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments')
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').slice(0, 32);
          cb(null, `mailbox-up-${Date.now()}-${randomUUID()}${ext}`);
        },
      }),
      // Large attachments up to 2GB (Zimbra Dropbox / Gmail Drive thresholds in service)
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: Request & { user?: AuthUser },
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file: Express.Multer.File,
    @Body('expiresAt') expiresAt?: string,
    @Body('password') password?: string,
    @Body('shareMode') shareMode?: string,
  ) {
    // Refresh / tutup tab / abort XHR → hentikan Dropbox di tengah jalan.
    // Pakai res.close (bukan req.close): req.close sering ikut setelah body multer selesai
    // padahal klien masih menunggu response.
    const ac = new AbortController();
    let settled = false;
    const onClientGone = () => {
      if (settled || ac.signal.aborted) return;
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClientGone);
    req.on('aborted', onClientGone);
    try {
      const data = await this.mailbox.uploadAttachment(req.user!.nik, file, {
        expiresAt,
        password,
        shareMode:
          shareMode === 'restricted' || shareMode === 'anyone'
            ? shareMode
            : undefined,
        signal: ac.signal,
      });
      settled = true;
      return new CommonResponse('Uploaded', HttpStatus.OK, data);
    } catch (e) {
      settled = true;
      return handleException(e);
    } finally {
      settled = true;
      res.off('close', onClientGone);
      req.off('aborted', onClientGone);
    }
  }

  /** Prefer query `part` — Gmail attachmentId terlalu panjang untuk path segment. */
  @Post('attachments/:messageId/to-ams-drive')
  async saveAttachmentToAmsDriveQuery(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Query('part') part: string,
  ) {
    try {
      if (!part?.trim()) throw new BadRequestException('part wajib');
      const data = await this.mailbox.saveAttachmentToAmsDrive(
        req.user!.nik,
        messageId,
        part,
      );
      return new CommonResponse('Saved to AMS Drive', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/:messageId/to-drive')
  async saveAttachmentToDriveQuery(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Query('part') part: string,
  ) {
    try {
      if (!part?.trim()) throw new BadRequestException('part wajib');
      const data = await this.mailbox.saveAttachmentToDrive(
        req.user!.nik,
        messageId,
        part,
      );
      return new CommonResponse('Saved to Drive', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/:messageId/:part/to-ams-drive')
  async saveAttachmentToAmsDrive(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Param('part') part: string,
  ) {
    try {
      const data = await this.mailbox.saveAttachmentToAmsDrive(
        req.user!.nik,
        messageId,
        part,
      );
      return new CommonResponse('Saved to AMS Drive', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  /** Alias lama — FE baru memakai to-ams-drive. */
  @Post('attachments/:messageId/:part/to-dropbox')
  async saveAttachmentToDropbox(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Param('part') part: string,
  ) {
    try {
      const data = await this.mailbox.saveAttachmentToAmsDrive(
        req.user!.nik,
        messageId,
        part,
      );
      return new CommonResponse('Saved to AMS Drive', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('attachments/:messageId/:part/to-drive')
  async saveAttachmentToDrive(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Param('part') part: string,
  ) {
    try {
      const data = await this.mailbox.saveAttachmentToDrive(
        req.user!.nik,
        messageId,
        part,
      );
      return new CommonResponse('Saved to Drive', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('attachments/:messageId')
  async downloadQuery(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Query('part') part: string,
    @Query('download') downloadQuery: string,
    @Res() res: Response,
  ) {
    try {
      if (!part?.trim()) throw new BadRequestException('part wajib');
      const file = await this.mailbox.downloadAttachment(req.user!.nik, messageId, part);
      res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
      const isInline = file.contentType?.startsWith('image/') || file.contentType?.startsWith('text/');
      const disposition = downloadQuery === '1' || !isInline ? 'attachment' : 'inline';
      if (file.filename) {
        res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.filename)}"`);
      } else {
        res.setHeader('Content-Disposition', disposition);
      }
      res.send(file.buffer);
    } catch (e) {
      res.status(400).json(handleException(e));
    }
  }

  @Get('attachments/:messageId/:part')
  async download(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Param('part') part: string,
    @Query('download') downloadQuery: string,
    @Res() res: Response,
  ) {
    try {
      const file = await this.mailbox.downloadAttachment(req.user!.nik, messageId, part);
      res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
      const isInline = file.contentType?.startsWith('image/') || file.contentType?.startsWith('text/');
      const disposition = downloadQuery === '1' || !isInline ? 'attachment' : 'inline';
      if (file.filename) {
        res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.filename)}"`);
      } else {
        res.setHeader('Content-Disposition', disposition);
      }
      res.send(file.buffer);
    } catch (e) {
      res.status(400).json(handleException(e));
    }
  }
}
