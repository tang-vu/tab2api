import type { AppConfig } from '../config/index.js';
import type { BrowserController } from './controller.js';
import { GpmBrowserManager } from './gpm-manager.js';
import { BrowserManager } from './manager.js';
import { CdpBrowserManager } from './cdp-manager.js';

export function createBrowserController(config: AppConfig): BrowserController {
  if (config.browserBackend === 'gpm') return new GpmBrowserManager(config);
  return config.browserCdpEndpoint === undefined
    ? new BrowserManager(config)
    : new CdpBrowserManager(config);
}
