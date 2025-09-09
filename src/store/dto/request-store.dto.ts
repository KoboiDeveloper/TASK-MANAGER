import { IsBoolean, IsNotEmpty, IsString, Length } from 'class-validator';

export class RequestStoreDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 10)
  id: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 15)
  brand: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 20)
  regionId: string;

  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  address: string;

  @IsBoolean()
  @IsNotEmpty()
  statusActive: boolean;
}
