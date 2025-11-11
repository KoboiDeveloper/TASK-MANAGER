// src/project/project.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { UserModule } from '../user/user.module';
import { MailModule } from '../utils/mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module'; // ← buat modul global/utility utk PrismaService

@Module({
  imports: [JwtModule.register({}), PrismaModule, UserModule, MailModule],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
