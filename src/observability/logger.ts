import pino, { type Logger, type LoggerOptions } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'request.headers.authorization',
  'headers.authorization',
  'req.headers.cf-access-client-secret',
  'request.headers.cf-access-client-secret',
  'headers.cf-access-client-secret',
  'authorization',
  'apiToken',
  'token',
  'clientSecret',
  'secret',
  'digest',
  'password',
  'cookie',
  'cookies',
  'prompt',
  'response',
  'body',
];

export function loggerOptions(level = 'info'): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      req(request: { id?: string; method?: string; url?: string }) {
        return { id: request.id, method: request.method, url: request.url };
      },
      err(error: Error & { code?: string }) {
        return { type: error.name, message: error.message, code: error.code };
      },
    },
  };
}

export function createLogger(level = 'info'): Logger {
  return pino(loggerOptions(level));
}
