import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const fromName =
          cfg.get<string>('BREVO_FROM_NAME') ||
          cfg.get<string>('SMTP_FROM_NAME') ||
          'PM-AMS';
        const fromEmail =
          cfg.get<string>('BREVO_FROM_EMAIL') ||
          cfg.get<string>('SMTP_FROM_EMAIL') ||
          cfg.get<string>('SMTP_USER') ||
          '';

        return {
          transport: {
            // Default: Brevo SMTP relay (bukan Gmail)
            host: cfg.get<string>('SMTP_HOST') || 'smtp-relay.brevo.com',
            port: Number(cfg.get('SMTP_PORT') ?? 587),
            secure: cfg.get('SMTP_SECURE') === 'true',
            auth: {
              user:
                cfg.get<string>('SMTP_USER') ||
                cfg.get<string>('BREVO_SMTP_LOGIN') ||
                '',
              pass:
                cfg.get<string>('SMTP_PASS') ||
                cfg.get<string>('BREVO_SMTP_KEY') ||
                '',
            },
            requireTLS: (cfg.get('SMTP_REQUIRE_TLS') ?? 'true') === 'true',
          },
          defaults: {
            from: fromEmail ? `"${fromName}" <${fromEmail}>` : undefined,
          },
        };
      },
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
