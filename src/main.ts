// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { SuspendedUserFilter } from './utils/suspendExecption';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Global middleware & filters
  app.useGlobalFilters(new SuspendedUserFilter());
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS untuk FE Vercel (termasuk preview *.vercel.app)
  app.enableCors({
    origin: ['https://task-manager-fe-lyart.vercel.app', /\.vercel\.app$/],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // ⛔️ Jangan connect RMQ di Web Service (itu tugas worker.ts)
  // Kalau suatu saat mau toggle pakai ENV, boleh:
  // if (process.env.ENABLE_RMQ === '1') { ...connectMicroservice... }

  const port = Number(process.env.PORT) || 5000;
  await app.listen(port, '0.0.0.0');

  logger.log(`✅ HTTP server running on port ${port}`);
}

bootstrap();
