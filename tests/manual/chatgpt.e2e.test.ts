import { describe, expect, it } from 'vitest';
import { ChatGptAdapter } from '../../src/adapters/chatgpt/adapter.js';
import { createBrowserController } from '../../src/browser/factory.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/observability/logger.js';

const enabled = process.env.TAB2API_MANUAL_E2E === '1';

describe.skipIf(!enabled)('manual authenticated ChatGPT E2E', () => {
  it('generates only with explicit opt-in and an existing manual login', async () => {
    const config = await loadConfig();
    const browser = createBrowserController({ ...config, headless: false });
    const adapter = new ChatGptAdapter(browser, config, createLogger('info'));
    try {
      expect(await adapter.health()).toBe('ready');
      const result = await adapter.generate({
        prompt: 'Reply with exactly: tab2api manual e2e ok',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        requestId: 'manual-e2e',
      });
      expect(result.text.toLowerCase()).toContain('tab2api manual e2e ok');
    } finally {
      await adapter.close();
    }
  });
});
