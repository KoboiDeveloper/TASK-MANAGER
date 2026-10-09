import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ForgotPasswordRequest {
  @IsString()
  @IsNotEmpty({ message: 'NIK tidak boleh kosong' })
  @Length(8, 8, { message: 'NIK harus 8 digit' })
  nik: string;
}
