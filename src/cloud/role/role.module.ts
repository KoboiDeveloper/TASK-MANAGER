import { Module } from '@nestjs/common';
import { RoleService } from './role.service';
import { RoleController } from './role.controller';
import { CloudAuthModule } from '../auth/auth.module';

@Module({
  imports: [CloudAuthModule],
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService],
})
export class CloudRoleModule {}
