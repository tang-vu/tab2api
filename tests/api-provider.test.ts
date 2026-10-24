import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_RESPONSE_MAX_BYTES,
  API_RESPONSE_MAX_CHUNKS,
  ApiTextAdapter,
  type ApiProviderId,
  type ApiTextAdapterOptions,
} from '../src/adapters/api/adapter.js';
import { AppError } from '../src/errors.js';
import type { GenerateRequest } from '../src/provider.js';

const SECRET = 'synthetic-test-key-not-a-real-credential';
const PROMPT = 'A synthetic prompt that must never appear in errors.';
const models: Record<ApiProviderId, string> = {
  'claude-api': 'claude-exact-test-version',
  'grok-api': 'grok-exact-test-version',
  'meta-api': 'muse-spark-exact-test-version',
};
const endpoints: Record<ApiProviderId, string> = {
  'claude-api': 'https://api.anthropic.com/v1/messages',
  'grok-api': 'https://api.x.ai/v1/chat/completions',
  'meta-api': 'https://api.meta.ai/v1/chat/completions',
};

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    prompt: PROMPT,
    signal: new AbortController().signal,
    requestId: 'synthetic-request-id',
    ...overrides,
  };
}

function chatPayload(model = models['grok-api']): Record<string, unknown> {
  return {
    id: 'synthetic-completion-id',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'A complete answer.' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

function claudePayload(): Record<string, unknown> {
  return {
    id: 'synthetic-message-id',
    type: 'message',
    role: 'assistant',
    model: models['claude-api'],
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'A complete answer.' }],
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a serialized request body.');
  const parsed: unknown = JSON.parse(init.body);
  return parsed;
}

function adapter(
  fetchImplementation: typeof fetch,
  id: ApiProviderId = 'grok-api',
  overrides: Partial<ApiTextAdapterOptions> = {},
): ApiTextAdapter {
  return new ApiTextAdapter(id, {
    apiKey: SECRET,
    model: models[id],
    timeoutMs: 1000,
    fetchImplementation,
    ...overrides,
  });
}

function stalledResponse(cancel = vi.fn()): Response {
  return new Response(new ReadableStream<Uint8Array>({ cancel }), {
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  // Any accidentally unmocked network call fails. No API key is read from the environment.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Live API calls are forbidden in tests.');
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('official API transport, mocked and never paid/live', () => {
  it.each<ApiProviderId>(['claude-api', 'grok-api', 'meta-api'])(
    'sends one buffered text request to the fixed %s endpoint',
    async (id) => {
      const fetchImplementation = vi.fn<typeof fetch>(async () =>
        jsonResponse(id === 'claude-api' ? claudePayload() : chatPayload(models[id])),
      );
      const provider = adapter(fetchImplementation, id);
      expect(provider.id).toBe(id);
      await expect(
        provider.generate(request({ temporary: false, attachments: [] })),
      ).resolves.toEqual({
        text: 'A complete answer.',
        providerModel: id,
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImplementation.mock.calls[0] ?? [];
      expect(url).toBe(endpoints[id]);
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('accept')).toBe('application/json');
      if (id === 'claude-api') {
        expect(headers.get('x-api-key')).toBe(SECRET);
        expect(headers.get('anthropic-version')).toBe('2026-10-21');
        expect(headers.has('authorization')).toBe(false);
      } else {
        expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
        expect(headers.has('x-api-key')).toBe(false);
      }
      expect(parseRequestBody(init)).toEqual({
        model: models[id],
        messages: [{ role: 'user', content: PROMPT }],
        stream: false,
        ...(id === 'meta-api' ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
      });
      expect(init?.signal?.aborted).toBe(true);
    },
  );

  it('accepts split UTF-8 and multiple Claude text blocks without dropping text', async () => {
    const payload = {
      ...claudePayload(),
      content: [
        { type: 'text', text: 'Xin chào 🌞', citations: [] },
        { type: 'text', text: '\nBye' },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const provider = adapter(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        }),
      'claude-api',
    );
    await expect(provider.generate(request())).resolves.toMatchObject({
      text: 'Xin chào 🌞\nBye',
    });
  });

  it('allows a Claude textual refusal without retrying or switching models', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...claudePayload(),
        stop_reason: 'refusal',
      }),
    );
    await expect(
      adapter(fetchImplementation, 'claude-api').generate(request()),
    ).resolves.toMatchObject({ text: 'A complete answer.' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('deliberately excludes provider reasoning from final assistant text', async () => {
    const payload = {
      ...chatPayload(),
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Final answer.',
            reasoning_content: 'Not answer text',
            tool_calls: [],
            function_call: null,
            refusal: null,
            audio: null,
            annotations: [],
          },
        },
      ],
    };
    await expect(
      adapter(async () => jsonResponse(payload)).generate(request()),
    ).resolves.toMatchObject({ text: 'Final answer.' });
  });

  it('uses an explicit custom output limit and retains immutable copied configuration', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(chatPayload()));
    const options = {
      apiKey: SECRET,
      model: models['grok-api'],
      timeoutMs: 1000,
      maxOutputTokens: 33,
      fetchImplementation,
    };
    const provider = new ApiTextAdapter('grok-api', options);
    options.apiKey = 'different';
    options.model = 'different';
    expect(() => Object.assign(provider, { id: 'meta-api' })).toThrow();
    await provider.generate(request());
    expect(parseRequestBody(fetchImplementation.mock.calls[0]?.[1])).toMatchObject({
      model: models['grok-api'],
      max_tokens: 33,
    });
    expect(new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${SECRET}`,
    );
    expect(inspect(provider, { showHidden: true })).not.toContain(SECRET);
    expect(JSON.stringify(provider)).not.toContain(SECRET);
  });

  it('uses the captured default fetch only for generate, never health, session, close, or reset', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(chatPayload()));
    vi.stubGlobal('fetch', fetchImplementation);
    const provider = new ApiTextAdapter('grok-api', {
      apiKey: SECRET,
      model: models['grok-api'],
      timeoutMs: 1000,
    });
    expect(provider.sessionState()).toBe('api_configured');
    await expect(provider.health()).resolves.toBe('api_configured');
    await provider.close();
    await provider.reset();
    expect(fetchImplementation).not.toHaveBeenCalled();
    await provider.generate(request());
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(provider.sessionState()).toBe('api_configured');
  });

  it.each([
    { apiKey: '' },
    { apiKey: ' key' },
    { apiKey: 'x\nInjected: y' },
    { apiKey: 'x'.repeat(4097) },
    { model: '' },
    { model: 'model with space' },
    { model: 'x'.repeat(201) },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 600001 },
    { timeoutMs: NaN },
    { timeoutMs: 1.5 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 16385 },
    { maxOutputTokens: 1.5 },
  ])('rejects invalid configuration before network: %j', (overrides) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    expect(() => adapter(fetchImplementation, 'grok-api', overrides)).toThrow(AppError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('validates unexpected JavaScript configuration types and provider IDs without coercion', () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    for (const [id, overrides] of [
      ['unrecognized-api', {}],
      ['grok-api', { apiKey: undefined }],
      ['grok-api', { apiKey: null }],
      ['grok-api', { model: undefined }],
      ['grok-api', { model: null }],
      ['grok-api', { maxOutputTokens: null }],
    ]) {
      expect(() => {
        Reflect.construct(ApiTextAdapter, [
          id,
          {
            apiKey: SECRET,
            model: models['grok-api'],
            timeoutMs: 1000,
            fetchImplementation,
            ...(typeof overrides === 'object' && overrides !== null ? overrides : {}),
          },
        ]);
      }).toThrow(AppError);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each<Partial<GenerateRequest>>([
    {
      attachments: [
        {
          filename: 'test.png',
          mimeType: 'image/png',
          data: Buffer.from('fake'),
        },
      ],
    },
    { projectId: 'project' },
    { conversationId: 'conversation' },
    { temporary: true },
    { effort: 'high' },
  ])('rejects unsupported request options without network: %j', async (options) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(adapter(fetchImplementation).generate(request(options))).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t', 'x'.repeat(1024 * 1024 + 1), '\u0000'.repeat(400000)])(
    'rejects empty or oversized input without network (%#)',
    async (prompt) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      await expect(
        adapter(fetchImplementation).generate(request({ prompt })),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it('rejects every unsupported method before network', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = adapter(fetchImplementation);
    const common = {
      signal: new AbortController().signal,
      requestId: 'synthetic-request-id',
    };
    const results = await Promise.allSettled([
      provider.generateImage({ ...common, prompt: PROMPT }),
      provider.createProject({ ...common, name: 'test' }),
      provider.listProjects(common),
      provider.deleteProject({ ...common, projectId: 'test' }),
      provider.uploadProjectFiles({
        ...common,
        projectId: 'test',
        attachments: [],
      }),
    ]);
    expect(results).toHaveLength(5);
    for (const result of results)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: 'unsupported_capability' },
      });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication_error'],
    [403, 'authentication_error'],
    [429, 'rate_limited'],
    [408, 'timeout'],
    [504, 'timeout'],
    [400, 'provider_unavailable'],
    [402, 'provider_unavailable'],
    [500, 'provider_unavailable'],
    [302, 'provider_unavailable'],
    [201, 'provider_unavailable'],
  ])('sanitizes HTTP %i and never retries', async (status, code) => {
    const cancel = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${PROMPT} ${SECRET}`));
            },
            cancel,
          }),
          {
            status,
            headers: {
              location: 'https://attacker.invalid/',
              'x-debug': SECRET,
            },
          },
        ),
    );
    const error: unknown = await adapter(fetchImplementation)
      .generate(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(PROMPT);
    expect(String(error)).not.toContain('attacker');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport errors even when they are AppErrors', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      throw new AppError('rate_limited', `${PROMPT} ${SECRET}`);
    });
    const error: unknown = await adapter(fetchImplementation)
      .generate(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(PROMPT);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each(['redirected', 'url'])(
    'rejects an unexpected %s response even from a custom transport',
    async (property) => {
      const response = jsonResponse(chatPayload());
      Object.defineProperty(response, property, {
        value: property === 'redirected' ? true : 'https://attacker.invalid/',
      });
      await expect(adapter(async () => response).generate(request())).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
    },
  );

  it.each([
    null,
    [],
    {},
    { ...chatPayload(), model: 'another-model' },
    { ...chatPayload(), id: '' },
    { ...chatPayload(), object: 'chat.completion.chunk' },
    { ...chatPayload(), choices: [] },
    {
      ...chatPayload(),
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'One' },
        },
        {
          index: 1,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Two' },
        },
      ],
    },
    ...['length', 'tool_calls', 'function_call', 'content_filter', null].map((finish_reason) => ({
      ...chatPayload(),
      choices: [
        {
          index: 0,
          finish_reason,
          message: { role: 'assistant', content: 'Partial' },
        },
      ],
    })),
    ...[
      { role: 'user', content: 'Wrong role' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: [{ type: 'text', text: 'Nested' }] },
      { role: 'assistant', content: 'Text', tool_calls: [{ id: 'call' }] },
      { role: 'assistant', content: 'Text', function_call: { name: 'f' } },
      { role: 'assistant', content: 'Text', audio: { data: 'secret' } },
      {
        role: 'assistant',
        content: 'Text',
        unexpected_output: 'hidden output',
      },
      { role: 'assistant', content: 'Text', refusal: 'Refused' },
    ].map((message) => ({
      ...chatPayload(),
      choices: [{ index: 0, finish_reason: 'stop', message }],
    })),
  ])('fails closed for malformed/partial/tool-bearing chat response %#', async (payload) => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse(payload));
    await expect(adapter(fetchImplementation).generate(request())).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ...[
      'max_tokens',
      'pause_turn',
      'tool_use',
      'model_context_window_exceeded',
      'stop_sequence',
      null,
    ].map((stop_reason) => ({ ...claudePayload(), stop_reason })),
    { ...claudePayload(), model: 'another-model' },
    { ...claudePayload(), content: [] },
    { ...claudePayload(), content: [{ type: 'text', text: '  ' }] },
    {
      ...claudePayload(),
      content: [
        { type: 'text', text: 'Answer' },
        { type: 'tool_use', id: 'call' },
      ],
    },
    {
      ...claudePayload(),
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'Answer' },
      ],
    },
    {
      ...claudePayload(),
      content: [{ type: 'text', text: 'Answer', citations: [{ cited_text: 'Source' }] }],
    },
  ])('fails closed for incomplete, non-text, or mismatched Claude response %#', async (payload) => {
    await expect(
      adapter(async () => jsonResponse(payload), 'claude-api').generate(request()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it.each([
    () =>
      new Response(`not json ${SECRET}`, {
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response(JSON.stringify(chatPayload()), {
        headers: { 'content-type': 'text/html' },
      }),
    () => new Response(null, { headers: { 'content-type': 'application/json' } }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      jsonResponse(chatPayload(), {
        headers: { 'content-length': 'not-a-length' },
      }),
    () =>
      jsonResponse(chatPayload(), {
        headers: { 'content-length': String(API_RESPONSE_MAX_BYTES + 1) },
      }),
  ])(
    'rejects invalid envelope or encoding without revealing raw content %#',
    async (makeResponse) => {
      const error: unknown = await adapter(async () => makeResponse())
        .generate(request())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'provider_unavailable' });
      expect(String(error)).not.toContain(SECRET);
    },
  );

  it('bounds actual bytes even when the response lies about content length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(API_RESPONSE_MAX_BYTES + 1));
      },
      cancel,
    });
    await expect(
      adapter(
        async () =>
          new Response(stream, {
            headers: {
              'content-type': 'application/json',
              'content-length': '1',
            },
          }),
      ).generate(request()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds even empty chunks so a microtask-only stream cannot run forever', async () => {
    let chunks = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel,
    });
    await expect(
      adapter(
        async () =>
          new Response(stream, {
            headers: { 'content-type': 'application/json' },
          }),
      ).generate(request()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(chunks).toBeLessThanOrEqual(API_RESPONSE_MAX_CHUNKS + 2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('sanitizes body-stream errors and ignores cleanup rejection without waiting', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(SECRET));
      },
    });
    const error: unknown = await adapter(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
    )
      .generate(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect(String(error)).not.toContain(SECRET);
  });

  it('cancels before sending when caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(SECRET);
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      adapter(fetchImplementation).generate(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('preserves an external timeout category without exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new AppError('timeout', SECRET));
    const error: unknown = await adapter(vi.fn<typeof fetch>())
      .generate(request({ signal: controller.signal }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(String(error)).not.toContain(SECRET);
  });

  it('times out a fetch that ignores abort, without retry or unhandled late rejection', async () => {
    vi.useFakeTimers();
    let rejectLate: ((error: Error) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );
    const provider = adapter(fetchImplementation, 'grok-api', {
      timeoutMs: 20,
    });
    const pending = expect(provider.generate(request())).rejects.toMatchObject({
      code: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    rejectLate?.(new Error(SECRET));
    await Promise.resolve();
    expect(provider.sessionState()).toBe('api_configured');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces elapsed wall-clock budget even before the timer callback can execute', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(Date.now() + 100);
      return stalledResponse(cancel);
    });
    await expect(
      adapter(fetchImplementation, 'grok-api', { timeoutMs: 20 }).generate(request()),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the body of a response whose headers arrive after timeout', async () => {
    vi.useFakeTimers();
    let resolveLate: ((value: Response) => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const pending = expect(
      adapter(fetchImplementation, 'grok-api', { timeoutMs: 20 }).generate(request()),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    const cancel = vi.fn();
    resolveLate?.(stalledResponse(cancel));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('includes stalled body reads and stalled cancellation in the original deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImplementation = vi.fn<typeof fetch>(async () => stalledResponse(cancel));
    const pending = expect(
      adapter(fetchImplementation, 'grok-api', { timeoutMs: 20 }).generate(request()),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['caller', 'close', 'reset'] as const)(
    'aborts a stalled body via %s without making another call',
    async (source) => {
      const controller = new AbortController();
      const cancel = vi.fn();
      const fetchImplementation = vi.fn<typeof fetch>(async () => stalledResponse(cancel));
      const provider = adapter(fetchImplementation);
      const pending = expect(
        provider.generate(request({ signal: controller.signal })),
      ).rejects.toMatchObject({ code: 'cancelled' });
      await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
      expect(provider.sessionState()).toBe('generation_in_progress');
      if (source === 'caller') controller.abort(new Error(SECRET));
      else await provider[source]();
      await pending;
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(provider.sessionState()).toBe('api_configured');
    },
  );

  it('does not allow a second concurrent request to add a second paid operation', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const provider = adapter(fetchImplementation);
    const pending = expect(
      provider.generate(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(provider.generate(request())).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    controller.abort();
    await pending;
    expect(fetchImplementation.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
