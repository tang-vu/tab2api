import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ChatGptAdapter } from '../src/adapters/chatgpt/adapter.js';
import { UI_SELECTORS } from '../src/adapters/chatgpt/selectors.js';
import type { BrowserController } from '../src/browser/controller.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import { testConfig } from './helpers.js';

function fakePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

class FakeCdpSession {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  async send(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return {};
  }
}

// Models the generated <img> locator's call sequence in generateImage(): the readiness
// poll calls evaluate() to check `complete`/naturalWidth/naturalHeight three times before
// captureIntrinsicImage() reads natural dimensions (4th call) then injects capture styles
// (5th call). count() reports no image for the baseline check and first poll, then one
// newly appeared image from the following poll onward.
class FakeGeneratedImageLocator {
  private countCalls = 0;
  private evaluateCalls = 0;
  boundingBoxCalls = 0;
  constructor(
    private readonly naturalWidth: number,
    private readonly naturalHeight: number,
    private readonly boxOrigin: { x: number; y: number } = { x: 8, y: 8 },
  ) {}
  nth(): this {
    return this;
  }
  async count(): Promise<number> {
    this.countCalls += 1;
    return this.countCalls <= 2 ? 0 : 1;
  }
  async evaluate(_fn: unknown): Promise<unknown> {
    this.evaluateCalls += 1;
    if (this.evaluateCalls <= 3) return true;
    if (this.evaluateCalls === 4) return { width: this.naturalWidth, height: this.naturalHeight };
    return undefined;
  }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    this.boundingBoxCalls += 1;
    return {
      x: this.boxOrigin.x,
      y: this.boxOrigin.y,
      width: this.naturalWidth,
      height: this.naturalHeight,
    };
  }
}

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
  screenshotPng: Buffer | undefined;
  readonly cdpSession = new FakeCdpSession();

  constructor(
    private readonly mode: 'ready' | 'delayed' | 'login' | 'unknown',
    private readonly imageLocator?: FakeGeneratedImageLocator,
  ) {}
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
    if (selector === UI_SELECTORS.generatedImage[0] && this.imageLocator !== undefined) {
      return this.imageLocator as unknown as Locator;
    }
    const ready = this.mode === 'ready' || (this.mode === 'delayed' && this.waits > 0);
    const composer = selector === '#prompt-textarea' && ready;
    const send = selector === 'button[data-testid="send-button"]' && ready;
    const login = selector === 'button[data-testid="login-button"]' && this.mode === 'login';
    return new FakeLocator(composer || send || login) as unknown as Locator;
  }
  context(): { newCDPSession: (page?: unknown) => Promise<FakeCdpSession> } {
    return { newCDPSession: async () => this.cdpSession };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async screenshot(options?: { clip?: unknown }): Promise<Buffer> {
    if (options?.clip !== undefined && this.screenshotPng !== undefined) return this.screenshotPng;
    return Buffer.from('');
  }
}

class FakeBrowser implements BrowserController {
  readonly page: FakePage;
  constructor(
    mode: 'ready' | 'delayed' | 'login' | 'unknown',
    imageLocator?: FakeGeneratedImageLocator,
  ) {
    this.page = new FakePage(mode, imageLocator);
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

describe('generated image capture', () => {
  it('pins device scale factor to 1 before clipping and returns the intrinsic PNG', async () => {
    const width = 400;
    const height = 300;
    const imageLocator = new FakeGeneratedImageLocator(width, height);
    const browser = new FakeBrowser('ready', imageLocator);
    browser.page.screenshotPng = fakePng(width, height);
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));

    const result = await adapter.generateImage({
      prompt: 'a landscape',
      signal: new AbortController().signal,
      requestId: 'image-scale-test',
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.data.equals(fakePng(width, height))).toBe(true);
    expect(browser.page.cdpSession.calls).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: width + 256, height: height + 256, deviceScaleFactor: 1, mobile: false },
      },
    ]);
    expect(browser.page.closed).toBe(true);
  });

  it('grows the device metrics to fit an element positioned away from the origin', async () => {
    // `position: fixed` is only viewport-relative without a transformed ancestor; when
    // ChatGPT's layout provides one, the element can land far from (0,0) and the default
    // +256 margin no longer contains it. Regression test for that truncation.
    const width = 400;
    const height = 300;
    const imageLocator = new FakeGeneratedImageLocator(width, height, { x: 500, y: 500 });
    const browser = new FakeBrowser('ready', imageLocator);
    browser.page.screenshotPng = fakePng(width, height);
    const adapter = new ChatGptAdapter(browser, testConfig(), createLogger('silent'));

    const result = await adapter.generateImage({
      prompt: 'a landscape',
      signal: new AbortController().signal,
      requestId: 'image-grow-test',
    });

    expect(result.mimeType).toBe('image/png');
    expect(browser.page.cdpSession.calls).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: width + 256, height: height + 256, deviceScaleFactor: 1, mobile: false },
      },
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 964, height: 864, deviceScaleFactor: 1, mobile: false },
      },
    ]);
    expect(imageLocator.boundingBoxCalls).toBe(2);
    expect(browser.page.closed).toBe(true);
  });
});
