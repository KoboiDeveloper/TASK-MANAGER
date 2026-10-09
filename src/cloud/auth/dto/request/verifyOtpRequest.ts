import { IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyOtpRequest {
  @IsString()
  @IsNotEmpty({ message: 'OTP tidak boleh kosong' })
  @Length(6, 6, { message: 'OTP harus 6 digit' })
  otp: string;
}
