import type { Logger } from 'pino';
import { ChatGptAdapter } from '../adapters/chatgpt/adapter.js';
import { WebTextAdapter } from '../adapters/web/adapter.js';
import { ApiTextAdapter } from '../adapters/api/adapter.js';
import type { BrowserController } from '../browser/controller.js';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import { isApiProvider, validateProviderConfiguration } from './catalog.js';

export function createProvider(browser: BrowserController, config: AppConfig, logger: Logger) {
  validateProviderConfiguration(config);
  if (isApiProvider(config.provider)) {
    if (
      !config.enablePaidApi ||
      config.providerApiKey === undefined ||
      config.providerApiModel === undefined
    ) {
      throw new AppError(
        'provider_unavailable',
        'Explicit API opt-in, provider key and exact model are required. Generation may incur charges.',
      );
    }
    if (config.concurrency !== 1 || config.temporaryChat) {
      throw new AppError(
        'provider_unavailable',
        'API mode requires concurrency 1 and temporary chat disabled.',
      );
    }
    return new ApiTextAdapter(config.provider, {
      apiKey: config.providerApiKey,
      model: config.providerApiModel,
      timeoutMs: config.requestTimeoutMs,
      maxOutputTokens: config.providerApiMaxOutputTokens,
    });
  }
  return config.provider === 'chatgpt-web'
    ? new ChatGptAdapter(browser, config, logger)
    : new WebTextAdapter(browser, config, config.provider);
}
