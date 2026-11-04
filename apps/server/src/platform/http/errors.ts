import { ZodError } from 'zod';
import type { ApiError } from '@career/contracts';
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
export function publicError(error: unknown): ApiError {
  if (error instanceof AppError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof ZodError)
    return {
      code: 'VALIDATION_ERROR',
      message: '输入不符合要求，请检查字段、长度和选项。',
      retryable: false,
    };
  return { code: 'INTERNAL_ERROR', message: '操作未完成，请重试。', retryable: true };
}
