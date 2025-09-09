import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPwRequest {
  @IsNotEmpty({ message: 'Email tidak boleh kosong' })
  @IsEmail({}, { message: 'Format email tidak valid' })
  email: string;
}
