import { CommonResponse } from '../common/commonResponse';
import { HttpStatus } from '@nestjs/common';

export function handleException(message: string) {
  return new CommonResponse(message, HttpStatus.INTERNAL_SERVER_ERROR, null);
}
