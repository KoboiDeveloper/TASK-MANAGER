import { IsString } from 'class-validator';

export class LoginRequest {
  @IsString()
  nik: string;
  @IsString()
  password: string;
}
