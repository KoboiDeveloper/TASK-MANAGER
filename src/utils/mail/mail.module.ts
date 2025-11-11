import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        transport: {
          host: cfg.get<string>('SMTP_HOST'),
          port: Number(cfg.get('SMTP_PORT')),
          secure: cfg.get('SMTP_SECURE') === 'true', // true hanya untuk 465
          auth: {
            user: cfg.get<string>('SMTP_USER'),
            pass: cfg.get<string>('SMTP_PASS'),
          },
          requireTLS: cfg.get('SMTP_REQUIRE_TLS') === 'true',
        },
        defaults: {
          from: `"${cfg.get('SMTP_FROM_NAME')}" <${cfg.get('SMTP_FROM_EMAIL')}>`,
        },
      }),
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
