import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import type {
  GenerateRequest,
  GenerateResult,
  SessionState,
  WebChatProvider,
} from '../src/provider.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

const auth = { authorization: 'Bearer test-only-token-that-is-long-enough' };

class ErrorProvider implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;
  constructor(private readonly error: AppError) {}
  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw this.error;
  }
  async health(): Promise<SessionState> {
    return this.error.code === 'login_required' ? 'login_required' : 'ui_changed';
  }
  async reset(): Promise<void> {}
  async close(): Promise<void> {}
}

function server(provider: WebChatProvider, timeoutMs = 2_000) {
  return buildServer({
    config: testConfig({ requestTimeoutMs: timeoutMs }),
    provider,
    logger: createLogger('silent'),
  });
}

describe('Fastify API contract', () => {
  it('exposes liveness but protects model and generation routes', async () => {
    const app = server(new FakeProvider());
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('authentication_error');
    await app.close();
  });

  it('completes Chat Completions through a fake browser adapter', async () => {
    const provider = new FakeProvider('chat answer');
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'ignored-client-alias', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe('chatgpt-web');
    expect(response.json().choices[0].message.content).toBe('chat answer');
    expect(provider.prompts[0]).toContain('hello');
    await app.close();
  });

  it('completes a Responses request and buffered stream', async () => {
    const app = server(new FakeProvider('response answer'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'hello' },
    });
    expect(response.json().output[0].content[0].text).toBe('response answer');
    const stream = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'hello', stream: true },
    });
    expect(stream.headers['x-tab2api-stream-mode']).toBe('buffered');
    expect(stream.body).toContain('event: response.completed');
    expect(stream.body).not.toContain('[DONE]');
    await app.close();
  });

  it('serializes simultaneous API requests at default concurrency one', async () => {
    const provider = new FakeProvider('ok', 20);
    const app = server(provider);
    await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth,
        payload: { model: 'x', input: 'one' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth,
        payload: { model: 'x', input: 'two' },
      }),
    ]);
    expect(provider.maxActive).toBe(1);
    expect(provider.prompts[0]).toContain('one');
    expect(provider.prompts[1]).toContain('two');
    await app.close();
  });

  it.each([
    ['login_required', 503],
    ['security_challenge', 503],
    ['rate_limited', 429],
    ['ui_changed', 503],
  ] as const)('returns machine-readable %s errors', async (code, status) => {
    const app = server(new ErrorProvider(new AppError(code, `simulated ${code}`)));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'x', input: 'hello' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    await app.close();
  });

  it('aborts timed-out work and releases fake resources', async () => {
    const provider = new FakeProvider('late', 100);
    const app = server(provider, 10);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'x', input: 'hello' },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('timeout');
    expect(provider.active).toBe(0);
    await app.close();
  });

  it('rejects invalid request fields rather than silently ignoring them', async () => {
    const app = server(new FakeProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'x', messages: [{ role: 'user', content: 'x' }], tools: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    await app.close();
  });
});
