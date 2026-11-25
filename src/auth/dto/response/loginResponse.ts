export class LoginResponse {
  token: string;
  refreshToken?: string;
  setupStep: 'email' | 'password' | null;
}
