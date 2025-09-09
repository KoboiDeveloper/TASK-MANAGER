import { IsNotEmpty, IsString, Length } from 'class-validator';

export class RequestCreateRegionDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 20)
  id: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 20)
  region: string;
}
