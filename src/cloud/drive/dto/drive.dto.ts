import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class RenameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;
}

export class MoveDto {
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

export class DescriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class StarDto {
  @IsBoolean()
  starred: boolean;
}

export class ItemTypeParam {
  @IsIn(['FILE', 'FOLDER'])
  itemType: 'FILE' | 'FOLDER';
}
