// src/project/project.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { UserModule } from '../user/user.module';
import { MailModule } from '../utils/mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StorageModule } from '../storage/storage.module';
import { ProjectGateway } from './project.gateway';
import { CronjobModule } from '../utils/cronjob/cronjob.module';

const allowedMimes = [
  // Images
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',

  // Excel
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx

  // PowerPoint
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx

  // Text file
  'text/plain', // .txt
];

const fileFilter = (
  req: any,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipe file tidak diizinkan'), false);
  }
};

@Module({
  imports: [
    StorageModule,
    JwtModule.register({}),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 1 * 1024 * 1024 }, // 1 MB
      fileFilter,
    }),
    PrismaModule,
    UserModule,
    MailModule,
    CronjobModule,
  ],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectGateway],
  exports: [ProjectService, ProjectGateway],
})
export class ProjectModule {}
