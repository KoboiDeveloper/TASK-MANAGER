import { IsEnum, IsString } from 'class-validator';
import { ERole } from '../../constant/ERole';

export class RequestRoleDto {
  @IsEnum(ERole)
  id: ERole;

  @IsString()
  nama: string;
}
