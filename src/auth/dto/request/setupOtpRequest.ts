import { IsNotEmpty, Length } from 'class-validator';

export class SetupOtpRequest {
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP harus 6 digit' })
  otp: string;
}
