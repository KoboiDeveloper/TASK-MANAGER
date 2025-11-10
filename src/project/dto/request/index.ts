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
import { Transform, Type } from 'class-transformer';

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
// TASK DTO
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

  @IsString()
  @IsOptional()
  @MaxLength(64)
  desc?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  section?: string;
}

// =========================================================
// SECTION DTO
// =========================================================

export class RemoveSectionParamsDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  sectionId!: string;
}

export class RemoveSectionQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
      const v = value.toLowerCase().trim();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0' || v === '') return false;
    }
    return false;
  })
  @IsBoolean()
  includeTask?: boolean = false;
}

export type RemoveSectionArgs = {
  projectId: string;
  sectionId: string;
  includeTask: boolean;
};

//  =========================================================
//  UPDATE TASK DTO
//  =========================================================

class AssigneeDto {
  @IsString()
  @MinLength(8)
  @MaxLength(8)
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
// TASK DETAIL DTO
// =========================================================
export class AddSubTaskRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string | null;
}

export class UpdateSubTaskRequest {
  @IsUUID()
  @IsOptional()
  taskId: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @IsBoolean()
  @IsOptional()
  status?: boolean;
}
