import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { comparePassword, encodePassword } from '../utils/bcrypt';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { JwtService } from '@nestjs/jwt';
import { ForgotPwRequest } from './dto/request/forgotPwRequest';
import { ResetPwRequest } from './dto/request/resetPwRequest';
import { MailService } from '../utils/mail/mail.service';
import { SuspendedUserException } from '../utils/suspendExecption';
import { GetInfoUserResponse } from './dto/response/getInfoResponse';
import { ConfigService } from '@nestjs/config';
import { PushService } from '../notifications/push.service';

export interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
  type?: 'access' | 'ws';
  setup?: 'email' | 'password';
}

export interface RefreshTokenPayload {
  nik: string;
  roleId: string;
  jti: string;
  family: string;
  type: 'refresh';
  setup?: 'email' | 'password';
}

export function accountSetup(user: {
  email: string | null;
  mustChangePassword: boolean;
}): 'email' | 'password' | null {
  if (!user.email?.trim()) return 'email';
  if (user.mustChangePassword) return 'password';
  return null;
}

export interface IAuthService {
  validateUser(data: LoginRequest, userAgent?: string): Promise<LoginResponse>;
  refreshToken(refreshToken: string): Promise<LoginResponse>;
  revokeToken(refreshToken: string): Promise<void>;
  sendForgotPw(data: ForgotPwRequest): Promise<string>;
  resetPw(data: ResetPwRequest): Promise<string>;
}

@Injectable()
export class AuthService implements IAuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prismaService: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
    private configService: ConfigService,
    private pushService: PushService,
  ) {}

  private getAccessSecret(): string {
    return this.configService.get<string>('SECRET_KEY') || 'NAIKGAJIDONG';
  }

  private getRefreshSecret(): string {
    return (
      this.configService.get<string>('REFRESH_SECRET_KEY') || `${this.getAccessSecret()}_refresh`
    );
  }

  private getIssuer(): string {
    return this.configService.get<string>('ISSUER_STAMP') || 'KaryawanTalenen';
  }

  private getAccessExpiresIn(): string {
    return this.configService.get<string>('ACCESS_TOKEN_EXPIRES') || '15m';
  }

  private getRefreshExpiresIn(): string {
    return this.configService.get<string>('REFRESH_TOKEN_EXPIRES') || '7d';
  }

  private getWsTicketExpiresIn(): string {
    return this.configService.get<string>('WS_TICKET_EXPIRES') || '5m';
  }

  /**
   * Short-lived JWT for Socket.IO handshake.
   * FE fetches this via same-origin /api proxy (httpOnly cookie works),
   * then passes it in socket auth — cookies cannot cross FE↔BE hosts.
   */
  async issueWsTicket(user: { nik: string; nama: string; roleId: string }): Promise<string> {
    const payload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'ws',
    };
    return this.jwtService.signAsync(payload, {
      secret: this.getAccessSecret(),
      expiresIn: this.getWsTicketExpiresIn() as any,
      issuer: this.getIssuer(),
    });
  }

  /**
   * Short-lived access JWT for cross-origin uploads (Vercel FE → Render BE).
   * Same shape as access_token (no type) so AuthGuard Bearer works.
   * FE ambil via same-origin rewrite (cookie), lalu kirim Authorization ke BE langsung.
   */
  async issueUploadTicket(user: { nik: string; nama: string; roleId: string }): Promise<string> {
    const payload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
    };
    return this.jwtService.signAsync(payload, {
      secret: this.getAccessSecret(),
      expiresIn: '15m' as any,
      issuer: this.getIssuer(),
    });
  }

  private getRefreshExpiresInMs(): number {
    const duration = this.getRefreshExpiresIn();
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const val = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 's':
        return val * 1000;
      case 'm':
        return val * 60 * 1000;
      case 'h':
        return val * 60 * 60 * 1000;
      case 'd':
        return val * 24 * 60 * 60 * 1000;
      default:
        return 7 * 24 * 60 * 60 * 1000;
    }
  }

  async generateTokens(
    user: {
      nik: string;
      nama: string;
      roleId: string;
      email: string | null;
      mustChangePassword: boolean;
    },
    familyId?: string,
    loginMeta?: { userAgent?: string },
  ): Promise<LoginResponse> {
    const family = familyId || randomUUID();
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + this.getRefreshExpiresInMs());

    const userAgent = loginMeta?.userAgent?.slice(0, 500) ?? null;
    const deviceHash = userAgent
      ? createHash('sha256').update(userAgent).digest('hex')
      : null;

    let isNewDevice = false;
    if (deviceHash) {
      const seen = await this.prismaService.lOG_REFRESH_TOKEN.count({
        where: { nik: user.nik, deviceHash },
      });
      isNewDevice = seen === 0;
    }

    // Save refresh token record in DB
    await this.prismaService.lOG_REFRESH_TOKEN.create({
      data: {
        id: jti,
        nik: user.nik,
        family: family,
        isRevoked: false,
        expiresAt: expiresAt,
        userAgent,
        deviceHash,
      },
    });

    if (isNewDevice && deviceHash) {
      this.pushService.notifyUser(user.nik, {
        type: 'account.new_device_login',
        title: 'Login perangkat baru',
        body: 'Akun Anda login dari perangkat baru.',
        url: '/dashboard',
      });
    }

    const setup = accountSetup(user);
    const accessPayload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
      ...(setup ? { setup } : {}),
    };

    const refreshPayload: RefreshTokenPayload = {
      nik: user.nik,
      roleId: user.roleId,
      jti: jti,
      family: family,
      type: 'refresh',
      ...(setup ? { setup } : {}),
    };

    const [token, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.getAccessSecret(),
        expiresIn: this.getAccessExpiresIn() as any,
        issuer: this.getIssuer(),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.getRefreshSecret(),
        expiresIn: this.getRefreshExpiresIn() as any,
        issuer: this.getIssuer(),
      }),
    ]);

    return { token, refreshToken, setupStep: setup };
  }

  async validateUser(data: LoginRequest, userAgent?: string): Promise<LoginResponse> {
    const user = await this.prismaService.dT_USER.findUnique({
      where: { nik: data.nik },
    });

    if (!user || !(await comparePassword(data.password, user.password))) {
      throw new UnauthorizedException('Bad credentials');
    }

    if (!user.statusActive) {
      throw new SuspendedUserException();
    }

    // New login generates brand new family
    return this.generateTokens(
      {
        nik: user.nik,
        nama: user.nama,
        roleId: user.roleId,
        email: user.email,
        mustChangePassword: user.mustChangePassword,
      },
      undefined,
      { userAgent },
    );
  }

  async refreshToken(refreshToken: string): Promise<LoginResponse> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.getRefreshSecret(),
        issuer: this.getIssuer(),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!payload || payload.type !== 'refresh' || !payload.nik || !payload.jti || !payload.family) {
      throw new UnauthorizedException('Invalid refresh token payload');
    }

    // 1. Look up token in DB
    const tokenRecord = await this.prismaService.lOG_REFRESH_TOKEN.findUnique({
      where: { id: payload.jti },
    });

    if (!tokenRecord) {
      // Possible token tampering: revoke entire family if known
      if (payload.family) {
        await this.prismaService.lOG_REFRESH_TOKEN.updateMany({
          where: { family: payload.family },
          data: { isRevoked: true },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. RTR Reuse Detection: check if this token was already rotated/revoked
    if (tokenRecord.isRevoked) {
      // Grace period (10s) to absorb network concurrency / in-flight requests
      const revokedAgo = Date.now() - new Date(tokenRecord.updatedAt).getTime();
      if (revokedAgo < 10000) {
        const latestToken = await this.prismaService.lOG_REFRESH_TOKEN.findFirst({
          where: { family: tokenRecord.family, isRevoked: false },
          orderBy: { createdAt: 'desc' },
        });

        if (latestToken && new Date() <= new Date(latestToken.expiresAt)) {
          const user = await this.prismaService.dT_USER.findUnique({
            where: { nik: tokenRecord.nik },
          });

          if (!user || !user.statusActive) {
            throw new UnauthorizedException('User is inactive or not found');
          }

          const setup = accountSetup(user);
          const accessPayload: JwtPayload = {
            nik: user.nik,
            nama: user.nama,
            roleId: user.roleId,
            type: 'access',
            ...(setup ? { setup } : {}),
          };

          const refreshPayload: RefreshTokenPayload = {
            nik: user.nik,
            roleId: user.roleId,
            jti: latestToken.id,
            family: latestToken.family,
            type: 'refresh',
            ...(setup ? { setup } : {}),
          };

          const [token, activeRefreshToken] = await Promise.all([
            this.jwtService.signAsync(accessPayload, {
              secret: this.getAccessSecret(),
              expiresIn: this.getAccessExpiresIn() as any,
              issuer: this.getIssuer(),
            }),
            this.jwtService.signAsync(refreshPayload, {
              secret: this.getRefreshSecret(),
              expiresIn: this.getRefreshExpiresIn() as any,
              issuer: this.getIssuer(),
            }),
          ]);

          return { token, refreshToken: activeRefreshToken, setupStep: setup };
        }
      }

      // Beyond grace period -> Threat detected! Invalidate entire family immediately
      this.logger.warn(
        `[RTR Security Alert] Refresh token reuse detected! NIK: ${tokenRecord.nik}, Family: ${tokenRecord.family}, JTI: ${tokenRecord.id}`,
      );

      await this.prismaService.lOG_REFRESH_TOKEN.updateMany({
        where: { family: tokenRecord.family },
        data: { isRevoked: true },
      });

      throw new UnauthorizedException(
        'Refresh token reuse detected. Access revoked for this session.',
      );
    }

    // 3. Expiration Check
    if (new Date() > new Date(tokenRecord.expiresAt)) {
      await this.prismaService.lOG_REFRESH_TOKEN.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('Refresh token has expired');
    }

    // 4. User Status Check
    const user = await this.prismaService.dT_USER.findUnique({
      where: { nik: tokenRecord.nik },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.statusActive) {
      throw new SuspendedUserException();
    }

    // 5. RTR + Sliding Expiration
    const newJti = randomUUID();
    const newExpiresAt = new Date(Date.now() + this.getRefreshExpiresInMs());

    await this.prismaService.$transaction([
      // Revoke current token
      this.prismaService.lOG_REFRESH_TOKEN.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true },
      }),
      // Create new token in the same family with sliding expiration
      this.prismaService.lOG_REFRESH_TOKEN.create({
        data: {
          id: newJti,
          nik: user.nik,
          family: tokenRecord.family,
          isRevoked: false,
          expiresAt: newExpiresAt,
        },
      }),
    ]);

    const setup = accountSetup(user);
    const accessPayload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
      ...(setup ? { setup } : {}),
    };

    const refreshPayload: RefreshTokenPayload = {
      nik: user.nik,
      roleId: user.roleId,
      jti: newJti,
      family: tokenRecord.family,
      type: 'refresh',
      ...(setup ? { setup } : {}),
    };

    const [token, newRefreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.getAccessSecret(),
        expiresIn: this.getAccessExpiresIn() as any,
        issuer: this.getIssuer(),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.getRefreshSecret(),
        expiresIn: this.getRefreshExpiresIn() as any,
        issuer: this.getIssuer(),
      }),
    ]);

    return { token, refreshToken: newRefreshToken, setupStep: setup };
  }

  async revokeToken(refreshToken: string): Promise<void> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.getRefreshSecret(),
        issuer: this.getIssuer(),
      });
      if (payload?.family) {
        await this.prismaService.lOG_REFRESH_TOKEN.updateMany({
          where: { family: payload.family },
          data: { isRevoked: true },
        });
      }
    } catch {
      try {
        const decoded = this.jwtService.decode(refreshToken);
        if (decoded?.family) {
          await this.prismaService.lOG_REFRESH_TOKEN.updateMany({
            where: { family: decoded.family },
            data: { isRevoked: true },
          });
        }
      } catch {
        // Ignore decode failures
      }
    }
  }

  async sendForgotPw({ email }: ForgotPwRequest): Promise<string> {
    const user = await this.prismaService.dT_USER.findFirstOrThrow({ where: { email } });
    if (!user.email) throw new BadRequestException('Email tidak tersedia');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const token = this.jwtService.sign(
      { otp },
      {
        expiresIn: '15m',
        secret: process.env.SECRET_KEY,
        issuer: process.env.ISSUER_STAMP,
      },
    );

    await this.prismaService.lOG_FORGOT_PASSWORD.create({
      data: { otp, nik: user.nik, expiresAt },
    });
    await this.mailService.sendResetPasswordEmail(user.email, token, otp);

    return 'Reset code sent via email';
  }

  async resetPw({ otp, newPassword }: ResetPwRequest): Promise<string> {
    const whorequest = await this.prismaService.lOG_FORGOT_PASSWORD.findUnique({ where: { otp } });

    if (
      !whorequest ||
      whorequest.used ||
      whorequest.purpose === 'setup' ||
      new Date() > new Date(whorequest.expiresAt)
    ) {
      throw new BadRequestException('OTP is invalid or expired');
    }

    const password = encodePassword(newPassword);

    await this.prismaService.$transaction([
      this.prismaService.dT_USER.update({ where: { nik: whorequest.nik }, data: { password } }),
      this.prismaService.lOG_FORGOT_PASSWORD.update({ where: { otp }, data: { used: true } }),
    ]);

    const updatedUser = await this.prismaService.dT_USER.findUnique({ where: { nik: whorequest.nik } });
    if (updatedUser?.email) {
      this.mailService.sendPasswordChangedEmail(updatedUser.email, updatedUser.nama);
    }
    this.pushService.notifyUser(whorequest.nik, {
      type: 'account.password_changed',
      title: 'Password diubah',
      body: 'Password akun Anda berhasil diubah.',
      url: '/dashboard',
    });

    return 'Change Password Successfully';
  }

  async userInfo(nik: string): Promise<GetInfoUserResponse> {
    try {
      const dbUser = await this.prismaService.dT_USER.findUnique({
        where: { nik },
        select: {
          nik: true,
          nama: true,
          roleId: true,
          photo: true,
          email: true,
          mustChangePassword: true,
          memberProjects: {
            orderBy: { projectId: 'asc' },
            select: {
              project: {
                select: {
                  name: true,
                  color: true,
                  shortId: true,
                },
              },
              projectId: true,
              roleProject: { select: { name: true } }, // ambil name dari relasi
            },
          },
        },
      });

      if (!dbUser) {
        throw new NotFoundException('User not found');
      }

      return {
        nik: dbUser.nik,
        nama: dbUser.nama,
        roleId: dbUser.roleId,
        photo: dbUser.photo,
        email: dbUser.email,
        setupStep: accountSetup(dbUser),
        memberProjects: dbUser.memberProjects.map((mp) => ({
          projectId: mp.project?.shortId || mp.projectId,
          name: mp.project.name,
          color: mp.project.color,
          roleProject: mp.roleProject?.name ?? '',
        })),
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new InternalServerErrorException(e);
    }
  }

  async sendSetupEmail(nik: string, email: string): Promise<string> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');
    if (accountSetup(user) !== 'email') {
      throw new BadRequestException('Email sudah terisi');
    }

    const taken = await this.prismaService.dT_USER.findFirst({
      where: { email: normalized, NOT: { nik } },
    });
    if (taken) throw new BadRequestException('Email sudah dipakai');

    await this.prismaService.lOG_FORGOT_PASSWORD.updateMany({
      where: { nik, purpose: 'setup', used: false },
      data: { used: true },
    });

    const otp = await this.createUniqueOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.prismaService.$transaction([
      this.prismaService.dT_USER.update({
        where: { nik },
        data: { pendingEmail: normalized },
      }),
      this.prismaService.lOG_FORGOT_PASSWORD.create({
        data: { otp, nik, expiresAt, purpose: 'setup' },
      }),
    ]);
    try {
      await this.mailService.sendSetupOtpEmail(normalized, otp);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('unrecognised IP') || detail.includes('authorised_ips')) {
        throw new BadRequestException('Email gagal terkirim. IP pengirim belum diizinkan di Brevo.');
      }
      throw new BadRequestException('Email gagal terkirim. Coba lagi.');
    }
    return 'Kode verifikasi dikirim';
  }

  async verifySetupOtp(nik: string, otp: string): Promise<LoginResponse> {
    const row = await this.prismaService.lOG_FORGOT_PASSWORD.findUnique({ where: { otp } });
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (
      !user ||
      !row ||
      row.used ||
      row.purpose !== 'setup' ||
      row.nik !== nik ||
      new Date() > new Date(row.expiresAt) ||
      !user.pendingEmail
    ) {
      throw new BadRequestException('OTP is invalid or expired');
    }

    const updated = await this.prismaService.$transaction(async (tx) => {
      await tx.lOG_FORGOT_PASSWORD.update({ where: { otp }, data: { used: true } });
      return tx.dT_USER.update({
        where: { nik },
        data: { email: user.pendingEmail, pendingEmail: null },
      });
    });

    return this.generateTokens(updated);
  }

  async completeSetupPassword(nik: string, newPassword: string): Promise<LoginResponse> {
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!user || accountSetup(user) !== 'password') {
      throw new BadRequestException('Password belum bisa diganti');
    }
    if (newPassword === 'ArahTimurLaut12') {
      throw new BadRequestException('Pakai password yang baru');
    }

    const password = encodePassword(newPassword);
    const updated = await this.prismaService.dT_USER.update({
      where: { nik },
      data: { password, mustChangePassword: false },
    });
    if (updated.email) {
      this.mailService.sendPasswordChangedEmail(updated.email, updated.nama);
    }
    return this.generateTokens(updated);
  }

  private async createUniqueOtp(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const existing = await this.prismaService.lOG_FORGOT_PASSWORD.findUnique({ where: { otp } });
      if (!existing) return otp;
    }
    throw new InternalServerErrorException('Gagal membuat OTP');
  }
}
