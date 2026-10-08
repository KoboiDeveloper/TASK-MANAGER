import { Module } from '@nestjs/common';
import { ShareService } from './share.service';
import { ShareController } from './share.controller';
import { CloudDriveModule } from '../drive/drive.module';
import { CloudStorageModule } from '../storage/storage.module';
import { CloudAuthModule } from '../auth/auth.module';

@Module({
  imports: [CloudDriveModule, CloudStorageModule, CloudAuthModule],
  controllers: [ShareController],
  providers: [ShareService],
})
export class CloudShareModule {}
