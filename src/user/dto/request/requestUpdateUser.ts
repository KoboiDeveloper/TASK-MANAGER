// register-request.dto.ts
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  Matches,
  IsEmail,
  IsEnum,
  IsBoolean,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ERole } from '../../../constant/ERole';

export class RequestUpdateUser {
  @IsNotEmpty({ message: 'NIK tidak boleh kosong' })
  @IsString({ message: 'NIK harus berupa angka' })
  @MaxLength(8, { message: 'NIK maksimal 8 karakter' })
  @MinLength(8, { message: 'NIK minimal 8 karakter' })
  nik: string;

  @IsNotEmpty({ message: 'Nama tidak boleh kosong' })
  @IsString({ message: 'Nama harus berupa teks' })
  nama: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @Matches(/^[0-9]{10,13}$/, {
    message: 'Nomor telepon harus terdiri dari 10–13 digit angka dan hanya angka',
  })
  noTelp?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsEmail({}, { message: 'Format email tidak valid' })
  email?: string;

  @IsNotEmpty({ message: 'Status Active tidak boleh kosong' })
  @Transform(({ value }: { value: unknown }): boolean =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value),
  )
  @IsBoolean()
  statusActive: boolean;

  @IsNotEmpty({ message: 'Handle Web tidak boleh kosong' })
  @Transform(({ value }: { value: unknown }): boolean =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : Boolean(value),
  )
  @IsBoolean()
  handleWeb: boolean;

  @IsNotEmpty({ message: 'Role tidak boleh kosong' })
  @IsEnum(ERole, { message: 'Role tidak valid' })
  roleId: ERole;

  @IsOptional()
  @IsString({ message: 'Photo harus berupa string' })
  photo?: string;

  @IsOptional()
  @IsString({ message: 'Color harus berupa string' })
  color?: string;

  @IsOptional()
  @IsString({ message: 'Departement harus berupa string' })
  departement?: string;

  @IsOptional()
  @IsString({ message: 'Departemen harus berupa string' })
  departemen?: string;

  @IsOptional()
  @IsString({ message: 'notificationPrefs harus berupa string' })
  notificationPrefs?: string;
}
