import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { anthropicModelFor } from '../src/providers/catalog.js';
import type { ProviderId } from '../src/provider.js';
import { testConfig } from './helpers.js';

const headers = { authorization: 'Bearer test-only-token-that-is-long-enough' };
const projectId = 'g-p-00000000000000000000000000000001';
const apps: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function server(id: ProviderId, delay = 0, timeout = 2_000) {
  const provider = new FakeProvider('provider answer', delay, id);
  const app = buildServer({
    config: testConfig({ provider: id, requestTimeoutMs: timeout }),
    provider,
    logger: createLogger('silent'),
    anthropicHeartbeatMs: 5,
  });
  apps.push(app);
  return { app, provider };
}

function chat(model: string, stream = false) {
  return { model, messages: [{ role: 'user', content: 'hello' }], stream };
}

describe('multi-provider API contract', () => {
  it('rejects mismatched configuration and adapter', () => {
    expect(() =>
      buildServer({
        config: testConfig({ provider: 'grok-web' }),
        provider: new FakeProvider(),
        logger: createLogger('silent'),
      }),
    ).toThrow(/does not match/);
  });

  it.each(['claude-web', 'grok-web', 'claude-api', 'grok-api', 'meta-api'] as const)(
    'discovers only actual %s capabilities without browser activity',
    async (id) => {
      const { app, provider } = server(id);
      const health = vi.spyOn(provider, 'health');
      expect((await app.inject({ url: '/v1/providers' })).statusCode).toBe(401);
      const discovery = await app.inject({ url: '/v1/providers', headers });
      expect(discovery.json().selected).toBe(id);
      expect(discovery.json().data).toContainEqual(
        expect.objectContaining({
          id,
          selected: true,
          liveVerified: false,
          capabilities: {
            text: true,
            attachments: false,
            images: false,
            transcription: false,
            projects: false,
            conversations: false,
            temporaryChat: false,
            effort: false,
            streamMode: 'buffered',
          },
        }),
      );
      const models = await app.inject({ url: '/v1/models', headers });
      expect(models.json().data.map((entry: { id: string }) => entry.id)).toEqual([
        id,
        anthropicModelFor(id),
        'system-tts',
      ]);
      expect(health).not.toHaveBeenCalled();
      expect(provider.prompts).toEqual([]);
    },
  );

  it.each(['claude-web', 'grok-web', 'claude-api', 'grok-api', 'meta-api'] as const)(
    'returns truthful %s model IDs over JSON and buffered SSE',
    async (id) => {
      const { app } = server(id);
      for (const stream of [false, true]) {
        const completion = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: chat(id, stream),
        });
        expect(completion.statusCode).toBe(200);
        expect(completion.body).toContain(`"model":"${id}"`);
        expect(completion.body).not.toContain('chatgpt-web');
        const response = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: { model: id, input: 'hello', stream },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain(`"model":"${id}"`);
        expect(response.body).not.toContain('chatgpt-web');
        const message = await app.inject({
          method: 'POST',
          url: '/v1/messages',
          headers,
          payload: { ...chat(anthropicModelFor(id), stream), max_tokens: 100 },
        });
        expect(message.statusCode).toBe(200);
        expect(message.body).toContain(`"model":"${anthropicModelFor(id)}"`);
        expect(message.body).not.toContain('chatgpt-web');
        if (stream) expect(message.body).toContain('event: message_stop');
      }
    },
  );

  it.each(['claude-web', 'grok-web', 'claude-api', 'grok-api', 'meta-api'] as const)(
    'does not silently reroute requests away from %s',
    async (id) => {
      const { app, provider } = server(id);
      for (const url of ['/v1/chat/completions', '/v1/messages']) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...chat('chatgpt-web'), ...(url === '/v1/messages' && { max_tokens: 100 }) },
        });
        expect(response.statusCode).toBe(400);
      }
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages/count_tokens',
        headers,
        payload: chat('chatgpt-web'),
      });
      expect(response.statusCode).toBe(400);
      expect(provider.prompts).toEqual([]);
    },
  );

  it('preserves ChatGPT and rejects another reserved provider ID', async () => {
    const { app, provider } = server('chatgpt-web');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chat('grok-web'),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.prompts).toEqual([]);
    const models = await app.inject({ url: '/v1/models', headers });
    expect(models.json().data).toHaveLength(5);
  });

  it.each(['claude-web', 'grok-web', 'claude-api', 'grok-api', 'meta-api'] as const)(
    'rejects all unsupported %s features before queueing/browser work',
    async (id) => {
      const { app, provider } = server(id);
      for (const option of [
        { temporary: true },
        { reasoning_effort: 'high' },
        { conversation_id: '00000000-0000-4000-8000-000000000001' },
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
              ],
            },
          ],
        },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: { ...chat(id), ...option },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('unsupported_capability');
      }
      for (const [method, url, payload] of [
        ['POST', '/v1/images/generations', { prompt: 'image' }],
        ['POST', '/v1/audio/transcriptions', {}],
        ['POST', '/v1/projects', { name: 'project' }],
        ['GET', '/v1/projects', undefined],
        ['DELETE', `/v1/projects/${projectId}`, undefined],
        ['POST', `/v1/projects/${projectId}/files`, {}],
        ['POST', `/v1/projects/${projectId}/chat/completions`, chat(id)],
        ['POST', '/v1/responses', { model: id, input: 'hello', reasoning: { effort: 'high' } }],
        ['POST', '/v1/messages', { ...chat(id, true), max_tokens: 100, temporary: true }],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers,
          ...(payload !== undefined && { payload }),
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.body, url).toContain('unsupported_capability');
      }
      expect(provider.prompts).toEqual([]);
      expect(provider.imagePrompts).toEqual([]);
      expect(provider.createdProjectNames).toEqual([]);
      expect(provider.uploads).toEqual([]);
    },
  );

  it.each(['timeout', 'security_challenge', 'submission_uncertain'] as const)(
    'emits typed %s SSE errors without a false completion',
    async (code) => {
      const { app, provider } = server('grok-web');
      vi.spyOn(provider, 'generate').mockRejectedValue(new AppError(code, 'synthetic failure'));
      const result = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers,
        payload: { ...chat('grok-web', true), max_tokens: 100 },
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('event: error');
      expect(result.body).toContain(`"tab2api_code":"${code}"`);
      expect(result.body).not.toContain('event: message_stop');
    },
  );

  it('times out work after SSE headers and frees provider activity', async () => {
    const { app, provider } = server('grok-web', 60_000, 20);
    const result = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: { ...chat('grok-web', true), max_tokens: 100 },
    });
    expect(result.body).toContain('"tab2api_code":"timeout"');
    expect(provider.active).toBe(0);
  });

  it('cancels a new-provider stream when its local client disconnects', async () => {
    const { app, provider } = server('claude-web', 60_000, 5_000);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...chat('claude-web', true), max_tokens: 100 }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(provider.active).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(provider.active).toBe(0));
  });
});
