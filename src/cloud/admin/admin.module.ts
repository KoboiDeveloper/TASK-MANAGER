import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { CloudStorageModule } from '../storage/storage.module';
import { CloudAuthModule } from '../auth/auth.module';

@Module({
  imports: [CloudStorageModule, CloudAuthModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class CloudAdminModule {}
