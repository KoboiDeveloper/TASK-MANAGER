import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { MailboxService } from './mailbox.service';
import { ConnectMailboxDto, MessageActionDto, SendMessageDto } from './dto/mailbox.dto';

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
      return handleException((e as Error).message);
    }
  }

  @Post('connect')
  async connect(@Req() req: Request & { user?: AuthUser }, @Body() dto: ConnectMailboxDto) {
    try {
      const data = await this.mailbox.connect(req.user!.nik, dto);
      return new CommonResponse('Mailbox connected', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Delete('connect')
  async disconnect(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.disconnect(req.user!.nik);
      return new CommonResponse('Mailbox disconnected', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Get('folders')
  async folders(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getFolders(req.user!.nik);
      return new CommonResponse('Folders', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
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
      return handleException((e as Error).message);
    }
  }

  @Get('messages/:id')
  async message(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    try {
      const data = await this.mailbox.getMessage(req.user!.nik, id);
      return new CommonResponse('Message', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('messages/send')
  async send(@Req() req: Request & { user?: AuthUser }, @Body() dto: SendMessageDto) {
    try {
      const data = await this.mailbox.sendMessage(req.user!.nik, dto);
      return new CommonResponse('Sent', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('messages/draft')
  async draft(@Req() req: Request & { user?: AuthUser }, @Body() dto: SendMessageDto) {
    try {
      const data = await this.mailbox.saveDraft(req.user!.nik, dto);
      return new CommonResponse('Draft saved', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
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
      return handleException((e as Error).message);
    }
  }

  @Get('autocomplete')
  async autocomplete(@Req() req: Request & { user?: AuthUser }, @Query('q') q?: string) {
    try {
      const data = await this.mailbox.autocomplete(req.user!.nik, q || '');
      return new CommonResponse('Autocomplete', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Get('tags')
  async tags(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.mailbox.getTags(req.user!.nik);
      return new CommonResponse('Tags', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: Request & { user?: AuthUser },
    @UploadedFile() file: Express.Multer.File,
  ) {
    try {
      const data = await this.mailbox.uploadAttachment(req.user!.nik, file);
      return new CommonResponse('Uploaded', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Get('attachments/:messageId/:part')
  async download(
    @Req() req: Request & { user?: AuthUser },
    @Param('messageId') messageId: string,
    @Param('part') part: string,
    @Res() res: Response,
  ) {
    try {
      const file = await this.mailbox.downloadAttachment(req.user!.nik, messageId, part);
      res.setHeader('Content-Type', file.contentType);
      if (file.filename) {
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      }
      res.send(file.buffer);
    } catch (e) {
      const msg = (e as Error).message;
      res.status(400).json(handleException(msg));
    }
  }
}
