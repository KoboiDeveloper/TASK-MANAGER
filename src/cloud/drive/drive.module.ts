import { Module } from '@nestjs/common';
import { DriveService } from './drive.service';
import { DriveController } from './drive.controller';
import { CloudStorageModule } from '../storage/storage.module';
import { CloudUserModule } from '../user/user.module';
import { CloudAuthModule } from '../auth/auth.module';

@Module({
  imports: [CloudStorageModule, CloudUserModule, CloudAuthModule],
  controllers: [DriveController],
  providers: [DriveService],
  exports: [DriveService],
})
export class CloudDriveModule {}
