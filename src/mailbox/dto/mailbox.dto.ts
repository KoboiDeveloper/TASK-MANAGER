import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class ConnectMailboxDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class SetActiveMailboxDto {
  @IsEmail()
  email: string;
}

export class SendMessageDto {
  /** Boleh kosong saat menyimpan draf; wajib saat kirim (dicek di service). */
  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  cc?: string;

  @IsOptional()
  @IsString()
  bcc?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  bodyHtml?: string;

  @IsOptional()
  @IsString()
  bodyText?: string;

  @IsOptional()
  @IsString()
  inReplyTo?: string;

  @IsOptional()
  @IsString()
  draftId?: string;

  /** Comma-separated Zimbra upload aids */
  @IsOptional()
  @IsString()
  attachmentAids?: string;

  /**
   * Part lampiran yang sudah ada di draf (comma-separated),
   * di-reattach via attach.mp saat update/kirim draf.
   */
  @IsOptional()
  @IsString()
  attachmentParts?: string;
}

export class MessageActionDto {
  @IsString()
  op: string; // read | unread | flag | unflag | trash | delete | move | tag | !tag

  @IsOptional()
  @IsString()
  folderId?: string;

  @IsOptional()
  @IsString()
  tagName?: string;
}

export class SaveSignatureDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  name?: string;

  /** HTML signature (Zimbra text/html) */
  @IsString()
  html: string;
}
