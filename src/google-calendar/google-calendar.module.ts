import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { MailboxModule } from '../mailbox/mailbox.module';
import { GoogleCalendarController } from './google-calendar.controller';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleOAuthClient } from './google-oauth.client';

@Module({
  imports: [PrismaModule, MailboxModule, JwtModule.register({})],
  controllers: [GoogleCalendarController],
  providers: [GoogleCalendarService, GoogleOAuthClient],
  exports: [GoogleCalendarService],
})
export class GoogleCalendarModule {}
