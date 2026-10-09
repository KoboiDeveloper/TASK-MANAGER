export class LoginResponse {
  token: string;
  refreshToken?: string;
  /** When true, cloud.amscorp.id must show force-change form before /drive */
  mustChangePassword?: boolean;
}
