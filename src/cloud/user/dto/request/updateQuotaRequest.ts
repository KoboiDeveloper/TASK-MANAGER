import { IsNotEmpty, IsNumberString } from 'class-validator';

export class UpdateQuotaRequest {
  @IsNotEmpty()
  @IsNumberString()
  limitBytes: string;
}
