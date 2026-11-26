import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../utils/mail/mail.module';
import { DailyTaskController } from './daily-task.controller';
import { DailyTaskService } from './daily-task.service';
import { DailyTaskKpiService } from './daily-task-kpi.service';

@Module({
  imports: [StorageModule, MailModule],
  controllers: [DailyTaskController],
  providers: [DailyTaskService, DailyTaskKpiService],
})
export class DailyTaskModule {}
