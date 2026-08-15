import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ChatGptAdapter } from '../src/adapters/chatgpt/adapter.js';
import type { BrowserController } from '../src/browser/controller.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import { testConfig } from './helpers.js';

class FakeLocator {
  constructor(
    private readonly visible: boolean,
    private readonly countValue = 0,
  ) {}
  first(): this {
    return this;
  }
  async isVisible(): Promise<boolean> {
    return this.visible;
  }
  async count(): Promise<number> {
    return this.countValue;
  }
  nth(): this {
    return this;
  }
  async innerText(): Promise<string> {
    return '';
  }
  async getAttribute(): Promise<string | null> {
    return null;
  }
  async fill(_value: string): Promise<void> {}
  async press(_key: string): Promise<void> {}
  async click(): Promise<void> {}
}

class FakePage {
  closed = false;
  navigations = 0;
  currentUrl = 'https://chatgpt.com/';
  waits = 0;

  constructor(private readonly mode: 'ready' | 'delayed' | 'login' | 'unknown') {}
  async goto(): Promise<void> {
    this.navigations += 1;
  }
  async waitForTimeout(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.waits += 1;
  }
  url(): string {
    return this.currentUrl;
  }
  isClosed(): boolean {
    return this.closed;
  }
  locator(selector: string): Locator {
    const ready = this.mode === 'ready' || (this.mode === 'delayed' && this.waits > 0);
    const composer = selector === '#prompt-textarea' && ready;
    const send = selector === 'button[data-testid="send-button"]' && ready;
    const login = selector === 'button[data-testid="login-button"]' && this.mode === 'login';
    return new FakeLocator(composer || send || login) as unknown as Locator;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from('');
  }
}

class FakeBrowser implements BrowserController {
  readonly page: FakePage;
  constructor(mode: 'ready' | 'delayed' | 'login' | 'unknown') {
    this.page = new FakePage(mode);
  }
  async getPage(): Promise<Page> {
    return this.page as unknown as Page;
  }
  async close(): Promise<void> {}
}

class DeferredBrowser implements BrowserController {
  readonly page = new FakePage('ready');
  private resolvePage: ((page: Page) => void) | undefined;
  readonly pendingPage = new Promise<Page>((resolve) => {
    this.resolvePage = resolve;
  });

  getPage(): Promise<Page> {
    return this.pendingPage;
  }
  release(): void {
    this.resolvePage?.(this.page as unknown as Page);
  }
  async close(): Promise<void> {}
}

describe('ChatGPT adapter failure cleanup', () => {
  it('waits for the asynchronously rendered initial composer', async () => {
    const browser = new FakeBrowser('delayed');
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    expect(await adapter.health()).toBe('ready');
    expect(browser.page.waits).toBeGreaterThan(0);
    expect(browser.page.closed).toBe(true);
  });

  it('closes its tab when a running generation is cancelled', async () => {
    const browser = new FakeBrowser('ready');
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    const controller = new AbortController();
    const generation = adapter.generate({
      prompt: 'secret',
      signal: controller.signal,
      requestId: 'cancel-test',
    });
    setTimeout(() => controller.abort(), 20);
    await expect(generation).rejects.toMatchObject({ code: 'cancelled' });
    expect(browser.page.closed).toBe(true);
  });

  it('preserves timeout code and closes its tab', async () => {
    const browser = new FakeBrowser('ready');
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    const controller = new AbortController();
    const generation = adapter.generate({
      prompt: 'secret',
      signal: controller.signal,
      requestId: 'timeout-test',
    });
    setTimeout(() => controller.abort(new AppError('timeout', 'timed out')), 20);
    await expect(generation).rejects.toMatchObject({ code: 'timeout' });
    expect(browser.page.closed).toBe(true);
  });

  it('cancels image generation and closes its tab', async () => {
    const browser = new FakeBrowser('ready');
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    const controller = new AbortController();
    const generation = adapter.generateImage({
      prompt: 'image request',
      signal: controller.signal,
      requestId: 'image-cancel-test',
    });
    setTimeout(() => controller.abort(), 20);
    await expect(generation).rejects.toMatchObject({ code: 'cancelled' });
    expect(browser.page.closed).toBe(true);
  });

  it('does not navigate or submit after cancellation during browser attachment', async () => {
    const browser = new DeferredBrowser();
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    const controller = new AbortController();
    const generation = adapter.generate({
      prompt: 'must never be submitted',
      signal: controller.signal,
      requestId: 'attach-cancel-test',
    });
    controller.abort();
    browser.release();

    await expect(generation).rejects.toMatchObject({ code: 'cancelled' });
    expect(browser.page.navigations).toBe(0);
    expect(browser.page.closed).toBe(true);
  });

  it.each([
    ['login', 'login_required'],
    ['unknown', 'ui_changed'],
  ] as const)('returns %s state as machine-readable %s and closes tab', async (mode, code) => {
    const browser = new FakeBrowser(mode);
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
    await expect(
      adapter.generate({
        prompt: 'secret',
        signal: new AbortController().signal,
        requestId: 'state-test',
      }),
    ).rejects.toMatchObject({ code });
    expect(browser.page.closed).toBe(true);
  });
});
