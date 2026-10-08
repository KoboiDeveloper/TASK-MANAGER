import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { CloudPrismaService } from '../prisma/prisma.service';
import { comparePassword } from '../utils/bcrypt';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { JwtService } from '@nestjs/jwt';
import { SuspendedUserException } from '../utils/suspendExecption';
import { GetInfoUserResponse } from './dto/response/getInfoResponse';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
  type?: 'access' | 'ws';
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
    user: { nik: string; nama: string; roleId: string },
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

    const accessPayload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
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

    return { token, refreshToken };
  }

  async validateUser(data: LoginRequest, userAgent?: string): Promise<LoginResponse> {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik: data.nik } });
    if (!user || !(await comparePassword(data.password, user.password))) {
      throw new UnauthorizedException('Bad credentials');
    }
    if (!user.statusActive) throw new SuspendedUserException();
    return this.generateTokens(
      { nik: user.nik, nama: user.nama, roleId: user.roleId },
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

    const newJti = randomUUID();
    const newExpiresAt = new Date(Date.now() + this.getRefreshExpiresInMs());

    await this.prisma.$transaction([
      this.prisma.lOG_REFRESH_TOKEN.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true },
      }),
      this.prisma.lOG_REFRESH_TOKEN.create({
        data: {
          id: newJti,
          nik: user.nik,
          family: tokenRecord.family,
          isRevoked: false,
          expiresAt: newExpiresAt,
        },
      }),
    ]);

    const accessPayload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      type: 'access',
    };
    const refreshPayload: RefreshTokenPayload = {
      nik: user.nik,
      roleId: user.roleId,
      jti: newJti,
      family: tokenRecord.family,
      type: 'refresh',
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

    return { token, refreshToken: newRefreshToken };
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
        quota: { select: { limitBytes: true, usedBytes: true } },
      },
    });
    if (!dbUser) throw new NotFoundException('User not found');

    return {
      nik: dbUser.nik,
      nama: dbUser.nama,
      roleId: dbUser.roleId,
      photo: dbUser.photo,
      quota: dbUser.quota
        ? {
            limitBytes: dbUser.quota.limitBytes.toString(),
            usedBytes: dbUser.quota.usedBytes.toString(),
          }
        : undefined,
    };
  }
}
