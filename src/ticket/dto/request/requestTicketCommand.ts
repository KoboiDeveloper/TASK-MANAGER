import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ERepairTransaction } from '../../../constant/ERepairTransaction';

export class PayloadDto {
  @IsString()
  @IsOptional()
  senderNik?: string;

  @IsString()
  @IsNotEmpty()
  ID_TR_SALES_HEADER: string;

  @IsString()
  @IsNotEmpty()
  grandTotal: string;

  @IsString()
  @IsNotEmpty()
  fromPaymentType: string;

  @IsString()
  @IsNotEmpty()
  toPaymentType: string;

  @IsBoolean()
  directSelling: boolean;
}

export class RequestRepairTransactionDto {
  @IsEnum(ERepairTransaction)
  commandType: ERepairTransaction.REPAIR_PAYMENT; // enum, bukan string literal

  @IsString()
  @IsNotEmpty()
  idStore: string;

  @IsString()
  @IsNotEmpty()
  ticketId: string;

  @ValidateNested()
  @Type(() => PayloadDto)
  payload: PayloadDto;
}
