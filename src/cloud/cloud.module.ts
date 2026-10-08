import { Module } from '@nestjs/common';
import { CloudPrismaModule } from './prisma/prisma.module';
import { CloudStorageModule } from './storage/storage.module';
import { CloudAuthModule } from './auth/auth.module';
import { CloudUserModule } from './user/user.module';
import { CloudRoleModule } from './role/role.module';
import { CloudDriveModule } from './drive/drive.module';
import { CloudShareModule } from './share/share.module';
import { CloudAdminModule } from './admin/admin.module';
@Module({
  imports: [
    CloudPrismaModule,
    CloudStorageModule,
    CloudAuthModule,
    CloudUserModule,
    CloudRoleModule,
    CloudDriveModule,
    CloudShareModule,
    CloudAdminModule,
  ],
})
export class CloudModule {}
