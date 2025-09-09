import { IsString, IsEnum } from 'class-validator';
import { EStatus } from '../../../constant/EStatus';

export class ResponseTicketCommand {
  @IsString()
  ticketId: string;

  @IsString()
  senderNik: string;

  @IsEnum(EStatus)
  status: EStatus;
}
