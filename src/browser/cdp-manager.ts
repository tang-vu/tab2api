import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import type { BrowserController } from './controller.js';

type ConnectFunction = (endpoint: string) => Promise<Browser>;

export class CdpBrowserManager implements BrowserController {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private connecting: Promise<BrowserContext> | undefined;
  private readonly ownedPages = new Set<Page>();
  private generation = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly connectFunction: ConnectFunction = (endpoint) =>
      chromium.connectOverCDP(endpoint, { timeout: 10_000 }),
  ) {
    if (config.browserCdpEndpoint === undefined) {
      throw new AppError('invalid_request', 'A loopback browser CDP endpoint is required.');
    }
  }

  async getPage(): Promise<Page> {
    const generation = this.generation;
    const context = await this.ensureContext();
    if (generation !== this.generation) throw this.connectionError();
    try {
      const page = await context.newPage();
      if (generation !== this.generation) {
        await page.close().catch(() => undefined);
        throw this.connectionError();
      }
      this.ownedPages.add(page);
      page.once('close', () => this.ownedPages.delete(page));
      return page;
    } catch {
      throw this.connectionError();
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    if (this.connecting !== undefined) await this.connecting.catch(() => undefined);
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    const pages = [...this.ownedPages];
    this.ownedPages.clear();
    await Promise.all(pages.map(async (page) => page.close().catch(() => undefined)));
    // For a connected browser Playwright documents close() as disconnecting from the
    // browser server. The desktop shell remains the owner of the Chromium process/profile.
    if (browser !== undefined) {
      await browser.close({ reason: 'tab2api sidecar disconnected' }).catch(() => undefined);
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.browser?.isConnected() && this.context !== undefined) return this.context;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.connect();
    try {
      this.context = await this.connecting;
      return this.context;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<BrowserContext> {
    const endpoint = this.config.browserCdpEndpoint;
    if (endpoint === undefined) throw this.connectionError();
    try {
      const browser = await this.connectFunction(endpoint);
      const context = browser.contexts().at(0);
      if (context === undefined) {
        await browser.close().catch(() => undefined);
        throw new Error('missing persistent browser context');
      }
      this.browser = browser;
      browser.once('disconnected', () => {
        if (this.browser === browser) {
          this.browser = undefined;
          this.context = undefined;
          this.ownedPages.clear();
        }
      });
      return context;
    } catch {
      throw this.connectionError();
    }
  }

  private connectionError(): AppError {
    return new AppError(
      'browser_disconnected',
      'Playwright could not attach to the app-managed browser.',
      'Restart the desktop browser session. The CDP endpoint must remain on loopback.',
    );
  }
}
