import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { MulterError } from 'multer';
import type { Response } from 'express';
import { handleException } from '../utils/handleException';

@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const body = handleException(exception);
    res.status(body.statusCode >= 400 && body.statusCode < 600 ? body.statusCode : 400).json(body);
  }
}
