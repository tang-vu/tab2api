import pino from 'pino';
import { ChatGptAdapter } from '../adapters/chatgpt/adapter.js';
import { buildServer } from '../api/server.js';
import { createBrowserController } from '../browser/factory.js';
import { loadConfig } from '../config/index.js';
import { loggerOptions } from '../observability/logger.js';
import { ApiKeyStore } from '../security/api-keys.js';
import { UsageStore } from '../store/usage.js';
import type { SidecarAddress, SidecarOperations } from './lifecycle.js';

export class PackagedSidecarOperations implements SidecarOperations {
  private app: ReturnType<typeof buildServer> | undefined;

  async start(): Promise<SidecarAddress> {
    if (
      process.env.TAB2API_BROWSER_BACKEND !== undefined &&
      process.env.TAB2API_BROWSER_BACKEND !== 'playwright'
    ) {
      throw new Error(
        'The packaged desktop sidecar supports only its app-managed Playwright browser.',
      );
    }
    const config = await loadConfig({ ...process.env, TAB2API_BROWSER_BACKEND: 'playwright' });
    // A synchronous stderr destination cannot leave an async writer handle keeping the
    // packaged child alive after its parent requests a graceful shutdown.
    const destination = pino.destination({ fd: 2, sync: true });
    const logger = pino(loggerOptions(config.logLevel), destination);
    const browser = createBrowserController(config);
    const provider = new ChatGptAdapter(browser, config, logger);
    const [apiKeys, usage] = await Promise.all([
      ApiKeyStore.load(config.dataDir, config.apiToken),
      UsageStore.load(config.dataDir),
    ]);
    const app = buildServer({ config, provider, logger, apiKeys, usage });
    this.app = app;
    try {
      await app.listen({ host: config.host, port: config.port });
      return { host: config.host, port: config.port };
    } catch (error) {
      this.app = undefined;
      await app.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app !== undefined) await app.close();
  }
}
