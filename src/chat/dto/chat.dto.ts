import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';

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
  @IsIn(['text', 'task', 'system', 'file', 'poll', 'event'])
  type?: 'text' | 'task' | 'system' | 'file' | 'poll' | 'event';

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

  @IsOptional()
  poll?: {
    question: string;
    options: Array<{ id: string; text: string; voterNiks?: string[] }>;
    allowMultiple: boolean;
    closed?: boolean;
    backgroundColor?: string | null;
  } | null;

  @IsOptional()
  event?: {
    name: string;
    description?: string | null;
    startAt: string;
    endAt?: string | null;
    location?: string | null;
    lat?: number | null;
    lng?: number | null;
    backgroundColor?: string | null;
  } | null;

  /** Optimistic id from FE (socket send) */
  @IsOptional()
  @IsString()
  clientId?: string;
}

export class VotePollDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  optionIds!: string[];
}

export class UpdatePollEventDto {
  @IsOptional()
  poll?: {
    question: string;
    options: Array<{ id: string; text: string; voterNiks?: string[] }>;
    allowMultiple: boolean;
    closed?: boolean;
    backgroundColor?: string | null;
  } | null;

  @IsOptional()
  event?: {
    name: string;
    description?: string | null;
    startAt: string;
    endAt?: string | null;
    location?: string | null;
    lat?: number | null;
    lng?: number | null;
    backgroundColor?: string | null;
  } | null;
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
