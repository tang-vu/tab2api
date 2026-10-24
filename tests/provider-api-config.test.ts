import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createProvider } from '../src/providers/factory.js';
import { createLogger } from '../src/observability/logger.js';
import { ApiTextAdapter } from '../src/adapters/api/adapter.js';
import { sessionResetResponseSchema } from '../src/api/admin-contract.js';
import { buildServer } from '../src/api/server.js';
import { testConfig } from './helpers.js';

let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'tab2api-api-config-'));
});
afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

const environment = {
  TAB2API_API_TOKEN: 'test-only-token-that-is-long-enough',
  TAB2API_DATA_DIR: '.runtime',
  TAB2API_PROFILE_DIR: '.runtime/profile',
};
const providers = [
  ['claude-api', 'TAB2API_CLAUDE_API_KEY'],
  ['grok-api', 'TAB2API_GROK_API_KEY'],
  ['meta-api', 'TAB2API_META_API_KEY'],
] as const;
const apps: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function payload(id: string) {
  return id === 'claude-api'
    ? {
        id: 'synthetic-message',
        type: 'message',
        role: 'assistant',
        model: 'exact-test-model',
        content: [{ type: 'text', text: 'API answer' }],
        stop_reason: 'end_turn',
      }
    : {
        id: 'synthetic-completion',
        object: 'chat.completion',
        model: 'exact-test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'API answer' },
            finish_reason: 'stop',
          },
        ],
      };
}

describe('explicit official API configuration', () => {
  it.each(providers)(
    'requires %s opt-in and its own key, not another provider key',
    async (id, key) => {
      const base = { ...environment, TAB2API_PROVIDER: id, TAB2API_API_MODEL: 'exact-test-model' };
      await expect(
        loadConfig({ ...base, [key]: 'synthetic-test-key' }, temporaryRoot),
      ).rejects.toThrow(/ENABLE_PAID_API/);
      await expect(
        loadConfig({ ...base, TAB2API_ENABLE_PAID_API: 'true' }, temporaryRoot),
      ).rejects.toThrow(/provider-specific key/);
      await expect(
        loadConfig(
          {
            ...base,
            TAB2API_ENABLE_PAID_API: 'true',
            [key === 'TAB2API_CLAUDE_API_KEY' ? 'TAB2API_GROK_API_KEY' : 'TAB2API_CLAUDE_API_KEY']:
              'wrong-provider-key',
          },
          temporaryRoot,
        ),
      ).rejects.toThrow(/provider-specific key/);
      const config = await loadConfig(
        { ...base, TAB2API_ENABLE_PAID_API: 'true', [key]: 'synthetic-test-key' },
        temporaryRoot,
      );
      expect(config).toMatchObject({
        provider: id,
        enablePaidApi: true,
        providerApiKey: 'synthetic-test-key',
        providerApiModel: 'exact-test-model',
        providerApiMaxOutputTokens: 4096,
      });
      const browser = {
        getPage: vi.fn().mockRejectedValue(new Error('No browser')),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const adapter = createProvider(browser, config, createLogger('silent'));
      expect(adapter.id).toBe(id);
      expect(await adapter.health()).toBe('api_configured');
      expect(JSON.stringify(adapter)).not.toContain('synthetic-test-key');
      expect(browser.getPage).not.toHaveBeenCalled();
      expect(() =>
        createProvider(browser, { ...config, enablePaidApi: false }, createLogger('silent')),
      ).toThrow(/Explicit API opt-in/);
      expect(() =>
        createProvider(browser, { ...config, concurrency: 2 }, createLogger('silent')),
      ).toThrow(/concurrency 1/);
    },
  );

  it('rejects missing models, unsafe keys, temporary mode and concurrent API configuration', async () => {
    const base = {
      ...environment,
      TAB2API_PROVIDER: 'meta-api',
      TAB2API_ENABLE_PAID_API: 'true',
      TAB2API_META_API_KEY: 'synthetic-test-key',
      TAB2API_API_MODEL: 'exact-test-model',
    };
    for (const changes of [
      { TAB2API_API_MODEL: '' },
      { TAB2API_META_API_KEY: 'unsafe\nkey' },
      { TAB2API_CONCURRENCY: '2' },
      { TAB2API_TEMPORARY_CHAT: 'true' },
    ]) {
      await expect(loadConfig({ ...base, ...changes }, temporaryRoot)).rejects.toThrow();
    }
    const webConfig = await loadConfig(
      { ...environment, TAB2API_META_API_KEY: 'unused-key', TAB2API_API_MODEL: 'unused-model' },
      temporaryRoot,
    );
    expect(webConfig.providerApiKey).toBeUndefined();
    expect(webConfig.providerApiModel).toBeUndefined();
  });

  it.each(providers)(
    'serves %s end to end with a mocked official transport and no readiness probe',
    async (id) => {
      const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(JSON.stringify(payload(id)), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const provider = new ApiTextAdapter(id, {
        apiKey: 'synthetic-test-key',
        model: 'exact-test-model',
        timeoutMs: 1000,
        fetchImplementation,
      });
      const config = testConfig({ provider: id });
      const app = buildServer({ config, provider, logger: createLogger('silent') });
      apps.push(app);
      const headers = { authorization: `Bearer ${config.apiToken}` };
      const ready = await app.inject({ url: '/readyz', headers });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ status: 'not_ready', session: 'api_configured' });
      const session = await app.inject({ url: '/admin/session', headers });
      expect(session.json()).toEqual({ state: 'api_configured' });
      const models = await app.inject({ url: '/v1/models', headers });
      expect(models.json().data[0]).toMatchObject({ id, owned_by: 'user-provider-api-account' });
      const reset = await app.inject({ method: 'POST', url: '/admin/session/reset', headers });
      expect(sessionResetResponseSchema.parse(reset.json())).toEqual({
        status: 'reset',
        detail: 'API transport reset; configured credentials were not changed.',
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: { model: id, messages: [{ role: 'user', content: 'hello' }], stream: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('API answer');
      expect(response.body).toContain(`"model":"${id}"`);
      expect(response.body).toContain('[DONE]');
      expect(fetchImplementation).toHaveBeenCalledOnce();
      const wrongProvider = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'hello' }] },
      });
      expect(wrongProvider.statusCode).toBe(400);
      expect(fetchImplementation).toHaveBeenCalledOnce();
    },
  );
});
