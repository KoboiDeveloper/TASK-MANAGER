import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
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
      const tokenType = (request.user as any)?.type;
      // refresh + ws tickets are not valid for HTTP API auth
      if (tokenType === 'refresh' || tokenType === 'ws') {
        throw new UnauthorizedException('Invalid token type');
      }
    } catch (error) {
      console.error('JWT verification error:', error);
      throw new UnauthorizedException('Invalid or expired token');
    }
    const userInDb = await this.prismaService.dT_USER.findUnique({
      where: { nik: request.user.nik },
      select: { statusActive: true, email: true, mustChangePassword: true },
    });
    if (!userInDb?.statusActive) {
      throw new SuspendedUserException();
    }

    const needsSetup = !userInDb.email?.trim() || userInDb.mustChangePassword;
    if (needsSetup && !this.isSetupAllowed(request)) {
      throw new ForbiddenException('Setup required');
    }

    return true;
  }

  private isSetupAllowed(request: Request): boolean {
    const raw = request.originalUrl || request.url || request.path || '';
    const path = raw.split('?')[0].replace(/\/+$/, '');
    const allowed = [
      '/api/auth/user-info',
      '/api/auth/logout',
      '/api/auth/refresh',
      '/api/auth/setup/email',
      '/api/auth/setup/verify-otp',
      '/api/auth/setup/password',
    ];
    return allowed.some((item) => path === item || path.endsWith(item));
  }
  private extractToken(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string>;
    if (cookies?.['access_token']) {
      return cookies['access_token'];
    }
    const authHeader = request.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return undefined;
  }

  private mustGetEnv(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`Missing ENV variable: ${key}`);
    return value;
  }
}
