import { Module } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UserModule } from '../user/user.module';
import { StorageModule } from '../storage/storage.module';
@Module({
  imports: [
    StorageModule,
    UserModule,
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 1 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (/^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.mimetype)) cb(null, true);
        else cb(new Error('Tipe file tidak diizinkan'), false);
      },
    }),
  ],
  controllers: [TicketController],
  providers: [TicketService],
})
export class TicketModule {}
