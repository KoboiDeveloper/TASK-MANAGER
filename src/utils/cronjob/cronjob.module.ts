// src/cronjob/cronjob.module.ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronjobService } from './cronjob.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../../storage/storage.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [ScheduleModule.forRoot(), StorageModule, MailModule],
  providers: [CronjobService, PrismaService],
  exports: [CronjobService],
})
export class CronjobModule {}
