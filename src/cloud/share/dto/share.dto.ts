import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class CreateShareDto {
  @IsUUID()
  itemId: string;

  @IsIn(['FILE', 'FOLDER'])
  itemType: 'FILE' | 'FOLDER';

  @IsString()
  @Length(8, 8)
  targetNik: string;

  @IsIn(['VIEW', 'EDIT'])
  permission: 'VIEW' | 'EDIT';
}

export class CreateShareLinkDto {
  @IsUUID()
  itemId: string;

  @IsIn(['FILE', 'FOLDER'])
  itemType: 'FILE' | 'FOLDER';

  @IsOptional()
  @IsIn(['VIEW', 'EDIT'])
  permission?: 'VIEW' | 'EDIT';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  password?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}

export class AccessShareLinkDto {
  @IsOptional()
  @IsString()
  password?: string;
}
