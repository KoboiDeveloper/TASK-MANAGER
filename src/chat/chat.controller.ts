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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { ChatService } from './chat.service';
import {
  AddMembersDto,
  CreateRoomDto,
  MarkReadDto,
  SendMessageDto,
  ToggleReactionDto,
  UpdateRoomDto,
} from './dto/chat.dto';

type AuthUser = { nik: string; nama?: string; roleId?: string };

@Controller('api/chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  private nik(req: Request & { user?: AuthUser }) {
    return req.user!.nik;
  }

  @Get('rooms')
  async getRooms(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.chatService.getRooms(this.nik(req));
      return new CommonResponse('Chat rooms', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('rooms')
  async createRoom(@Req() req: Request & { user?: AuthUser }, @Body() dto: CreateRoomDto) {
    try {
      const data = await this.chatService.createRoom(this.nik(req), dto);
      return new CommonResponse('Room created', HttpStatus.CREATED, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Patch('rooms/:id')
  async updateRoom(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: UpdateRoomDto,
  ) {
    try {
      const data = await this.chatService.updateRoom(this.nik(req), id, dto);
      return new CommonResponse('Room updated', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('rooms/:id/members')
  async addMembers(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: AddMembersDto,
  ) {
    try {
      const data = await this.chatService.addMembers(this.nik(req), id, dto);
      return new CommonResponse('Members added', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Delete('rooms/:id/members/me')
  async leaveRoom(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    try {
      await this.chatService.leaveRoom(this.nik(req), id);
      return new CommonResponse('Left room', HttpStatus.OK, null);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Get('rooms/:id/messages')
  async getMessages(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const data = await this.chatService.getMessages(
        this.nik(req),
        id,
        cursor,
        limit ? Number(limit) : 50,
      );
      return new CommonResponse('Messages', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('rooms/:id/messages')
  async sendMessage(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    try {
      const data = await this.chatService.sendMessage(this.nik(req), id, dto);
      return new CommonResponse('Message sent', HttpStatus.CREATED, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('rooms/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachment(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    try {
      const data = await this.chatService.uploadAttachment(this.nik(req), id, file);
      return new CommonResponse('Attachment uploaded', HttpStatus.CREATED, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Delete('messages/:id')
  async deleteMessage(@Req() req: Request & { user?: AuthUser }, @Param('id') id: string) {
    try {
      await this.chatService.deleteMessage(this.nik(req), id);
      return new CommonResponse('Message deleted', HttpStatus.OK, null);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Patch('rooms/:id/read')
  async markRead(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: MarkReadDto,
  ) {
    try {
      await this.chatService.markRead(this.nik(req), id, dto);
      return new CommonResponse('Marked read', HttpStatus.OK, null);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('messages/:id/reactions')
  async toggleReaction(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Body() dto: ToggleReactionDto,
  ) {
    try {
      const data = await this.chatService.toggleReaction(this.nik(req), id, dto);
      return new CommonResponse('Reaction updated', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Post('rooms/:id/pinned-tasks/:taskId')
  async pinTask(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Param('taskId') taskId: string,
  ) {
    try {
      const data = await this.chatService.pinTask(this.nik(req), id, taskId);
      return new CommonResponse('Task pinned', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Delete('rooms/:id/pinned-tasks/:taskId')
  async unpinTask(
    @Req() req: Request & { user?: AuthUser },
    @Param('id') id: string,
    @Param('taskId') taskId: string,
  ) {
    try {
      const data = await this.chatService.unpinTask(this.nik(req), id, taskId);
      return new CommonResponse('Task unpinned', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }
}
