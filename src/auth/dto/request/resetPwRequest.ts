import { IsNotEmpty, IsStrongPassword, MaxLength } from 'class-validator';

export class ResetPwRequest {
  @IsNotEmpty()
  otp: string;
  @IsNotEmpty({ message: 'Password tidak boleh kosong' })
  @MaxLength(16, { message: 'Password maksimal 16 karakter' })
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
