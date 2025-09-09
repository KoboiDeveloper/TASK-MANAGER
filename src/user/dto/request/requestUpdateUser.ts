// register-request.dto.ts
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  Matches,
  IsEmail,
  IsArray,
  ValidateNested,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ERole } from '../../../constant/ERole';

class RegionIdDto {
  @IsNotEmpty({ message: 'region tidak boleh kosong' })
  @IsString({ message: 'Store harus berupa string' })
  regionId: string;
}

class StoreIdDto {
  @IsNotEmpty({ message: 'Store tidak boleh kosong' })
  @IsString({ message: 'Store harus berupa string' })
  storeId: string;
}

export class RequestUpdateUser {
  @IsNotEmpty({ message: 'NIK tidak boleh kosong' })
  @IsString({ message: 'NIK harus berupa angka' })
  @MaxLength(9, { message: 'NIK maksimal 9 karakter' })
  @MinLength(9, { message: 'NIK minimal 9 karakter' })
  nik: string;

  @IsNotEmpty({ message: 'Nama tidak boleh kosong' })
  @IsString({ message: 'Nama harus berupa teks' })
  nama: string;

  @IsNotEmpty({ message: 'Nomor telepon tidak boleh kosong' })
  @Matches(/^[0-9]{10,13}$/, {
    message: 'Nomor telepon harus terdiri dari 10–13 digit angka dan hanya angka',
  })
  noTelp: string;

  @IsNotEmpty({ message: 'Email tidak boleh kosong' })
  @IsEmail({}, { message: 'Format email tidak valid' })
  email: string;

  @IsNotEmpty({ message: 'Status Active tidak boleh kosong' })
  @IsBoolean()
  statusActive: boolean;

  @IsNotEmpty({ message: 'Role tidak boleh kosong' })
  @IsEnum(ERole, { message: 'Role tidak valid' })
  roleId: ERole;

  @IsArray({ message: 'format accessStore tidak valid' })
  @ValidateNested({ each: true })
  @Type(() => StoreIdDto)
  accessStoreIds: StoreIdDto[];

  @IsArray({ message: 'format accessRegion tidak valid' })
  @ValidateNested({ each: true })
  @Type(() => RegionIdDto)
  accessRegionIds: RegionIdDto[];
}
