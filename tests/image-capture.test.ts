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
    /** Polls the element stays absent for, after the baseline count, before it appears. */
    private readonly absentPolls = 0,
  ) {}
  nth(): this {
    return this;
  }
  async count(): Promise<number> {
    this.countCalls += 1;
    return this.countCalls <= 1 + this.absentPolls ? 0 : 1;
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
  fileInputAvailable = true;
  readonly queried: string[] = [];
  readonly uploads: { name: string; mimeType: string; bytes: number }[][] = [];
  readonly composed: string[] = [];

  /** Set to model an image that only the author-agnostic fallback selector can see. */
  fallbackImage: FakeImageLocator | undefined;

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
    this.queried.push(selector);
    if (selector === UI_SELECTORS.generatedImage[0]) return this.image as unknown as Locator;
    if (selector === UI_SELECTORS.generatedImageFallback[0] && this.fallbackImage !== undefined)
      return this.fallbackImage as unknown as Locator;
    if (selector === UI_SELECTORS.fileInput[0]) {
      const available = this.fileInputAvailable;
      const uploads = this.uploads;
      return {
        first: () => ({
          count: async () => (available ? 1 : 0),
          setInputFiles: async (files: { name: string; mimeType: string; buffer: Buffer }[]) => {
            uploads.push(
              files.map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                bytes: file.buffer.length,
              })),
            );
          },
        }),
      } as unknown as Locator;
    }
    const ready =
      selector === '#prompt-textarea' || selector === 'button[data-testid="send-button"]';
    const composed = this.composed;
    return {
      first: () => ({
        isVisible: async () => ready,
        count: async () => (ready ? 1 : 0),
        fill: async (value: string) => {
          if (selector === '#prompt-textarea') composed.push(value);
        },
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

describe('image generation reference uploads', () => {
  const width = 512;
  const height = 512;

  function adapterFor(page: FakeCapturePage): ChatGptAdapter {
    return new ChatGptAdapter(new FakeCaptureBrowser(page), testConfig(), createLogger('silent'));
  }

  it('uploads the references before submitting and names them in the prompt', async () => {
    const page = new FakeCapturePage(new FakeImageLocator(width, height, { x: 0, y: 0 }));
    page.screenshotPng = pngHeader(width, height);

    await adapterFor(page).generateImage({
      prompt: 'a cat in this style',
      signal: new AbortController().signal,
      requestId: 'reference-upload',
      attachments: [
        { data: Buffer.from('one'), mimeType: 'image/png', filename: 'image-1.png' },
        { data: Buffer.from('two'), mimeType: 'image/jpeg', filename: 'image-2.jpg' },
      ],
    });

    expect(page.uploads).toEqual([
      [
        { name: 'image-1.png', mimeType: 'image/png', bytes: 3 },
        { name: 'image-2.jpg', mimeType: 'image/jpeg', bytes: 3 },
      ],
    ]);
    expect(page.composed).toEqual([
      'Create exactly one image from this request, using the 2 attached images as visual references:\n\na cat in this style',
    ]);
  });

  it('leaves an unreferenced request untouched', async () => {
    const page = new FakeCapturePage(new FakeImageLocator(width, height, { x: 0, y: 0 }));
    page.screenshotPng = pngHeader(width, height);

    await adapterFor(page).generateImage({
      prompt: 'a plain cat',
      signal: new AbortController().signal,
      requestId: 'reference-absent',
    });

    expect(page.uploads).toEqual([]);
    expect(page.composed).toEqual(['Create exactly one image from this request:\n\na plain cat']);
  });

  it('never captures a reference that only the author-agnostic selector can see', async () => {
    // With uploads in the transcript, the turn-scoped fallback also matches the user's own
    // images. The answer therefore has to come from an assistant-scoped selector, even though
    // the fallback would have matched several polls earlier.
    const answer = new FakeImageLocator(width, height, { x: 0, y: 0 }, 6);
    const page = new FakeCapturePage(answer);
    page.fallbackImage = new FakeImageLocator(64, 64, { x: 8, y: 8 });
    page.screenshotPng = pngHeader(width, height);

    const result = await adapterFor(page).generateImage({
      prompt: 'a cat in this style',
      signal: new AbortController().signal,
      requestId: 'reference-scoped-selectors',
      attachments: [{ data: Buffer.from('one'), mimeType: 'image/png', filename: 'image-1.png' }],
    });

    expect(result.mimeType).toBe('image/png');
    expect(page.clips).toEqual([{ x: 0, y: 0, width, height }]);
    expect(page.queried).not.toContain(UI_SELECTORS.generatedImageFallback[0]);
  });

  it('still falls back to the author-agnostic selector without references', async () => {
    // Nothing the request uploaded can appear in the transcript, so the broader selector stays
    // available as the resilience it was added for.
    const answer = new FakeImageLocator(width, height, { x: 0, y: 0 }, 6);
    const page = new FakeCapturePage(answer);
    page.fallbackImage = new FakeImageLocator(64, 64, { x: 8, y: 8 });
    page.screenshotPng = pngHeader(64, 64);

    await adapterFor(page).generateImage({
      prompt: 'a plain cat',
      signal: new AbortController().signal,
      requestId: 'fallback-selectors',
    });

    expect(page.clips).toEqual([{ x: 8, y: 8, width: 64, height: 64 }]);
    expect(page.queried).toContain(UI_SELECTORS.generatedImageFallback[0]);
  });

  it('reports a missing file input as a UI change instead of dropping the references', async () => {
    const page = new FakeCapturePage(new FakeImageLocator(width, height, { x: 0, y: 0 }));
    page.screenshotPng = pngHeader(width, height);
    page.fileInputAvailable = false;

    await expect(
      adapterFor(page).generateImage({
        prompt: 'a cat in this style',
        signal: new AbortController().signal,
        requestId: 'reference-missing-input',
        attachments: [{ data: Buffer.from('one'), mimeType: 'image/png', filename: 'image-1.png' }],
      }),
    ).rejects.toMatchObject({ code: 'ui_changed' });
    // Nothing was typed, so the prompt cannot reach ChatGPT without its references.
    expect(page.composed).toEqual([]);
    expect(page.closed).toBe(true);
  });
});
