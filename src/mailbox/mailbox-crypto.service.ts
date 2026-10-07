import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type EncryptedSecret = {
  cipher: string;
  iv: string;
  tag: string;
};

@Injectable()
export class MailboxCryptoService implements OnModuleInit {
  private readonly logger = new Logger(MailboxCryptoService.name);
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const hex = this.config.get<string>('MAILBOX_CRYPTO_KEY')?.trim();
    if (!hex || hex.length !== 64) {
      this.logger.warn('MAILBOX_CRYPTO_KEY missing or invalid (need 64 hex chars)');
      return;
    }
    this.key = Buffer.from(hex, 'hex');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error('MAILBOX_CRYPTO_KEY is not configured');
    }
    return this.key;
  }

  encrypt(plain: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      cipher: enc.toString('base64'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.requireKey(),
      Buffer.from(secret.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(secret.tag, 'hex'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(secret.cipher, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  }
}
