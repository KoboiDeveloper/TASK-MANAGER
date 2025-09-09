import { Module } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UserModule } from '../user/user.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import process from 'node:process';
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'STORE_CLIENT',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL!],
          exchange: 'REPAIR_TRANSACTION',
          exchangeType: 'topic',
          persistent: true,
          wildcards: true,
          queue: 'STATUS_REPAIR',
          queueOptions: {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' },
          },
        },
      },
    ]),

    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 1 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (/^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.mimetype)) cb(null, true);
        else cb(new Error('Tipe file tidak diizinkan'), false);
      },
    }),
    UserModule,
  ],
  controllers: [TicketController],
  providers: [TicketService],
})
export class TicketModule {}
