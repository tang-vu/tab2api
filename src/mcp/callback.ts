import { z } from 'zod';
import { AppError } from '../errors.js';

/**
 * Loopback dispatch for broker tool calls. The registering caller supplies a URL that must be
 * `http://127.0.0.1:<port>` or `http://[::1]:<port>` with no credentials and an unprivileged
 * port — the same loopback rules the CDP endpoint check enforces. The callback receives a
 * compact invocation payload and returns `{ "result": "..." }` or `{ "error": "..." }` as
 * bounded JSON. Redirects are refused so a callback can never steer the service outward.
 */

const MAX_CALLBACK_RESPONSE_BYTES = 262_144;
const MAX_CALLBACK_RESPONSE_CHUNKS = 1_024;
const MAX_CALLBACK_URL_LENGTH = 512;
const MAX_RESULT_CHARS = 200_000;
const MAX_ERROR_CHARS = 2_000;

export class ToolCallbackError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'invalid_response' | 'rejected' | 'timeout' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallbackError';
  }
}

export function assertLoopbackCallbackUrl(value: string): string {
  if (value.length > MAX_CALLBACK_URL_LENGTH) {
    throw new AppError('invalid_request', 'The tool callback URL exceeds 512 characters.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('invalid_request', 'The tool callback URL is not a valid URL.');
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port === '' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    parsed.hash !== ''
  ) {
    throw new AppError(
      'invalid_request',
      'The tool callback URL must be exactly http://127.0.0.1:<port>/path or http://[::1]:<port>/path with an unprivileged port and no credentials.',
    );
  }
  return parsed.toString();
}

const callbackSuccessSchema = z.object({ result: z.string().max(MAX_RESULT_CHARS) }).strict();
const callbackErrorSchema = z.object({ error: z.string().min(1).max(MAX_ERROR_CHARS) }).strict();

async function readBoundedCallbackBody(response: Response): Promise<string> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CALLBACK_RESPONSE_BYTES) {
      if (response.body !== null) await response.body.cancel();
      throw new ToolCallbackError(
        'invalid_response',
        'The tool callback returned an oversized or invalid response.',
      );
    }
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (chunks.length >= MAX_CALLBACK_RESPONSE_CHUNKS || total > MAX_CALLBACK_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ToolCallbackError(
          'invalid_response',
          'The tool callback response exceeded the size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export interface ToolInvocationPayload {
  turn_id: string;
  call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export type CallbackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function dispatchToolCallback(options: {
  url: string;
  bearerToken: string | undefined;
  payload: ToolInvocationPayload;
  signal: AbortSignal;
  fetchImplementation?: CallbackFetch;
}): Promise<string> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImplementation(options.url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.bearerToken === undefined
          ? {}
          : { authorization: `Bearer ${options.bearerToken}` }),
      },
      body: JSON.stringify(options.payload),
    });
  } catch {
    if (options.signal.aborted) {
      const reason = options.signal.reason as { name?: unknown } | undefined;
      const timeout =
        reason !== undefined &&
        (reason.name === 'TimeoutError' ||
          (reason instanceof AppError && reason.code === 'timeout'));
      throw new ToolCallbackError(
        timeout ? 'timeout' : 'cancelled',
        timeout
          ? 'The tool callback did not answer before the timeout.'
          : 'The tool call was cancelled.',
      );
    }
    throw new ToolCallbackError(
      'unavailable',
      'The tool callback is unreachable. Check that the registered local handler is running.',
    );
  }
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel();
    throw new ToolCallbackError(
      'unavailable',
      `The tool callback answered with HTTP ${response.status}.`,
    );
  }
  const contents = await readBoundedCallbackBody(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ToolCallbackError('invalid_response', 'The tool callback returned non-JSON content.');
  }
  const failure = callbackErrorSchema.safeParse(parsed);
  if (failure.success) {
    throw new ToolCallbackError('rejected', failure.data.error);
  }
  const success = callbackSuccessSchema.safeParse(parsed);
  if (!success.success) {
    throw new ToolCallbackError(
      'invalid_response',
      'The tool callback must return {"result": "..."} or {"error": "..."}.',
    );
  }
  return success.data.result;
}
