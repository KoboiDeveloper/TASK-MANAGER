import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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
      storage: memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  ],
  controllers: [MailboxController],
  providers: [MailboxService, MailboxCryptoService, ZimbraSoapClient],
  exports: [MailboxService],
})
export class MailboxModule {}
