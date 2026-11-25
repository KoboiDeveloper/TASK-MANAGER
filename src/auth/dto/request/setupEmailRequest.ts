import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';

export class SetupEmailRequest {
  @IsEmail({}, { message: 'Email tidak valid' })
  @MaxLength(100)
  email: string;
}
