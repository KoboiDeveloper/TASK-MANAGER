import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { PushService } from './push.service';
import { SubscribePushDto, UnsubscribePushDto } from './dto/subscribe-push.dto';

type AuthUser = { nik: string };

@Controller('api/push')
export class NotificationsController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key')
  getVapid() {
    const key = this.push.getPublicKey();
    return new CommonResponse('VAPID public key', HttpStatus.OK, { publicKey: key });
  }

  @Post('subscribe')
  @UseGuards(AuthGuard)
  async subscribe(@Req() req: Request & { user?: AuthUser }, @Body() dto: SubscribePushDto) {
    try {
      const data = await this.push.subscribe(req.user!.nik, {
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent,
      });
      return new CommonResponse('Subscribed', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }

  @Delete('subscribe')
  @UseGuards(AuthGuard)
  async unsubscribe(@Req() req: Request & { user?: AuthUser }, @Body() dto: UnsubscribePushDto) {
    try {
      const data = await this.push.unsubscribe(req.user!.nik, dto.endpoint);
      return new CommonResponse('Unsubscribed', HttpStatus.OK, data);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }
}
