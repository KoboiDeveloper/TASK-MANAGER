import {
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
  MessageActionDto,
  SaveSignatureDto,
  SendMessageDto,
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
  async disconnect(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.disconnect(req.user!.nik);
      return new CommonResponse('Mailbox disconnected', HttpStatus.OK, data);
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
  ) {
    try {
      const data = await this.mailbox.searchMessages(req.user!.nik, {
        folderId,
        query,
        offset: offset ? Number(offset) : 0,
        limit: limit ? Number(limit) : 50,
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
      // Dropbox large attachments up to 2GB (Zimbra path still capped in service at 5MB)
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: Request & { user?: AuthUser },
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file: Express.Multer.File,
    @Body('expiresAt') expiresAt?: string,
    @Body('password') password?: string,
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
