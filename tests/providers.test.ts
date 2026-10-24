import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  PROVIDER_CATALOG,
  anthropicModelFor,
  assertProviderCapability,
  assertProviderModel,
  assertTextCapabilities,
  providerCapabilities,
  validateProviderConfiguration,
} from '../src/providers/catalog.js';
import { chatSse, mapChatCompletion, mapResponse, responsesSse } from '../src/api/mappers.js';
import { anthropicMessageStartSse, mapAnthropicMessage } from '../src/api/anthropic.js';
import { assertPromptWithinLimit } from '../src/observability/tokens.js';

const environment = {
  TAB2API_API_TOKEN: 'test-only-token-that-is-long-enough',
  TAB2API_DATA_DIR: '.runtime',
  TAB2API_PROFILE_DIR: '.runtime/profile',
};

describe('provider configuration and discovery', () => {
  it('keeps ChatGPT as the default', async () => {
    expect(await loadConfig(environment, '/tmp/tab2api-provider-config-test')).toMatchObject({
      provider: 'chatgpt-web',
      experimentalProviders: false,
      providerPermission: undefined,
    });
    expect(providerCapabilities('chatgpt-web').projects).toBe(true);
    expect(PROVIDER_CATALOG.find(({ id }) => id === 'meta-ai-web')).toMatchObject({
      status: 'not-implemented',
      liveVerified: false,
      capabilities: { text: false },
    });
  });

  it.each(['claude-web', 'grok-web'] as const)(
    'gates %s independently and before browser use',
    async (provider) => {
      const config = { provider, experimentalProviders: false, providerPermission: undefined };
      expect(() => validateProviderConfiguration(config)).toThrow(/actual provider permission/);
      expect(() =>
        validateProviderConfiguration({ ...config, experimentalProviders: true }),
      ).toThrow(/disabled/);
      expect(() =>
        validateProviderConfiguration({
          ...config,
          experimentalProviders: true,
          providerPermission: provider === 'claude-web' ? 'grok-web' : 'claude-web',
        }),
      ).toThrow(/disabled/);
      expect(() =>
        validateProviderConfiguration({
          ...config,
          experimentalProviders: true,
          providerPermission: provider,
        }),
      ).not.toThrow();
      await expect(
        loadConfig(
          { ...environment, TAB2API_PROVIDER: provider },
          '/tmp/tab2api-provider-config-test',
        ),
      ).rejects.toThrow(/disabled/);
      expect(
        await loadConfig(
          {
            ...environment,
            TAB2API_PROVIDER: provider,
            TAB2API_EXPERIMENTAL_PROVIDERS: 'true',
            TAB2API_PROVIDER_PERMISSION: provider,
          },
          '/tmp/tab2api-provider-config-test',
        ),
      ).toMatchObject({ provider });
    },
  );

  it.each(['muse', 'meta-ai-web', 'https://attacker.invalid', 'unknown'])(
    'does not guess provider %s',
    async (provider) => {
      await expect(
        loadConfig(
          { ...environment, TAB2API_PROVIDER: provider },
          '/tmp/tab2api-provider-config-test',
        ),
      ).rejects.toThrow();
    },
  );
});

describe('provider-specific capability and identity contracts', () => {
  it('keeps legacy ChatGPT aliases but never reroutes reserved identities', () => {
    expect(() => assertProviderModel('chatgpt-web', 'old-client-alias')).not.toThrow();
    for (const model of ['claude-web', 'grok-web', 'meta-ai-web', 'claude-tab2api-grok-web']) {
      expect(() => assertProviderModel('chatgpt-web', model)).toThrow(/not available/);
    }
    expect(() => assertProviderModel('grok-web', 'chatgpt-web')).toThrow(/not available/);
    expect(() => assertProviderModel('claude-web', 'claude-sonnet')).toThrow(/not available/);
    expect(() => assertProviderModel('grok-web', 'grok-web')).not.toThrow();
    expect(() => assertProviderModel('claude-web', anthropicModelFor('claude-web'))).not.toThrow();
  });

  it.each(['claude-web', 'grok-web'] as const)(
    'rejects unsupported %s options without dropping them',
    (provider) => {
      expect(providerCapabilities(provider).text).toBe(true);
      expect(() =>
        assertTextCapabilities(provider, { temporary: false, attachments: [] }),
      ).not.toThrow();
      const options = [
        {
          attachments: [
            { data: Buffer.from('image'), mimeType: 'image/png' as const, filename: 'image.png' },
          ],
        },
        { projectId: 'g-p-test' },
        { conversationId: 'id' },
        { temporary: true },
        { effort: 'high' as const },
      ];
      for (const request of options)
        expect(() => assertTextCapabilities(provider, request)).toThrow(/does not support/);
      expect(() => assertProviderCapability(provider, 'images')).toThrow(/does not support/);
      expect(() => assertProviderCapability('chatgpt-web', 'images')).not.toThrow();
      expect(() => assertPromptWithinLimit('x', 0, 0, provider)).toThrow(/single-message ceiling/);
    },
  );

  it.each(['claude-web', 'grok-web'] as const)(
    'labels JSON and all SSE variants with %s, not ChatGPT',
    (provider) => {
      const completion = mapChatCompletion('answer', 0, undefined, provider);
      const response = mapResponse('answer', 0, undefined, provider);
      expect(completion.model).toBe(provider);
      expect(chatSse(completion)).toContain(`"model":"${provider}"`);
      expect(chatSse(completion)).not.toContain('chatgpt-web');
      expect(response.model).toBe(provider);
      expect(responsesSse(response)).not.toContain('chatgpt-web');
      const model = anthropicModelFor(provider);
      expect(mapAnthropicMessage('answer', new Set(), 'msg_1', model).model).toBe(model);
      expect(anthropicMessageStartSse('msg_1', model)).toContain(`"model":"${model}"`);
    },
  );
});
