import { HttpException, HttpStatus, ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response } from 'express';

export class SuspendedUserException extends HttpException {
  constructor() {
    super(
      {
        message: 'Account suspended',
        code: 'USER_SUSPENDED',
        data: null,
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

@Catch(SuspendedUserException)
export class SuspendedUserFilter implements ExceptionFilter {
  catch(exception: SuspendedUserException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const clearOpts = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
    };
    // Only clear Cloud session cookies — never Task Manager access_token
    response.clearCookie('cloud_access_token', clearOpts);
    response.clearCookie('cloud_refresh_token', clearOpts);

    const status = exception.getStatus();
    const body = exception.getResponse();
    response.status(status).json(body);
  }
}
