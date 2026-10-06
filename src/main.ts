import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { SuspendedUserFilter } from './utils/suspendExecption';
import * as process from 'node:process';
import { Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { isOriginAllowed } from './common/corsOrigins';

const logger = new Logger('Bootstrap');
async function bootstrap(): Promise<void> {
  // 1. HTTP App
  const app = await NestFactory.create(AppModule);

  // Middleware & global setup
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.useGlobalFilters(new SuspendedUserFilter());
  app.use(cookieParser());

  app.enableCors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 5000;
  await app.listen(port, '0.0.0.0');

  // HTTP Server
  logger.log(`✅ HTTP server running on port ${port}`);
}

bootstrap();
