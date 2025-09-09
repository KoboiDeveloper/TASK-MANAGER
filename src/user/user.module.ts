import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { StoreModule } from '../store/store.module';
import { RoleModule } from '../role/role.module';

@Module({
  imports: [StoreModule, RoleModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
