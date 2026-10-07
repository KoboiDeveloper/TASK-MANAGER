import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { extname } from 'path';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { MailboxController } from './mailbox.controller';
import { MailboxService } from './mailbox.service';
import { MailboxCryptoService } from './mailbox-crypto.service';
import { ZimbraSoapClient } from './zimbra-soap.client';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    JwtModule.register({}),
    MulterModule.register({
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname || '').slice(0, 32);
          cb(null, `mailbox-up-${Date.now()}-${randomUUID()}${ext}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    }),
  ],
  controllers: [MailboxController],
  providers: [MailboxService, MailboxCryptoService, ZimbraSoapClient],
  exports: [MailboxService],
})
export class MailboxModule {}
