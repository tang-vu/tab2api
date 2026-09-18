export type ErrorCode =
  | 'authentication_error'
  | 'audio_unavailable'
  | 'attachment_failed'
  | 'browser_disconnected'
  | 'cancelled'
  | 'composer_unavailable'
  | 'conversation_not_found'
  | 'draining'
  | 'generation_interrupted'
  | 'generation_timeout'
  | 'invalid_request'
  | 'login_required'
  | 'navigation_failed'
  | 'project_not_found'
  | 'prompt_too_large'
  | 'queue_full'
  | 'rate_limited'
  | 'security_challenge'
  | 'storage_unavailable'
  | 'submission_uncertain'
  | 'timeout'
  | 'ui_changed'
  | 'unsupported_capability';

const statusByCode: Record<ErrorCode, number> = {
  authentication_error: 401,
  audio_unavailable: 503,
  attachment_failed: 503,
  browser_disconnected: 503,
  cancelled: 499,
  composer_unavailable: 503,
  conversation_not_found: 404,
  draining: 503,
  generation_interrupted: 502,
  generation_timeout: 504,
  invalid_request: 400,
  login_required: 503,
  navigation_failed: 503,
  project_not_found: 404,
  prompt_too_large: 413,
  queue_full: 429,
  rate_limited: 429,
  security_challenge: 503,
  storage_unavailable: 503,
  submission_uncertain: 502,
  timeout: 504,
  ui_changed: 503,
  unsupported_capability: 400,
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
