import type { Page } from 'playwright';

export interface BrowserController {
  getPage(): Promise<Page>;
  close(): Promise<void>;
}
