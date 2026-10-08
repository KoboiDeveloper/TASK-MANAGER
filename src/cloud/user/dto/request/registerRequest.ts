import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterRequest {
  @IsString()
  @IsNotEmpty()
  @Length(8, 8)
  nik: string;

  @IsString()
  @IsNotEmpty()
  nama: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  noTelp?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @IsNotEmpty()
  roleId: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  statusActive?: boolean = true;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  handleWeb?: boolean;

  @IsOptional()
  @IsString()
  departement?: string;

  @IsOptional()
  @IsString()
  photo?: string;

  /** Storage quota in bytes (string to avoid JS number precision issues) */
  @IsOptional()
  @IsString()
  limitBytes?: string;
}
