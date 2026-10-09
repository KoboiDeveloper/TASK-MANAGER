import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { CloudPrismaService } from '../prisma/prisma.service';
import { comparePassword, encodePassword } from '../utils/bcrypt';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { JwtService } from '@nestjs/jwt';
import { SuspendedUserException } from '../utils/suspendExecption';
import { GetInfoUserResponse } from './dto/response/getInfoResponse';
import { ConfigService } from '@nestjs/config';
import { sendCloudResetPasswordEmail } from '../utils/brevo.mailer';
import { ForgotPasswordRequest } from './dto/request/forgotPasswordRequest';
import { CloudResetPasswordRequest } from './dto/request/resetPasswordRequest';
import { ChangePasswordRequest } from './dto/request/changePasswordRequest';

export interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
  type?: 'access' | 'ws';
  mustChangePassword?: boolean;
}

export interface RefreshTokenPayload {
  nik: string;
  roleId: string;
  jti: string;
  family: string;
  type: 'refresh';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: CloudPrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  private getAccessSecret(): string {
    return this.configService.get<string>('CLOUD_SECRET_KEY') || this.configService.get<string>('SECRET_KEY') || 'CLOUDSTORAGE_SECRET';
  }

  private getRefreshSecret(): string {
    return (
      this.configService.get<string>('CLOUD_REFRESH_SECRET_KEY') ||
      this.configService.get<string>('REFRESH_SECRET_KEY') ||
      `${this.getAccessSecret()}_refresh`
    );
  }

  private getIssuer(): string {
    return this.configService.get<string>('CLOUD_ISSUER_STAMP') || this.configService.get<string>('ISSUER_STAMP') || 'CloudStorageAMS';
  }

  private getAccessExpiresIn(): string {
    return this.configService.get<string>('ACCESS_TOKEN_EXPIRES') || '15m';
  }

  private getRefreshExpiresIn(): string {
    return this.configService.get<string>('REFRESH_TOKEN_EXPIRES') || '7d';
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

  async issueUploadTicket(user: { nik: string; nama: string; roleId: string }): Promise<string> {
    const payload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
    };
    return this.jwtService.signAsync(payload, {
      secret: this.getAccessSecret(),
      expiresIn: '15m' as any,
      issuer: this.getIssuer(),
    });
  }

  async generateTokens(
    user: { nik: string; nama: string; roleId: string; mustChangePassword?: boolean },
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

    await this.prisma.lOG_REFRESH_TOKEN.create({
      data: {
        id: jti,
        nik: user.nik,
        family,
        isRevoked: false,
        expiresAt,
        userAgent,
        deviceHash,
      },
    });

    const mustChange = !!user.mustChangePassword;
    const accessPayload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
      mustChangePassword: mustChange,
    };

    const refreshPayload: RefreshTokenPayload = {
      nik: user.nik,
      roleId: user.roleId,
      jti,
      family,
      type: 'refresh',
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

    return { token, refreshToken, mustChangePassword: mustChange };
  }

  async validateUser(data: LoginRequest, userAgent?: string): Promise<LoginResponse> {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik: data.nik } });
    if (!user || !(await comparePassword(data.password, user.password))) {
      throw new UnauthorizedException('Bad credentials');
    }
    if (!user.statusActive) throw new SuspendedUserException();
    return this.generateTokens(
      {
        nik: user.nik,
        nama: user.nama,
        roleId: user.roleId,
        mustChangePassword: !!user.mustChangePassword,
      },
      undefined,
      { userAgent },
    );
  }

  async refreshToken(refreshToken: string): Promise<LoginResponse> {
    if (!refreshToken) throw new UnauthorizedException('Refresh token is required');

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

    const tokenRecord = await this.prisma.lOG_REFRESH_TOKEN.findUnique({
      where: { id: payload.jti },
    });

    if (!tokenRecord) {
      if (payload.family) {
        await this.prisma.lOG_REFRESH_TOKEN.updateMany({
          where: { family: payload.family },
          data: { isRevoked: true },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenRecord.isRevoked) {
      await this.prisma.lOG_REFRESH_TOKEN.updateMany({
        where: { family: tokenRecord.family },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (new Date() > new Date(tokenRecord.expiresAt)) {
      await this.prisma.lOG_REFRESH_TOKEN.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('Refresh token has expired');
    }

    const user = await this.prisma.dT_USER.findUnique({
      where: { nik: tokenRecord.nik },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.statusActive) throw new SuspendedUserException();

    await this.prisma.lOG_REFRESH_TOKEN.update({
      where: { id: tokenRecord.id },
      data: { isRevoked: true },
    });

    return this.generateTokens(
      {
        nik: user.nik,
        nama: user.nama,
        roleId: user.roleId,
        mustChangePassword: !!user.mustChangePassword,
      },
      tokenRecord.family,
    );
  }

  async revokeAllRefreshTokens(nik: string): Promise<void> {
    await this.prisma.lOG_REFRESH_TOKEN.updateMany({
      where: { nik, isRevoked: false },
      data: { isRevoked: true },
    });
  }

  async changePassword(
    nik: string,
    data: ChangePasswordRequest,
    userAgent?: string,
  ): Promise<LoginResponse> {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.mustChangePassword) {
      if (!data.currentPassword) {
        throw new BadRequestException('Password lama wajib diisi');
      }
      const ok = await comparePassword(data.currentPassword, user.password);
      if (!ok) throw new UnauthorizedException('Password lama salah');
    }

    if (await comparePassword(data.newPassword, user.password)) {
      throw new BadRequestException('Password baru tidak boleh sama dengan password lama');
    }

    const password = encodePassword(data.newPassword);
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { password, mustChangePassword: false },
    });
    await this.revokeAllRefreshTokens(nik);

    return this.generateTokens(
      {
        nik: user.nik,
        nama: user.nama,
        roleId: user.roleId,
        mustChangePassword: false,
      },
      undefined,
      { userAgent },
    );
  }

  async sendForgotPassword({ nik, from }: ForgotPasswordRequest): Promise<string> {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User tidak ditemukan');
    if (!user.email?.trim()) {
      throw new BadRequestException(
        'Email belum terdaftar untuk akun ini. Hubungi admin Cloud Storage.',
      );
    }
    if (!user.statusActive) throw new SuspendedUserException();

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const token = await this.jwtService.signAsync(
      { otp, nik: user.nik, type: 'cloud_forgot' },
      {
        expiresIn: '15m' as any,
        secret: this.getAccessSecret(),
        issuer: this.getIssuer(),
      },
    );

    await this.prisma.lOG_FORGOT_PASSWORD.create({
      data: { otp, nik: user.nik, expiresAt },
    });

    await sendCloudResetPasswordEmail(user.email, token, otp, user.nama, from);
    return 'Kode reset password telah dikirim ke email Anda';
  }

  async resetPasswordWithOtp(data: CloudResetPasswordRequest): Promise<{
    message: string;
    nik: string;
    handoffToken?: string;
    tokens?: LoginResponse;
  }> {
    const { otp, newPassword, issueHandoff, autoLogin } = data;
    const row = await this.prisma.lOG_FORGOT_PASSWORD.findUnique({ where: { otp } });
    if (!row || row.used || new Date() > new Date(row.expiresAt)) {
      throw new BadRequestException('OTP tidak valid atau sudah kedaluwarsa');
    }

    const user = await this.prisma.dT_USER.findUnique({ where: { nik: row.nik } });
    if (!user) throw new NotFoundException('User tidak ditemukan');

    const password = encodePassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.dT_USER.update({
        where: { nik: row.nik },
        data: { password, mustChangePassword: false },
      }),
      this.prisma.lOG_FORGOT_PASSWORD.update({
        where: { otp },
        data: { used: true },
      }),
    ]);
    await this.revokeAllRefreshTokens(row.nik);

    const result: {
      message: string;
      nik: string;
      handoffToken?: string;
      tokens?: LoginResponse;
    } = {
      message: 'Password berhasil diubah',
      nik: row.nik,
    };

    if (issueHandoff) {
      result.handoffToken = await this.issueWorkspaceHandoff(row.nik);
    }

    if (autoLogin) {
      result.tokens = await this.generateTokens(
        {
          nik: user.nik,
          nama: user.nama,
          roleId: user.roleId,
          mustChangePassword: false,
        },
        undefined,
        { userAgent: 'reset-auto-login' },
      );
    }

    return result;
  }

  /** One-time JWT (~3m) stored as LOG_REFRESH_TOKEN row with userAgent=handoff */
  async issueWorkspaceHandoff(nik: string): Promise<string> {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user || !user.statusActive) throw new UnauthorizedException('User tidak valid');

    const jti = randomUUID();
    const family = randomUUID();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);

    await this.prisma.lOG_REFRESH_TOKEN.create({
      data: {
        id: jti,
        nik,
        family,
        isRevoked: false,
        expiresAt,
        userAgent: 'handoff',
      },
    });

    return this.jwtService.signAsync(
      {
        nik,
        jti,
        family,
        type: 'cloud_workspace_handoff',
      },
      {
        expiresIn: '3m' as any,
        secret: this.getAccessSecret(),
        issuer: this.getIssuer(),
      },
    );
  }

  async redeemWorkspaceHandoff(
    handoffToken: string,
    userAgent?: string,
  ): Promise<LoginResponse> {
    let payload: {
      nik?: string;
      jti?: string;
      family?: string;
      type?: string;
    };
    try {
      payload = await this.jwtService.verifyAsync(handoffToken, {
        secret: this.getAccessSecret(),
        issuer: this.getIssuer(),
      });
    } catch {
      throw new UnauthorizedException('Handoff token tidak valid atau kedaluwarsa');
    }

    if (
      !payload ||
      payload.type !== 'cloud_workspace_handoff' ||
      !payload.nik ||
      !payload.jti
    ) {
      throw new UnauthorizedException('Handoff token tidak valid');
    }

    const record = await this.prisma.lOG_REFRESH_TOKEN.findUnique({
      where: { id: payload.jti },
    });
    if (
      !record ||
      record.isRevoked ||
      record.userAgent !== 'handoff' ||
      record.nik !== payload.nik ||
      new Date() > new Date(record.expiresAt)
    ) {
      throw new UnauthorizedException('Handoff token sudah dipakai atau kedaluwarsa');
    }

    await this.prisma.lOG_REFRESH_TOKEN.update({
      where: { id: record.id },
      data: { isRevoked: true },
    });

    const user = await this.prisma.dT_USER.findUnique({ where: { nik: payload.nik } });
    if (!user || !user.statusActive) throw new UnauthorizedException('User tidak valid');

    return this.generateTokens(
      {
        nik: user.nik,
        nama: user.nama,
        roleId: user.roleId,
        mustChangePassword: !!user.mustChangePassword,
      },
      undefined,
      { userAgent: userAgent || 'workspace-handoff' },
    );
  }

  async revokeToken(refreshToken: string): Promise<void> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.getRefreshSecret(),
        issuer: this.getIssuer(),
      });
      if (payload?.family) {
        await this.prisma.lOG_REFRESH_TOKEN.updateMany({
          where: { family: payload.family },
          data: { isRevoked: true },
        });
      }
    } catch {
      try {
        const decoded = this.jwtService.decode(refreshToken) as RefreshTokenPayload | null;
        if (decoded?.family) {
          await this.prisma.lOG_REFRESH_TOKEN.updateMany({
            where: { family: decoded.family },
            data: { isRevoked: true },
          });
        }
      } catch {
        // ignore
      }
    }
  }

  async userInfo(nik: string): Promise<GetInfoUserResponse> {
    const dbUser = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: {
        nik: true,
        nama: true,
        roleId: true,
        photo: true,
        mustChangePassword: true,
        quota: { select: { limitBytes: true, usedBytes: true } },
      },
    });
    if (!dbUser) throw new NotFoundException('User not found');

    return {
      nik: dbUser.nik,
      nama: dbUser.nama,
      roleId: dbUser.roleId,
      photo: dbUser.photo,
      mustChangePassword: !!dbUser.mustChangePassword,
      quota: dbUser.quota
        ? {
            limitBytes: dbUser.quota.limitBytes.toString(),
            usedBytes: dbUser.quota.usedBytes.toString(),
          }
        : undefined,
    };
  }
}
