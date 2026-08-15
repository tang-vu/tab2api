import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ChatGptAdapter, validateIntrinsicPng } from '../src/adapters/chatgpt/adapter.js';
import { UI_SELECTORS } from '../src/adapters/chatgpt/selectors.js';
import type { BrowserController } from '../src/browser/controller.js';
import { createLogger } from '../src/observability/logger.js';
import { testConfig } from './helpers.js';

function pngHeader(width: number, height: number, length = 24): Buffer {
  const data = Buffer.alloc(length);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe('intrinsic image capture validation', () => {
  it('accepts a PNG with the expected intrinsic dimensions', () => {
    const data = pngHeader(1024, 768);
    expect(validateIntrinsicPng(data, { width: 1024, height: 768 }, 1024)).toBe(data);
  });

  it('rejects invalid signatures, dimension drift, and oversized captures', () => {
    expect(() => validateIntrinsicPng(Buffer.alloc(24), { width: 1, height: 1 }, 1024)).toThrow(
      'could not be captured safely',
    );
    expect(() =>
      validateIntrinsicPng(pngHeader(2048, 1024), { width: 1024, height: 1024 }, 1024),
    ).toThrow('could not be captured safely');
    expect(() => validateIntrinsicPng(pngHeader(1, 1, 25), { width: 1, height: 1 }, 24)).toThrow(
      'could not be captured safely',
    );
  });
});

/**
 * Models the generated <img> during `generateImage`: three readiness polls, then the natural
 * dimensions, then the style injection. The element reports a bounding box away from the
 * origin, which is what the real page does because an ancestor carries a CSS transform.
 */
class FakeImageLocator {
  private countCalls = 0;
  private evaluateCalls = 0;
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly origin: { x: number; y: number },
  ) {}
  nth(): this {
    return this;
  }
  async count(): Promise<number> {
    this.countCalls += 1;
    return this.countCalls <= 1 ? 0 : 1;
  }
  async evaluate(_fn: unknown): Promise<unknown> {
    this.evaluateCalls += 1;
    if (this.evaluateCalls <= 3) return true;
    if (this.evaluateCalls === 4) return { width: this.width, height: this.height };
    return undefined;
  }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return { x: this.origin.x, y: this.origin.y, width: this.width, height: this.height };
  }
  async screenshot(): Promise<Buffer> {
    throw new Error('element screenshot must not be used: it captures the page around the image');
  }
}

class FakeCdpSession {
  readonly calls: { method: string; params: unknown }[] = [];
  async send(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return {};
  }
}

class FakeCapturePage {
  closed = false;
  clips: { x: number; y: number; width: number; height: number }[] = [];
  viewports: { width: number; height: number }[] = [];
  readonly cdp = new FakeCdpSession();
  screenshotPng: Buffer = Buffer.alloc(0);

  constructor(private readonly image: FakeImageLocator) {}
  async goto(): Promise<void> {}
  async waitForTimeout(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  url(): string {
    return 'https://chatgpt.com/';
  }
  isClosed(): boolean {
    return this.closed;
  }
  locator(selector: string): Locator {
    if (selector === UI_SELECTORS.generatedImage[0]) return this.image as unknown as Locator;
    const ready =
      selector === '#prompt-textarea' || selector === 'button[data-testid="send-button"]';
    return {
      first: () => ({
        isVisible: async () => ready,
        count: async () => (ready ? 1 : 0),
        fill: async () => undefined,
        press: async () => undefined,
        click: async () => undefined,
      }),
      count: async () => 0,
      nth: () => ({ innerText: async () => '' }),
    } as unknown as Locator;
  }
  context(): { newCDPSession: () => Promise<FakeCdpSession> } {
    return { newCDPSession: async () => this.cdp };
  }
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewports.push(size);
  }
  async screenshot(options?: {
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer> {
    if (options?.clip === undefined) throw new Error('capture must clip to the image box');
    this.clips.push(options.clip);
    return this.screenshotPng;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeCaptureBrowser implements BrowserController {
  constructor(readonly page: FakeCapturePage) {}
  async getPage(): Promise<Page> {
    return this.page as unknown as Page;
  }
  async close(): Promise<void> {}
}

describe('intrinsic image capture isolation', () => {
  const width = 1254;
  const height = 1254;

  it('clips the page to the image instead of screenshotting the element', async () => {
    // An element screenshot captures whatever the page renders across the element's box, so a
    // clipped ancestor yields chat chrome and blank background instead of the picture. The
    // fake throws if the element path is used again.
    const image = new FakeImageLocator(width, height, { x: 324, y: 64 });
    const page = new FakeCapturePage(image);
    page.screenshotPng = pngHeader(width, height);
    const adapter = new ChatGptAdapter(
      new FakeCaptureBrowser(page),
      testConfig(),
      createLogger('silent'),
    );

    const result = await adapter.generateImage({
      prompt: 'a red square',
      signal: new AbortController().signal,
      requestId: 'capture-isolation',
    });

    expect(result.mimeType).toBe('image/png');
    expect(page.clips).toEqual([{ x: 324, y: 64, width, height }]);
    expect(page.closed).toBe(true);
  });

  it('pins the scale factor and grows the viewport to contain an offset element', async () => {
    const image = new FakeImageLocator(width, height, { x: 324, y: 64 });
    const page = new FakeCapturePage(image);
    page.screenshotPng = pngHeader(width, height);
    const adapter = new ChatGptAdapter(
      new FakeCaptureBrowser(page),
      testConfig(),
      createLogger('silent'),
    );

    await adapter.generateImage({
      prompt: 'a red square',
      signal: new AbortController().signal,
      requestId: 'capture-metrics',
    });

    // Playwright reapplies its own viewport when screenshotting, so the size has to go through
    // setViewportSize; the CDP override is only what pins the ratio.
    expect(page.viewports).toEqual([
      { width: width + 256, height: height + 256 },
      // Both axes grow: the element sits at (324, 64), so its far edge exceeds the first box.
      { width: 324 + width + 256, height: 64 + height + 256 },
    ]);
    expect(page.cdp.calls.map((call) => call.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setDeviceMetricsOverride',
    ]);
    for (const call of page.cdp.calls) {
      expect(call.params).toMatchObject({ deviceScaleFactor: 1, mobile: false });
    }
  });
});
