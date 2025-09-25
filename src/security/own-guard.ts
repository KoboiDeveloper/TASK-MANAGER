import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OWN_KEY } from './own.decorator';
import { Request } from 'express';

interface RequestWithUser extends Request {
  user: {
    nik: string;
    roleId?: string[];
    [key: string]: any;
  };
}

@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const needOwner = this.reflector.getAllAndOverride<boolean>(OWN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!needOwner) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userNik = request.user?.nik;
    const userRoles = request.user?.roleId || [];
    const paramNik = request.params?.nik;

    if (userRoles.includes('SUPER')) {
      return true;
    }

    if (!userNik || userNik !== paramNik) {
      throw new ForbiddenException('You are not the owner of this resource');
    }

    return true;
  }
}
