import { HttpException, HttpStatus } from '@nestjs/common';
import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
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

    response.clearCookie('access_token', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
    });

    // Return structured response
    const status = exception.getStatus();
    const body = exception.getResponse();

    response.status(status).json(body);
  }
}
