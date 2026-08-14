export type ErrorCode =
  | 'authentication_error'
  | 'browser_disconnected'
  | 'cancelled'
  | 'invalid_request'
  | 'login_required'
  | 'queue_full'
  | 'rate_limited'
  | 'security_challenge'
  | 'timeout'
  | 'ui_changed';

const statusByCode: Record<ErrorCode, number> = {
  authentication_error: 401,
  browser_disconnected: 503,
  cancelled: 499,
  invalid_request: 400,
  login_required: 503,
  queue_full: 429,
  rate_limited: 429,
  security_challenge: 503,
  timeout: 504,
  ui_changed: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly remediation: string | undefined;

  constructor(code: ErrorCode, message: string, remediation?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
    this.remediation = remediation;
  }
}

export function abortError(signal?: AbortSignal): AppError {
  return new AppError(
    signal?.reason instanceof AppError && signal.reason.code === 'timeout'
      ? 'timeout'
      : 'cancelled',
    signal?.reason instanceof AppError && signal.reason.code === 'timeout'
      ? 'The browser request timed out.'
      : 'The request was cancelled.',
  );
}

export function asSafeAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    'browser_disconnected',
    'The browser operation failed.',
    'Run `npm run doctor`, then retry. The prompt was not automatically resubmitted.',
  );
}
