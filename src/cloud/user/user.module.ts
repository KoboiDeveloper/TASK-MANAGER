import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { CloudRoleModule } from '../role/role.module';
import { CloudStorageModule } from '../storage/storage.module';
import { CloudAuthModule } from '../auth/auth.module';

@Module({
  imports: [CloudRoleModule, CloudStorageModule, CloudAuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class CloudUserModule {}
