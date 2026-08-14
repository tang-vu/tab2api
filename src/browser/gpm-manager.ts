import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import type { BrowserController } from './controller.js';

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;
type ConnectFunction = (endpoint: string) => Promise<Browser>;

const envelopeSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

const startSchema = envelopeSchema.extend({
  data: z.object({
    profile_id: z.string(),
    remote_debugging_port: z.number().int().positive(),
    websocket_debugging_url: z.url(),
  }),
});

export class GpmBrowserManager implements BrowserController {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private connecting: Promise<BrowserContext> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchFunction: FetchFunction = fetch,
    private readonly connectFunction: ConnectFunction = (endpoint) =>
      chromium.connectOverCDP(endpoint),
  ) {
    if (config.gpmProfileId === undefined) {
      throw new AppError('invalid_request', 'A single GPM Login profile ID is required.');
    }
  }

  async getPage(): Promise<Page> {
    const context = await this.ensureContext();
    return context.newPage();
  }

  async checkApi(): Promise<void> {
    await this.request(`/profiles/${this.profileId}`);
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
    await this.request(`/profiles/stop/${this.profileId}`).catch(() => undefined);
  }

  private get profileId(): string {
    const value = this.config.gpmProfileId;
    if (value === undefined)
      throw new AppError('invalid_request', 'GPM Login profile ID is missing.');
    return value;
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
    const raw = await this.request(`/profiles/start/${this.profileId}`);
    const started = startSchema.safeParse(raw);
    if (!started.success || !started.data.success) {
      throw new AppError(
        'browser_disconnected',
        'GPM Login could not start the configured profile.',
        'Open GPM Login and verify the configured profile ID and Local API URL.',
      );
    }
    const endpoint = new URL(started.data.data.websocket_debugging_url);
    if (
      endpoint.protocol !== 'ws:' ||
      (endpoint.hostname !== '127.0.0.1' &&
        endpoint.hostname !== 'localhost' &&
        endpoint.hostname !== '[::1]')
    ) {
      throw new AppError(
        'browser_disconnected',
        'GPM Login returned a non-loopback DevTools endpoint; connection was refused.',
      );
    }
    try {
      const browser = await this.connectFunction(endpoint.toString());
      const context = browser.contexts().at(0);
      if (context === undefined) {
        await browser.close().catch(() => undefined);
        throw new Error('missing default context');
      }
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser === browser) {
          this.browser = undefined;
          this.context = undefined;
        }
      });
      return context;
    } catch {
      throw new AppError(
        'browser_disconnected',
        'Playwright could not attach to the GPM Login browser.',
        'Update GPM Login and ensure its returned DevTools endpoint remains on loopback.',
      );
    }
  }

  private async request(pathname: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFunction(`${this.config.gpmBaseUrl}${pathname}`, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(
        'browser_disconnected',
        'The GPM Login Local API is unavailable.',
        'Start GPM Login and verify its Local API port.',
      );
    }
    if (!response.ok) {
      throw new AppError(
        'browser_disconnected',
        `GPM Login Local API returned HTTP ${response.status}.`,
      );
    }
    const raw: unknown = await response.json();
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success || !envelope.data.success) {
      throw new AppError('browser_disconnected', 'GPM Login Local API reported a failure.');
    }
    return raw;
  }
}
