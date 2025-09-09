// src/ticket/dto/request/requestCreateTicket.dto.ts
import { IsString, IsOptional, IsBoolean, MaxLength, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

// Helper: konversi form-data string/number → boolean
const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

function toBoolean(value: unknown): boolean | undefined {
  if (value == null || value === '') return undefined; // biarkan optional
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (value instanceof Boolean) return value.valueOf();
  if (value instanceof Number) return value.valueOf() === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
  }
  if (value instanceof String) {
    const v = value.valueOf().trim().toLowerCase();
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
  }
  return undefined;
}

export class CreateTicketDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  idStore!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(15)
  noTelp!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  category!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  fromPayment?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  toPayment?: string | null;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  isDirectSelling?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  billCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  grandTotal?: string | null;
}
