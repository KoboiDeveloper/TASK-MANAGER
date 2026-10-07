import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class ConnectMailboxDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class SendMessageDto {
  @IsString()
  to: string;

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
