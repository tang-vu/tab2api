import type { AppConfig } from '../config/index.js';
import type { BrowserController } from './controller.js';
import { GpmBrowserManager } from './gpm-manager.js';
import { BrowserManager } from './manager.js';

export function createBrowserController(config: AppConfig): BrowserController {
  return config.browserBackend === 'gpm'
    ? new GpmBrowserManager(config)
    : new BrowserManager(config);
}
