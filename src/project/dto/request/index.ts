import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// =========================================================
// 🔹 PROJECT DTO
// =========================================================
export class CreateProjectRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  desc!: string;
}

// =========================================================
// 🔹 TASK DTO
// =========================================================
export class CreateTaskProjectRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  // bebas: nama tag pertama (opsional)
  @IsString()
  @IsOptional()
  @MaxLength(64)
  tag?: string;

  // bebas: id/slug section (opsional). Jika ini UUID, ganti ke @IsUUID()
  @IsString()
  @IsOptional()
  @MaxLength(100)
  section?: string;
}

// =========================================================
/**
 * 🔹 UPDATE TASK DTO
 * - id_dt_section boleh null/undefined; jika ada nilai → harus UUID
 * - tagNames bisa string tunggal, array, atau CSV → di-normalisasi ke string[]
 * - updatedBy DIHAPUS: ambil dari auth (req.user / client.user)
 // =========================================================
 */

class AssigneeDto {
  @IsString()
  @MinLength(9)
  @MaxLength(9)
  nik: string;

  @IsString()
  @IsNotEmpty()
  name: string;
}
export class UpdateTaskRequest {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  desc?: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @IsOptional()
  @IsBoolean()
  status?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssigneeDto)
  assignees?: AssigneeDto[];
}

// =========================================================
// 🔹 TASK DETAIL DTO
// Catatan: IsDateString → field harus string ISO (YYYY-MM-DD atau full ISO).
// Jika ingin menerima null: pakai ValidateIf untuk skip validasi pada null.
// =========================================================
export class AddTaskDetailRequest {
  @IsUUID()
  taskId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString()
  @IsOptional()
  dueDate?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  priority?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  status?: string | null;
}

export class UpdateTaskDetailRequest {
  @IsUUID()
  @IsOptional()
  taskId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  priority?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  status?: string | null;
}
