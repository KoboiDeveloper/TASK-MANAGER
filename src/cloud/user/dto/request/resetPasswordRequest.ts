import { IsBoolean, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class ResetPasswordRequest {
  @IsString()
  @IsNotEmpty({ message: 'Password tidak boleh kosong' })
  @MinLength(1)
  password: string;

  /** If true (default), user must set a new password on next cloud.amscorp.id login */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return true;
  })
  @IsBoolean()
  requirePasswordChange?: boolean = true;
}
