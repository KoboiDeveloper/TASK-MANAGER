import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { ChatEvents } from './chat.events';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    JwtModule.register({}),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  ],
  controllers: [ChatController],
  providers: [ChatEvents, ChatService, ChatGateway],
  exports: [ChatService, ChatGateway, ChatEvents],
})
export class ChatModule {}
