import { IsString } from 'class-validator';

export class CreateProjectRequest {
  @IsString()
  name: string;
  @IsString()
  desc: string;
}
