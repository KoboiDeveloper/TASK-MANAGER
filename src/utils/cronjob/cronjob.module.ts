// src/cronjob/cronjob.module.ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronjobService } from './cronjob.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [ScheduleModule.forRoot(), StorageModule],
  providers: [CronjobService, PrismaService],
  exports: [CronjobService],
})
export class CronjobModule {}
