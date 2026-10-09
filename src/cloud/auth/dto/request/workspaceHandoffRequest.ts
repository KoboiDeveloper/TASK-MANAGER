import { IsNotEmpty, IsString } from 'class-validator';

export class WorkspaceHandoffRedeemRequest {
  @IsString()
  @IsNotEmpty({ message: 'handoffToken wajib diisi' })
  handoffToken: string;
}
