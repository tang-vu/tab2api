import { AppError } from '../../errors.js';
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  ListProjectsRequest,
  ProjectSummary,
  SessionState,
  UploadProjectFilesRequest,
  UploadProjectFilesResult,
  WebChatProvider,
} from '../../provider.js';
import { ApiDeadline } from './deadline.js';
import { invalidResponse, parseApiText } from './response.js';

export type ApiProviderId = 'claude-api' | 'grok-api' | 'meta-api';

export interface ApiTextAdapterOptions {
  apiKey: string;
  /** Exact model ID required. Aliases resolving to different response IDs fail closed. */
  model: string;
  timeoutMs: number;
  /** Upper output-token bound, default 4096, maximum 16384. Not a monetary spend limit. */
  maxOutputTokens?: number;
  fetchImplementation?: typeof fetch;
}

export const API_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const API_RESPONSE_MAX_CHUNKS = 4096;
const REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const PROMPT_MAX_BYTES = 1024 * 1024;

/**
 * Explicit official API transport, never an automatic fallback from a browser provider.
 * Contract verified against official documentation on 2026-10-24:
 * https://platform.claude.com/docs/en/api/messages/create
 * https://platform.claude.com/docs/en/api/versioning
 * https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
 * https://docs.x.ai/developers/model-capabilities/text/comparison
 * https://dev.meta.ai/docs/protocols/chat-completions
 *
 * Buffered, stateless, one user message, no tools or media. Generation may incur charges.
 * Construction and health never validate a key by making an API request. xAI's Chat
 * Completions surface is officially legacy; no Responses API features are implied.
 */
export class ApiTextAdapter implements WebChatProvider {
  readonly #id: ApiProviderId;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof fetch;
  #active: AbortController | undefined;

  constructor(id: ApiProviderId, options: ApiTextAdapterOptions) {
    this.#id = id;
    // Runtime validation matters for JavaScript callers too. No user values in errors.
    this.#endpoint = endpointFor(id);
    if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey)) {
      throw new AppError('provider_unavailable', 'An explicit, valid API key is required.');
    }
    if (
      typeof options.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(options.model)
    ) {
      throw new AppError('provider_unavailable', 'An explicit, valid API model ID is required.');
    }
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 600_000
    ) {
      throw new AppError('provider_unavailable', 'API timeout must be between 1 and 600000 ms.');
    }
    const { maxOutputTokens = 4096 } = options;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) {
      throw new AppError(
        'provider_unavailable',
        'API output-token limit must be between 1 and 16384.',
      );
    }
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputTokens = maxOutputTokens;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  get id(): ApiProviderId {
    return this.#id;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.assertSupported(request);
    if (this.#active) {
      throw new AppError('provider_unavailable', 'An API generation is already in progress.');
    }
    const active = new AbortController();
    this.#active = active;
    const deadline = new ApiDeadline(
      this.#timeoutMs,
      AbortSignal.any([request.signal, active.signal]),
    );
    let response: Response | undefined;
    try {
      deadline.check();
      const body = this.requestBody(request.prompt);
      response = await deadline.run(async () => {
        try {
          const received = await this.#fetch(this.#endpoint, {
            method: 'POST',
            headers: this.requestHeaders(),
            body,
            signal: deadline.signal,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
          });
          response = received;
          // A fetch implementation may ignore abort and deliver headers after timeout.
          if (deadline.signal.aborted) {
            cancelBody(received);
            throw deadline.error();
          }
          return received;
        } catch {
          if (deadline.signal.aborted) throw deadline.error();
          throw new AppError(
            'provider_unavailable',
            'The API transport failed. The request may have been processed; it was not retried.',
          );
        }
      });
      if (response.redirected || (response.url !== '' && response.url !== this.#endpoint)) {
        throw new AppError(
          'provider_unavailable',
          'The API response used an unexpected destination.',
        );
      }
      this.assertStatus(response.status);
      const json = await this.readResponse(response, deadline);
      deadline.check();
      const text = parseApiText(json, this.#model, this.#id === 'claude-api');
      deadline.check();
      return { text, providerModel: this.#id };
    } finally {
      deadline.dispose();
      if (response) cancelBody(response);
      if (this.#active === active) this.#active = undefined;
    }
  }

  /** Configuration-only readiness, not a network, authentication, or billing probe. */
  async health(): Promise<SessionState> {
    return this.sessionState();
  }

  sessionState(): SessionState {
    return this.#active ? 'generation_in_progress' : 'api_configured';
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    // Abort locally; no remote cancellation request and no assertion that billing stops.
    this.#active?.abort();
  }

  async generateImage(_request: GenerateImageRequest): Promise<GenerateImageResult> {
    throw unsupported();
  }

  async createProject(_request: CreateProjectRequest): Promise<ProjectSummary> {
    throw unsupported();
  }

  async listProjects(_request: ListProjectsRequest): Promise<readonly ProjectSummary[]> {
    throw unsupported();
  }

  async deleteProject(_request: DeleteProjectRequest): Promise<void> {
    throw unsupported();
  }

  async uploadProjectFiles(_request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult> {
    throw unsupported();
  }

  private assertSupported(request: GenerateRequest): void {
    if (
      (request.attachments?.length ?? 0) > 0 ||
      request.projectId !== undefined ||
      request.conversationId !== undefined ||
      request.temporary === true ||
      request.effort !== undefined
    ) {
      throw unsupported();
    }
    if (
      typeof request.prompt !== 'string' ||
      request.prompt.trim().length === 0 ||
      Buffer.byteLength(request.prompt, 'utf8') > PROMPT_MAX_BYTES
    ) {
      throw new AppError('invalid_request', 'API text prompts must be nonempty and at most 1 MiB.');
    }
  }

  private requestHeaders(): Record<string, string> {
    return this.#id === 'claude-api'
      ? {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': '2026-10-21',
        }
      : {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        };
  }

  private requestBody(prompt: string): string {
    const body = JSON.stringify({
      model: this.#model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...(this.#id === 'meta-api'
        ? { max_completion_tokens: this.#maxOutputTokens }
        : { max_tokens: this.#maxOutputTokens }),
    });
    if (Buffer.byteLength(body, 'utf8') > REQUEST_MAX_BYTES) {
      throw new AppError('invalid_request', 'The serialized API request exceeds 2 MiB.');
    }
    return body;
  }

  private assertStatus(status: number): void {
    if (status === 200) return;
    if (status === 401 || status === 403) {
      throw new AppError('authentication_error', 'The API rejected authentication or access.');
    }
    if (status === 429) {
      throw new AppError('rate_limited', 'The API reported a rate limit. No retry was attempted.');
    }
    if (status === 408 || status === 504) {
      throw new AppError('timeout', 'The API reported a timeout. No retry was attempted.');
    }
    throw new AppError(
      'provider_unavailable',
      'The API rejected the request. No retry was attempted.',
    );
  }

  private async readResponse(response: Response, deadline: ApiDeadline): Promise<unknown> {
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json' || !response.body) throw invalidResponse();
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > API_RESPONSE_MAX_BYTES)
    ) {
      throw invalidResponse();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts: string[] = [];
    let bytes = 0;
    let chunks = 0;
    try {
      for (;;) {
        const result = await deadline.run(() => reader.read());
        if (result.done) break;
        bytes += result.value.byteLength;
        chunks += 1;
        if (bytes > API_RESPONSE_MAX_BYTES || chunks > API_RESPONSE_MAX_CHUNKS) {
          throw invalidResponse();
        }
        parts.push(decoder.decode(result.value, { stream: true }));
      }
      parts.push(decoder.decode());
      const value: unknown = JSON.parse(parts.join(''));
      return value;
    } catch {
      if (deadline.signal.aborted) throw deadline.error();
      // Never surface stream, JSON or schema diagnostics, which can include content.
      throw invalidResponse();
    } finally {
      // Cancellation is best effort and must not extend the request's deadline.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function endpointFor(id: ApiProviderId): string {
  switch (id) {
    case 'claude-api':
      return 'https://api.anthropic.com/v1/messages';
    case 'grok-api':
      return 'https://api.x.ai/v1/chat/completions';
    case 'meta-api':
      return 'https://api.meta.ai/v1/chat/completions';
    default:
      throw new AppError('provider_unavailable', 'The API provider is not supported.');
  }
}

function unsupported(): AppError {
  return new AppError(
    'unsupported_capability',
    'This API adapter only supports text, without media, projects, conversation IDs, temporary mode, or effort controls.',
  );
}

function cancelBody(response: Response): void {
  if (response.body && !response.body.locked) {
    // Cleanup errors are intentionally discarded, not reported or logged with headers.
    void response.body.cancel().catch(() => undefined);
  }
}
