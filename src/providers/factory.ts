import type { Logger } from 'pino';
import { ChatGptAdapter } from '../adapters/chatgpt/adapter.js';
import { WebTextAdapter } from '../adapters/web/adapter.js';
import type { BrowserController } from '../browser/controller.js';
import type { AppConfig } from '../config/index.js';
import { validateProviderConfiguration } from './catalog.js';

export function createProvider(browser: BrowserController, config: AppConfig, logger: Logger) {
  validateProviderConfiguration(config);
  return config.provider === 'chatgpt-web'
    ? new ChatGptAdapter(browser, config, logger)
    : new WebTextAdapter(browser, config, config.provider);
}
