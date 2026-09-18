import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, readonly retryAfterSeconds?: number) {
    super({ code, message }, status);
  }
}
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'Request fields are invalid.');
  return result.data;
}
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'The request could not be completed.';
    if (exception instanceof ApiError) {
      status = exception.getStatus();
      ({ code, message } = exception.getResponse() as {code: string; message: string});
      if (exception.retryAfterSeconds) res.setHeader('Retry-After', exception.retryAfterSeconds);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST';
      message = status === 404 ? 'Resource not found.' : status === 413 ? 'Request body exceeds the allowed size.' : 'Request could not be accepted.';
    } else if (typeof exception === 'object' && exception !== null && 'status' in exception) {
      if (exception.status === 413) {
        status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body exceeds the allowed size.';
      } else if (exception.status === 400) {
        status = 400; code = 'INVALID_JSON'; message = 'Request body must be valid JSON.';
      }
    }
    const requestId = typeof res.getHeader('X-Request-Id') === 'string' ? res.getHeader('X-Request-Id') : randomUUID();
    // Do not log bodies, URLs with query secrets, DB messages, or stack traces.
    if (status >= 500) console.error(JSON.stringify({level: 'error', requestId, method: req.method, status, code}));
    res.status(status).json({error: {code, message, requestId, ...(exception instanceof ApiError && exception.retryAfterSeconds ? {retryAfterSeconds: exception.retryAfterSeconds} : {})}});
  }
}
