import { Buffer } from 'node:buffer';
import type { ZodType } from 'zod';
import type { AppConfig } from '../config/index.js';
import {
  apiKeyCreateRequestSchema,
  apiKeyListResponseSchema,
  apiKeyRevokeResponseSchema,
  createdApiKeyResponseSchema,
  healthResponseSchema,
  sessionResetResponseSchema,
  usageResetResponseSchema,
  usageResponseSchema,
  type ApiKeyListResponse,
  type CreatedApiKeyResponse,
  type UsageResponse,
} from './admin-contract.js';
import { apiKeyIdSchema } from '../security/api-keys.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ADMIN_RESPONSE_BYTES = 2_621_440;
const MAX_RESPONSE_CHUNKS = 4_096;

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalAdminErrorCode =
  | 'authentication_failed'
  | 'cancelled'
  | 'invalid_response'
  | 'request_failed'
  | 'response_too_large'
  | 'timeout'
  | 'unexpected_service'
  | 'unreachable';

export class LocalAdminError extends Error {
  readonly code: LocalAdminErrorCode;

  constructor(code: LocalAdminErrorCode, message: string) {
    super(message);
    this.name = 'LocalAdminError';
    this.code = code;
  }
}

interface LocalAdminClientConfig {
  host: Pick<AppConfig, 'host'>['host'];
  port: number;
  apiToken: string;
}

export interface LocalAdminClientOptions {
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
}

function loopbackOrigin(host: LocalAdminClientConfig['host'], port: number): string {
  const address = host === '::1' ? '[::1]' : host;
  return `http://${address}:${port}`;
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel();
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new LocalAdminError(
        'invalid_response',
        'The local service returned an invalid response.',
      );
    }
    if (declared > MAX_ADMIN_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new LocalAdminError(
        'response_too_large',
        'The local service response exceeded the administration limit.',
      );
    }
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      total += value.byteLength;
      if (chunkCount > MAX_RESPONSE_CHUNKS || total > MAX_ADMIN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LocalAdminError(
          'response_too_large',
          'The local service response exceeded the administration limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function parseJsonResponse<T>(response: Response, schema: ZodType<T>): Promise<T> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    await cancelBody(response);
    throw new LocalAdminError(
      'invalid_response',
      'The local service returned an invalid response.',
    );
  }
  const contents = await readBoundedBody(response);
  try {
    const parsed: unknown = JSON.parse(contents);
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof LocalAdminError) throw error;
    throw new LocalAdminError(
      'invalid_response',
      'The local service returned an invalid response.',
    );
  }
}

function httpFailure(status: number): LocalAdminError {
  if (status === 401) {
    return new LocalAdminError(
      'authentication_failed',
      'The local service rejected the administrator key.',
    );
  }
  return new LocalAdminError(
    'request_failed',
    `The local administration request failed with HTTP ${status}.`,
  );
}

export class LocalAdminClient {
  private readonly origin: string;
  private readonly adminToken: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly createTimeoutSignal: (timeoutMs: number) => AbortSignal;

  constructor(config: LocalAdminClientConfig, options: LocalAdminClientOptions = {}) {
    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new Error('Local administration port is invalid.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Local administration timeout is invalid.');
    }
    this.origin = loopbackOrigin(config.host, config.port);
    this.adminToken = config.apiToken;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.createTimeoutSignal =
      options.createTimeoutSignal ?? ((durationMs) => AbortSignal.timeout(durationMs));
  }

  async listApiKeys(signal?: AbortSignal): Promise<ApiKeyListResponse> {
    return this.request('/admin/api-keys', apiKeyListResponseSchema, { method: 'GET' }, signal);
  }

  async createApiKey(label: string, signal?: AbortSignal): Promise<CreatedApiKeyResponse> {
    const parsed = apiKeyCreateRequestSchema.safeParse({ label });
    if (!parsed.success) {
      throw new LocalAdminError(
        'request_failed',
        'API key label must contain 1-80 visible characters.',
      );
    }
    return this.request(
      '/admin/api-keys',
      createdApiKeyResponseSchema,
      { method: 'POST', body: JSON.stringify(parsed.data) },
      signal,
    );
  }

  async revokeApiKey(id: string, signal?: AbortSignal): Promise<void> {
    const parsed = apiKeyIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new LocalAdminError('request_failed', 'API key identifier is invalid.');
    }
    await this.request(
      `/admin/api-keys/${parsed.data}`,
      apiKeyRevokeResponseSchema,
      { method: 'DELETE' },
      signal,
    );
  }

  async usage(signal?: AbortSignal): Promise<UsageResponse> {
    return this.request('/admin/usage', usageResponseSchema, { method: 'GET' }, signal);
  }

  async resetUsage(signal?: AbortSignal): Promise<void> {
    await this.request('/admin/usage', usageResetResponseSchema, { method: 'DELETE' }, signal);
  }

  async resetSession(signal?: AbortSignal): Promise<void> {
    await this.request(
      '/admin/session/reset',
      sessionResetResponseSchema,
      { method: 'POST' },
      signal,
    );
  }

  private async request<T>(
    pathname: string,
    schema: ZodType<T>,
    request: { method: 'DELETE' | 'GET' | 'POST'; body?: string },
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = this.createTimeoutSignal(this.timeoutMs);
    const signal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([externalSignal, timeoutSignal]);
    try {
      await this.verifyIdentity(signal);
      const response = await this.fetchImplementation(`${this.origin}${pathname}`, {
        method: request.method,
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.adminToken}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (!response.ok) {
        await cancelBody(response);
        throw httpFailure(response.status);
      }
      return await parseJsonResponse(response, schema);
    } catch (error) {
      if (error instanceof LocalAdminError) throw error;
      if (externalSignal?.aborted === true) {
        throw new LocalAdminError('cancelled', 'The local administration request was cancelled.');
      }
      if (timeoutSignal.aborted) {
        throw new LocalAdminError(
          'timeout',
          `The local administration request did not finish within ${this.timeoutMs} ms.`,
        );
      }
      throw new LocalAdminError(
        'unreachable',
        'The local tab2api service is unavailable. Start it and retry.',
      );
    }
  }

  private async verifyIdentity(signal: AbortSignal): Promise<void> {
    const response = await this.fetchImplementation(`${this.origin}/healthz`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      await cancelBody(response);
      throw new LocalAdminError(
        'unexpected_service',
        'The configured loopback port is not serving tab2api; the administrator key was not sent.',
      );
    }
    try {
      await parseJsonResponse(response, healthResponseSchema);
    } catch (error) {
      if (error instanceof LocalAdminError && error.code === 'response_too_large') throw error;
      throw new LocalAdminError(
        'unexpected_service',
        'The configured loopback port is not serving tab2api; the administrator key was not sent.',
      );
    }
  }
}
