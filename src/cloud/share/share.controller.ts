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
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ShareService } from './share.service';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AccessShareLinkDto, CreateShareDto, CreateShareLinkDto } from './dto/share.dto';

@Controller('api/cloud/share')
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  @UseGuards(AuthGuard)
  @Get('people')
  async listPeople(
    @Req() req: Request,
    @Query('itemId') itemId: string,
    @Query('itemType') itemType: 'FILE' | 'FOLDER',
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.listShares(user.nik, itemId, itemType);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Post('people')
  async addPeople(@Req() req: Request, @Body() body: CreateShareDto) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.addShare(
        user.nik,
        body.itemId,
        body.itemType,
        body.targetNik,
        body.permission,
      );
      return new CommonResponse('Shared', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Delete('people/:id')
  async removePeople(@Req() req: Request, @Param('id') id: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.removeShare(user.nik, id);
      return new CommonResponse('Removed', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Get('links')
  async listLinks(
    @Req() req: Request,
    @Query('itemId') itemId: string,
    @Query('itemType') itemType: 'FILE' | 'FOLDER',
  ) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.listShareLinks(user.nik, itemId, itemType);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Post('links')
  async createLink(@Req() req: Request, @Body() body: CreateShareLinkDto) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.createShareLink(user.nik, body.itemId, body.itemType, {
        permission: body.permission,
        password: body.password,
        expiresAt: body.expiresAt,
      });
      return new CommonResponse('Link created', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Delete('links/:id')
  async revokeLink(@Req() req: Request, @Param('id') id: string) {
    try {
      const user = req['user'] as { nik: string };
      const data = await this.shareService.revokeShareLink(user.nik, id);
      return new CommonResponse('Revoked', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('public/:token')
  async publicGet(@Param('token') token: string, @Query('password') password?: string) {
    try {
      const data = await this.shareService.resolvePublicLink(token, password);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('public/:token')
  async publicPost(@Param('token') token: string, @Body() body: AccessShareLinkDto) {
    try {
      const data = await this.shareService.resolvePublicLink(token, body.password);
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }
}
