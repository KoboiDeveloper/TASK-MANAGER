import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SuspendedUserException } from '../utils/suspendExecption';

interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.method === 'OPTIONS') {
      return true;
    }
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Access token not found');
    }

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.mustGetEnv('SECRET_KEY'),
        issuer: this.mustGetEnv('ISSUER_STAMP'),
      });
    } catch (error) {
      console.error('JWT verification error:', error);
      throw new UnauthorizedException('Invalid or expired token');
    }
    const userInDb = await this.prismaService.dT_USER.findUnique({
      where: { nik: request.user.nik },
      select: { statusActive: true },
    });
    if (!userInDb?.statusActive) {
      throw new SuspendedUserException();
    }

    return true;
  }
  private extractToken(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string>;
    return cookies?.['access_token'];
  }

  private mustGetEnv(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`Missing ENV variable: ${key}`);
    return value;
  }
}
