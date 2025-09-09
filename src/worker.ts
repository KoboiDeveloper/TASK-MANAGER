// src/worker.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

const logger = new Logger('Worker');

async function bootstrapWorker() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL!],
      queue: 'STATUS_REPAIR',
      queueOptions: { durable: true, arguments: { 'x-queue-type': 'quorum' } },
    },
  });

  await app.listen();
  logger.log('🎧 RMQ worker started (STATUS_REPAIR)');
}

bootstrapWorker();
