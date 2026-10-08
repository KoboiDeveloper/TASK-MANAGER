import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpsertGoogleEventDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  start: number;

  @IsNumber()
  end: number;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  /** Google calendar id; default "primary" */
  @IsOptional()
  @IsString()
  calendarId?: string;

  /** Which connected Google account; default first */
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  timeZone?: string;
}
