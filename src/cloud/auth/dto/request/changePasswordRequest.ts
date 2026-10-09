import { IsNotEmpty, IsOptional, IsString, IsStrongPassword, MaxLength } from 'class-validator';

export class ChangePasswordRequest {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @IsNotEmpty({ message: 'Password baru tidak boleh kosong' })
  @MaxLength(64, { message: 'Password maksimal 64 karakter' })
  @IsStrongPassword(
    {
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
    },
    {
      message:
        'Password minimal 8 karakter dan harus mengandung huruf besar, huruf kecil, dan angka',
    },
  )
  newPassword: string;
}
