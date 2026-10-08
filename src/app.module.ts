import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from './utils/mail/mail.module';
import { RoleModule } from './role/role.module';
import { TicketModule } from './ticket/ticket.module';
import { ProjectModule } from './project/project.module';
import { CronjobModule } from './utils/cronjob/cronjob.module';
import { ScheduleModule } from '@nestjs/schedule';
import { MailboxModule } from './mailbox/mailbox.module';
import { ChatModule } from './chat/chat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CloudModule } from './cloud/cloud.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    UserModule,
    AuthModule,
    PrismaModule,
    MailModule,
    RoleModule,
    TicketModule,
    ProjectModule,
    ChatModule,
    CronjobModule,
    MailboxModule,
    NotificationsModule,
    CloudModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
