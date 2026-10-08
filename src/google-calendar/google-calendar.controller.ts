import {
  BadRequestException,
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
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../security/authGuard';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { GoogleCalendarService } from './google-calendar.service';
import { UpsertGoogleEventDto } from './dto/google-calendar.dto';

type AuthUser = { nik: string };

@Controller('api/google-calendar')
export class GoogleCalendarController {
  constructor(private readonly googleCal: GoogleCalendarService) {}

  @Get('status')
  @UseGuards(AuthGuard)
  async status(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.googleCal.getStatus(req.user!.nik);
      return new CommonResponse('Google Calendar status', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('connect')
  @UseGuards(AuthGuard)
  async connect(@Req() req: Request & { user?: AuthUser }) {
    try {
      const originHeader = req.headers.origin;
      const referer = req.headers.referer;
      let returnOrigin: string | undefined;
      if (typeof originHeader === 'string' && originHeader.trim()) {
        returnOrigin = originHeader.trim();
      } else if (typeof referer === 'string' && referer.trim()) {
        try {
          returnOrigin = new URL(referer).origin;
        } catch {
          /* ignore */
        }
      }
      const data = await this.googleCal.getConnectUrl(req.user!.nik, returnOrigin);
      return new CommonResponse('Google Calendar connect URL', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const returnOrigin = await this.googleCal.getReturnOriginFromState(state);
    try {
      if (error) {
        return res.redirect(
          this.googleCal.frontendRedirect(false, String(error), returnOrigin),
        );
      }
      const result = await this.googleCal.handleCallback(code, state);
      return res.redirect(
        this.googleCal.frontendRedirect(
          true,
          undefined,
          result.returnOrigin || returnOrigin,
        ),
      );
    } catch (e) {
      let msg = 'oauth_failed';
      if (e instanceof BadRequestException) {
        const resBody = e.getResponse();
        if (typeof resBody === 'string') msg = resBody;
        else if (resBody && typeof resBody === 'object') {
          const m = (resBody as { message?: string | string[] }).message;
          if (Array.isArray(m)) msg = m.join(', ');
          else if (typeof m === 'string') msg = m;
        }
      }
      return res.redirect(
        this.googleCal.frontendRedirect(false, msg, returnOrigin),
      );
    }
  }

  @Delete('connect')
  @UseGuards(AuthGuard)
  async disconnect(
    @Req() req: Request & { user?: AuthUser },
    @Query('email') email?: string,
  ) {
    try {
      if (!email?.trim()) {
        throw new BadRequestException('Query email wajib');
      }
      const data = await this.googleCal.disconnect(req.user!.nik, email);
      return new CommonResponse('Google Calendar disconnected', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('calendars')
  @UseGuards(AuthGuard)
  async calendars(@Req() req: Request & { user?: AuthUser }) {
    try {
      const data = await this.googleCal.getCalendars(req.user!.nik);
      return new CommonResponse('Google calendars', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Get('events')
  @UseGuards(AuthGuard)
  async events(
    @Req() req: Request & { user?: AuthUser },
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('calendarId') calendarId?: string,
    @Query('email') email?: string,
  ) {
    try {
      if (!start || !end) {
        throw new BadRequestException('Query start dan end (epoch ms) wajib');
      }
      const data = await this.googleCal.getEvents(req.user!.nik, {
        start: Number(start),
        end: Number(end),
        calendarId,
        email,
      });
      return new CommonResponse('Google Calendar events', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('sync-zimbra')
  @UseGuards(AuthGuard)
  async syncZimbra(
    @Req() req: Request & { user?: AuthUser },
    @Body()
    body: { start?: number; end?: number; googleEmail?: string },
  ) {
    try {
      if (body?.start == null || body?.end == null) {
        throw new BadRequestException('Body start dan end (epoch ms) wajib');
      }
      const data = await this.googleCal.syncFromZimbra(req.user!.nik, {
        start: Number(body.start),
        end: Number(body.end),
        googleEmail: body.googleEmail,
      });
      return new CommonResponse('Zimbra → Google sync', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Post('events')
  @UseGuards(AuthGuard)
  async createEvent(
    @Req() req: Request & { user?: AuthUser },
    @Body() dto: UpsertGoogleEventDto,
  ) {
    try {
      const data = await this.googleCal.createEvent(req.user!.nik, dto);
      return new CommonResponse('Google event created', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Patch('events/:eventId')
  @UseGuards(AuthGuard)
  async updateEvent(
    @Req() req: Request & { user?: AuthUser },
    @Param('eventId') eventId: string,
    @Body() dto: UpsertGoogleEventDto,
  ) {
    try {
      const data = await this.googleCal.updateEvent(req.user!.nik, eventId, dto);
      return new CommonResponse('Google event updated', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }

  @Delete('events/:eventId')
  @UseGuards(AuthGuard)
  async deleteEvent(
    @Req() req: Request & { user?: AuthUser },
    @Param('eventId') eventId: string,
    @Query('calendarId') calendarId?: string,
    @Query('email') email?: string,
  ) {
    try {
      const data = await this.googleCal.deleteEvent(req.user!.nik, {
        eventId,
        calendarId,
        email,
      });
      return new CommonResponse('Google event deleted', HttpStatus.OK, data);
    } catch (e) {
      return handleException(e);
    }
  }
}
