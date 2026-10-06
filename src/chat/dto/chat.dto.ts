import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ArrayMinSize } from 'class-validator';

export class CreateRoomDto {
  @IsIn(['dm', 'group'])
  type!: 'dm' | 'group';

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  memberNiks!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  color?: string | null;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  isMuted?: boolean;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsBoolean()
  showTaskPanel?: boolean;
}

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  niks!: string[];
}

export class SendMessageDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsIn(['text', 'task', 'system', 'file'])
  type?: 'text' | 'task' | 'system' | 'file';

  @IsOptional()
  taskRef?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  replyToId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];

  /** Uploaded attachment metadata (from Dropbox upload endpoint) */
  @IsOptional()
  @IsArray()
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string | null;
  }>;

  /** Optimistic id from FE (socket send) */
  @IsOptional()
  @IsString()
  clientId?: string;
}

export class MarkReadDto {
  @IsString()
  lastMessageId!: string;
}

export class ToggleReactionDto {
  @IsString()
  @MaxLength(16)
  emoji!: string;
}
