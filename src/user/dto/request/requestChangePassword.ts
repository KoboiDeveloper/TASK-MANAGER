import { IsString, Matches, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'Password baru minimal 8 karakter' })
  @Matches(/(?=.*[A-Z])/, { message: 'Password harus mengandung setidaknya 1 huruf besar' })
  @Matches(/(?=.*[0-9])/, { message: 'Password harus mengandung setidaknya 1 angka' })
  @Matches(/(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, {
    message: 'Password harus mengandung setidaknya 1 simbol atau karakter khusus (misal: _, @, #)',
  })
  newPassword: string;
}
