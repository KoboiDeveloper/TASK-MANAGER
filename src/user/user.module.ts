import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { RoleModule } from '../role/role.module';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../utils/mail/mail.module';

@Module({
  imports: [RoleModule, StorageModule, MailModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
