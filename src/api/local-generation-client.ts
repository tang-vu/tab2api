import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { UiEffort } from '../provider.js';
import type { FetchImplementation } from './local-admin-client.js';

/**
 * Loopback client for the generation-facing API surface (`/v1/*`). The CLI `chat` command and
 * the stdio MCP server both go through this instead of touching the provider directly, so
 * queueing, prompt budgets, drain rejection, and usage accounting behave identically to any
 * other API caller.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GENERATION_RESPONSE_BYTES = 16_777_216;
const MAX_RESPONSE_CHUNKS = 4_096;

export type LocalGenerationErrorCode =
  | 'cancelled'
  | 'invalid_response'
  | 'request_failed'
  | 'response_too_large'
  | 'timeout'
  | 'unreachable'
  | (string & {});

export class LocalGenerationError extends Error {
  /** Server-side error codes (for example `draining`, `queue_full`) pass through unchanged. */
  readonly code: LocalGenerationErrorCode;

  constructor(code: LocalGenerationErrorCode, message: string) {
    super(message);
    this.name = 'LocalGenerationError';
    this.code = code;
  }
}

interface LocalGenerationClientConfig {
  host: Pick<AppConfig, 'host'>['host'];
  port: number;
  apiToken: string;
}

export interface LocalGenerationClientOptions {
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
}

export interface ChatOptions {
  prompt: string;
  temporary?: boolean | undefined;
  reasoningEffort?: UiEffort | undefined;
  conversationId?: string | undefined;
  projectId?: string | undefined;
}

const chatCompletionResponseSchema = z
  .object({
    choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string() }) })).min(1),
  })
  .loose();

const countTokensResponseSchema = z
  .object({ input_tokens: z.number().int().nonnegative() })
  .loose();

const openAiErrorEnvelopeSchema = z
  .object({ error: z.looseObject({ code: z.string(), message: z.string() }) })
  .loose();

const anthropicErrorEnvelopeSchema = z
  .object({
    type: z.literal('error'),
    error: z.looseObject({ tab2api_code: z.string(), message: z.string() }),
  })
  .loose();

function loopbackOrigin(host: LocalGenerationClientConfig['host'], port: number): string {
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
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > MAX_GENERATION_RESPONSE_BYTES
    ) {
      await cancelBody(response);
      throw new LocalGenerationError(
        'invalid_response',
        'The local service returned an invalid response.',
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
      if (chunkCount > MAX_RESPONSE_CHUNKS || total > MAX_GENERATION_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LocalGenerationError(
          'response_too_large',
          'The local service response exceeded the client limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Extracts the typed error code from whichever envelope shape the route emitted. Anthropic
 * routes use `tab2api_code`; OpenAI-shaped routes use `code`. Unknown bodies degrade to the
 * HTTP status so callers still get an actionable failure.
 */
async function serverError(response: Response): Promise<LocalGenerationError> {
  try {
    const contents = await readBoundedBody(response);
    const openAi = openAiErrorEnvelopeSchema.safeParse(JSON.parse(contents));
    if (openAi.success) {
      return new LocalGenerationError(openAi.data.error.code, openAi.data.error.message);
    }
    const anthropic = anthropicErrorEnvelopeSchema.safeParse(JSON.parse(contents));
    if (anthropic.success) {
      return new LocalGenerationError(
        anthropic.data.error.tab2api_code,
        anthropic.data.error.message,
      );
    }
  } catch {
    // Fall through to the generic status error.
  }
  return new LocalGenerationError(
    'request_failed',
    `The local service request failed with HTTP ${response.status}.`,
  );
}

export class LocalGenerationClient {
  private readonly origin: string;
  private readonly bearerToken: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;

  constructor(config: LocalGenerationClientConfig, options: LocalGenerationClientOptions = {}) {
    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new Error('Local service port is invalid.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Local service timeout is invalid.');
    }
    this.origin = loopbackOrigin(config.host, config.port);
    this.bearerToken = config.apiToken;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  async chat(options: ChatOptions, signal?: AbortSignal): Promise<string> {
    const body = await this.post(
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: options.prompt }],
        ...(options.temporary === undefined ? {} : { temporary: options.temporary }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: options.reasoningEffort }),
        ...(options.conversationId === undefined
          ? {}
          : { conversation_id: options.conversationId }),
        ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
      },
      chatCompletionResponseSchema,
      signal,
    );
    const content = body.choices[0]?.message.content;
    if (content === undefined) {
      throw new LocalGenerationError(
        'invalid_response',
        'The local service returned an invalid response.',
      );
    }
    return content;
  }

  async countTokens(prompt: string, signal?: AbortSignal): Promise<number> {
    const body = await this.post(
      '/v1/messages/count_tokens',
      { model: 'chatgpt-web', messages: [{ role: 'user', content: prompt }] },
      countTokensResponseSchema,
      signal,
    );
    return body.input_tokens;
  }

  private async post<T>(
    pathname: string,
    payload: unknown,
    schema: z.ZodType<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([externalSignal, timeoutSignal]);
    try {
      const response = await this.fetchImplementation(`${this.origin}${pathname}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw await serverError(response);
      const contents = await readBoundedBody(response);
      try {
        return schema.parse(JSON.parse(contents));
      } catch {
        throw new LocalGenerationError(
          'invalid_response',
          'The local service returned an invalid response.',
        );
      }
    } catch (error) {
      if (error instanceof LocalGenerationError) throw error;
      if (externalSignal?.aborted === true) {
        throw new LocalGenerationError('cancelled', 'The local request was cancelled.');
      }
      if (timeoutSignal.aborted) {
        throw new LocalGenerationError(
          'timeout',
          `The local service request did not finish within ${this.timeoutMs} ms.`,
        );
      }
      throw new LocalGenerationError(
        'unreachable',
        'The local tab2api service is unavailable. Start it with `tab2api start` and retry.',
      );
    }
  }
}
