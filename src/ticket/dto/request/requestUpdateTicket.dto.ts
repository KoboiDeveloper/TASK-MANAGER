import {
  IsString,
  IsOptional,
  IsBoolean,
  MaxLength,
  IsArray,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class TicketPatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  idStore?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  categories?: string;

  @IsOptional()
  @IsBoolean()
  status?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  keterangan?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  fromPayment?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  toPayment?: string | null;

  @IsOptional()
  @IsBoolean()
  isDirectSelling?: boolean | null;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  billcode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  grandTotal?: string | null;
}

export class ReplaceImageDto {
  @IsString()
  imageId: string;
}

export class UpdateTicketDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TicketPatchDto)
  patch?: TicketPatchDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deleteImageIds?: string[];
}
