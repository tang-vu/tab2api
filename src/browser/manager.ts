import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config/index.js';

export class BrowserManager {
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;

  constructor(private readonly config: AppConfig) {}

  async getPage(): Promise<Page> {
    let context = await this.ensureContext();
    if (!context.browser()?.isConnected()) {
      await this.close();
      context = await this.ensureContext();
    }
    return context.newPage();
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.context?.browser()?.isConnected()) return this.context;
    if (this.launching !== undefined) return this.launching;
    this.launching = this.launch();
    try {
      this.context = await this.launching;
      return this.context;
    } finally {
      this.launching = undefined;
    }
  }

  async close(): Promise<void> {
    const current = this.context;
    this.context = undefined;
    if (current !== undefined) await current.close().catch(() => undefined);
  }

  isConnected(): boolean {
    return this.context?.browser()?.isConnected() ?? false;
  }

  private async launch(): Promise<BrowserContext> {
    await mkdir(this.config.profileDir, { recursive: true, mode: 0o700 });
    if (this.config.debug) await mkdir(this.config.artifactDir, { recursive: true, mode: 0o700 });
    try {
      const context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        acceptDownloads: false,
        viewport: { width: 1280, height: 900 },
        timeout: 30_000,
        // No remote-debugging TCP port. Playwright's private transport is used.
      });
      context.on('close', () => {
        if (this.context === context) this.context = undefined;
      });
      return context;
    } catch {
      throw new AppError(
        'browser_disconnected',
        'Could not launch the dedicated Chromium profile.',
        'Run `npx playwright install chromium`, close other tab2api browser windows, then retry.',
      );
    }
  }
}
