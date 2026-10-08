import { CommonResponse } from '../common/commonResponse';
import { HttpException, HttpStatus } from '@nestjs/common';

function extractMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const res = error.getResponse();
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object') {
      const msg = (res as { message?: string | string[] }).message;
      if (Array.isArray(msg)) return msg.join(', ');
      if (typeof msg === 'string' && msg.trim()) return msg;
    }
    return error.message || 'Request failed';
  }
  if (error && typeof error === 'object') {
    const anyErr = error as { code?: string; message?: string };
    if (anyErr.code === 'LIMIT_FILE_SIZE') return 'File terlalu besar untuk diunggah';
    if (typeof anyErr.message === 'string' && anyErr.message.trim()) return anyErr.message;
  }
  if (typeof error === 'string') return error;
  return 'Internal server error';
}

function extractStatus(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  if (error && typeof error === 'object') {
    const anyErr = error as { code?: string; status?: number; statusCode?: number };
    if (anyErr.code === 'LIMIT_FILE_SIZE') return HttpStatus.PAYLOAD_TOO_LARGE;
    if (typeof anyErr.statusCode === 'number') return anyErr.statusCode;
    if (typeof anyErr.status === 'number') return anyErr.status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

export function handleException(error: unknown) {
  return new CommonResponse(extractMessage(error), extractStatus(error), null);
}
