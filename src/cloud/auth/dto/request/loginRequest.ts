import { IsNotEmpty, IsString, Length } from 'class-validator';

export class LoginRequest {
  @IsString()
  @IsNotEmpty()
  @Length(8, 8)
  nik: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
