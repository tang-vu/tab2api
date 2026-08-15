import type { AppConfig } from '../config/index.js';
import type { BrowserController } from './controller.js';
import { BrowserManager } from './manager.js';
import { CdpBrowserManager } from './cdp-manager.js';

export function createBrowserController(config: AppConfig): BrowserController {
  return config.browserCdpEndpoint === undefined
    ? new BrowserManager(config)
    : new CdpBrowserManager(config);
}
