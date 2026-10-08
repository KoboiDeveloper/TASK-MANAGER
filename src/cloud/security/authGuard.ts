import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { CloudPrismaService } from '../prisma/prisma.service';
import { SuspendedUserException } from '../utils/suspendExecption';

interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
  type?: string;
}

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prisma: CloudPrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.method === 'OPTIONS') return true;

    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Access token not found');

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.cloudSecret(),
        issuer: this.cloudIssuer(),
      });
      const tokenType = request.user?.type;
      if (tokenType === 'refresh' || tokenType === 'ws') {
        throw new UnauthorizedException('Invalid token type');
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userInDb = await this.prisma.dT_USER.findUnique({
      where: { nik: request.user!.nik },
      select: { statusActive: true },
    });
    if (!userInDb?.statusActive) throw new SuspendedUserException();

    return true;
  }

  private cloudSecret(): string {
    return (
      this.config.get<string>('CLOUD_SECRET_KEY') ||
      this.config.get<string>('SECRET_KEY') ||
      'CLOUDSTORAGE_SECRET'
    );
  }

  private cloudIssuer(): string {
    return (
      this.config.get<string>('CLOUD_ISSUER_STAMP') ||
      this.config.get<string>('ISSUER_STAMP') ||
      'CloudStorageAMS'
    );
  }

  private extractToken(request: Request): string | undefined {
    const cookies = (request.cookies as Record<string, string>) || {};
    // Cloud-only cookie — do not read Task Manager access_token (wrong secret → 401 cascade)
    if (cookies['cloud_access_token']) return cookies['cloud_access_token'];
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
