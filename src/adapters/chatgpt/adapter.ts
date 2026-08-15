import path from 'node:path';
import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { AppError, abortError, asSafeAppError } from '../../errors.js';
import type {
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  SessionState,
  WebChatProvider,
} from '../../provider.js';
import type { AppConfig } from '../../config/index.js';
import type { BrowserController } from '../../browser/controller.js';
import { CompletionStateMachine } from './completion-state.js';
import { UI_SELECTORS } from './selectors.js';

const CHATGPT_URL = 'https://chatgpt.com/';
const POLL_MS = 300;
const INITIAL_STATE_ATTEMPTS = 20;
const INITIAL_STATE_POLL_MS = 250;
const MAX_CAPTURE_DIMENSION = 4_096;
const MAX_CAPTURE_PIXELS = 16_777_216;
/** Padding around the isolated element so the clip never sits flush against the viewport. */
const CAPTURE_MARGIN_PX = 256;

async function firstVisible(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}

async function countAll(page: Page, selectors: readonly string[]): Promise<number> {
  let maximum = 0;
  for (const selector of selectors)
    maximum = Math.max(maximum, await page.locator(selector).count());
  return maximum;
}

async function countEach(page: Page, selectors: readonly string[]): Promise<number[]> {
  return Promise.all(selectors.map(async (selector) => page.locator(selector).count()));
}

export function validateIntrinsicPng(
  data: Buffer,
  dimensions: { width: number; height: number },
  mediaLimitBytes: number,
): Buffer {
  const captureError = (reason: string): AppError =>
    new AppError(
      'ui_changed',
      `ChatGPT displayed an image that could not be captured safely at intrinsic resolution (${reason}).`,
    );
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw captureError('invalid PNG output');
  }
  const pngWidth = data.length >= 24 ? data.readUInt32BE(16) : 0;
  const pngHeight = data.length >= 24 ? data.readUInt32BE(20) : 0;
  if (pngWidth !== dimensions.width || pngHeight !== dimensions.height) {
    throw captureError(
      `expected ${dimensions.width}x${dimensions.height}, captured ${pngWidth}x${pngHeight}`,
    );
  }
  if (data.length > mediaLimitBytes) {
    throw captureError(`PNG exceeds the configured ${mediaLimitBytes}-byte media limit`);
  }
  return data;
}

/** True while the newest assistant turn still carries one of ChatGPT's working markers. */
async function lastAnswerPending(page: Page): Promise<boolean> {
  for (const selector of UI_SELECTORS.assistantMessage) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) continue;
    const last = locator.nth(count - 1);
    for (const marker of UI_SELECTORS.pendingAnswer) {
      if (
        (await last
          .locator(marker)
          .count()
          .catch(() => 0)) > 0
      )
        return true;
      const selfMatches = await last
        .evaluate((element, candidate) => element.matches(candidate), marker)
        .catch(() => false);
      if (selfMatches) return true;
    }
    return false;
  }
  return false;
}

async function lastAssistantText(page: Page): Promise<string> {
  for (const selector of UI_SELECTORS.assistantMessage) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count > 0) return (await locator.nth(count - 1).innerText()).trim();
  }
  return '';
}

export class ChatGptAdapter implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;

  constructor(
    private readonly browser: BrowserController,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let page: Page | undefined;
    let submitted = false;
    try {
      if (request.signal.aborted) throw abortError(request.signal);
      page = await this.browser.getPage();
      if (request.signal.aborted) throw abortError(request.signal);
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const state = await this.waitForInitialState(page);
      this.assertReady(state);
      const composer = await firstVisible(page, UI_SELECTORS.composer);
      if (composer === undefined) throw this.uiChanged();
      const baseline = await countAll(page, UI_SELECTORS.assistantMessage);
      const baselineCompletionActions = await countAll(page, UI_SELECTORS.completionAction);
      if (request.attachments !== undefined && request.attachments.length > 0) {
        const fileInput = page.locator(UI_SELECTORS.fileInput[0]).first();
        if ((await fileInput.count()) === 0)
          throw new AppError('ui_changed', 'The ChatGPT file input is unavailable.');
        await fileInput.setInputFiles(
          request.attachments.map((attachment) => ({
            name: attachment.filename,
            mimeType: attachment.mimeType,
            buffer: attachment.data,
          })),
        );
      }
      await composer.fill(request.prompt);
      const send = await firstVisible(page, UI_SELECTORS.sendButton);
      if (send !== undefined) await send.click();
      else await composer.press('Enter');
      submitted = true;
      const text = await this.waitForCompletion(
        page,
        baseline,
        baselineCompletionActions,
        request.signal,
      );
      return { text, providerModel: this.id };
    } catch (error) {
      if (request.signal.aborted) throw abortError(request.signal);
      if (error instanceof AppError) {
        if (error.code === 'ui_changed' && this.config.debug && page !== undefined) {
          await page
            .screenshot({
              path: path.join(this.config.artifactDir, `ui-changed-${request.requestId}.png`),
              fullPage: false,
            })
            .catch(() => undefined);
        }
        throw error;
      }
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          requestId: request.requestId,
          submitted,
        },
        'browser request failed',
      );
      // A submitted prompt is never retried because generation may already have started.
      throw asSafeAppError(error);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async generateImage(request: GenerateImageRequest): Promise<GenerateImageResult> {
    let page: Page | undefined;
    let submitted = false;
    try {
      if (request.signal.aborted) throw abortError(request.signal);
      page = await this.browser.getPage();
      if (request.signal.aborted) throw abortError(request.signal);
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      this.assertReady(await this.waitForInitialState(page));
      const composer = await firstVisible(page, UI_SELECTORS.composer);
      if (composer === undefined) throw this.uiChanged();
      const baselineImages = await countEach(page, UI_SELECTORS.generatedImage);
      const baselineCompletionActions = await countAll(page, UI_SELECTORS.completionAction);
      await composer.fill(`Create exactly one image from this request:\n\n${request.prompt}`);
      const send = await firstVisible(page, UI_SELECTORS.sendButton);
      if (send !== undefined) await send.click();
      else await composer.press('Enter');
      submitted = true;
      const data = await this.waitForGeneratedImage(
        page,
        baselineImages,
        baselineCompletionActions,
        request.signal,
      );
      return { data, mimeType: 'image/png' };
    } catch (error) {
      if (request.signal.aborted) throw abortError(request.signal);
      if (error instanceof AppError) throw error;
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          requestId: request.requestId,
          submitted,
        },
        'browser image request failed',
      );
      throw asSafeAppError(error);
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async waitForManualLogin(onState: (state: SessionState) => void): Promise<void> {
    let page: Page | undefined;
    let previous: SessionState | undefined;
    try {
      page = await this.browser.getPage();
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      while (!page.isClosed()) {
        const state = await this.classifyPage(page);
        if (state !== previous) {
          onState(state);
          previous = state;
        }
        if (state === 'ready') return;
        await page.waitForTimeout(1_000);
      }
      throw new AppError(
        'browser_disconnected',
        'The manual login window was closed before the session became ready.',
      );
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async health(): Promise<SessionState> {
    let page: Page | undefined;
    try {
      page = await this.browser.getPage();
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return await this.waitForInitialState(page);
    } catch (error) {
      return error instanceof AppError && error.code === 'browser_disconnected'
        ? 'browser_disconnected'
        : 'ui_changed';
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async reset(): Promise<void> {
    await this.browser.close();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private async waitForCompletion(
    page: Page,
    baseline: number,
    baselineCompletionActions: number,
    signal: AbortSignal,
  ): Promise<string> {
    const machine = new CompletionStateMachine(baseline);
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const state = await this.classifyPage(page, true);
      if (
        state === 'rate_limited' ||
        state === 'security_challenge' ||
        state === 'login_required'
      ) {
        this.assertReady(state);
      }
      const assistantCount = await countAll(page, UI_SELECTORS.assistantMessage);
      const text = await lastAssistantText(page);
      const generating = (await firstVisible(page, UI_SELECTORS.stopButton)) !== undefined;
      const completionActionAvailable =
        (await countAll(page, UI_SELECTORS.completionAction)) > baselineCompletionActions;
      const pending = await lastAnswerPending(page);
      if (
        machine.observe({
          assistantCount,
          text,
          generating,
          completionActionAvailable,
          pending,
        }) === 'complete'
      )
        return text;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortError(signal));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, POLL_MS);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private async waitForGeneratedImage(
    page: Page,
    baselineImages: readonly number[],
    baselineCompletionActions: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    let stableObservations = 0;
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const state = await this.classifyPage(page, true);
      if (state === 'rate_limited' || state === 'security_challenge' || state === 'login_required')
        this.assertReady(state);
      let image: Locator | undefined;
      for (const [index, selector] of UI_SELECTORS.generatedImage.entries()) {
        const candidates = page.locator(selector);
        const count = await candidates.count();
        if (count > (baselineImages[index] ?? 0)) {
          image = candidates.nth(count - 1);
          break;
        }
      }
      const complete =
        image !== undefined &&
        (await image
          .evaluate((element) => {
            const candidate = element as HTMLImageElement;
            return candidate.complete && candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
          })
          .catch(() => false));
      stableObservations = complete ? stableObservations + 1 : 0;
      const generating = (await firstVisible(page, UI_SELECTORS.stopButton)) !== undefined;
      const completionActionAvailable =
        (await countAll(page, UI_SELECTORS.completionAction)) > baselineCompletionActions;
      if (
        image !== undefined &&
        stableObservations >= 3 &&
        (!generating || completionActionAvailable)
      ) {
        return this.captureIntrinsicImage(page, image);
      }
      await page.waitForTimeout(POLL_MS);
    }
  }

  private async captureIntrinsicImage(page: Page, image: Locator): Promise<Buffer> {
    const dimensions = await image.evaluate((element) => {
      const candidate = element as HTMLImageElement;
      return { width: candidate.naturalWidth, height: candidate.naturalHeight };
    });
    if (
      dimensions.width < 1 ||
      dimensions.height < 1 ||
      dimensions.width > MAX_CAPTURE_DIMENSION ||
      dimensions.height > MAX_CAPTURE_DIMENSION ||
      dimensions.width * dimensions.height > MAX_CAPTURE_PIXELS
    ) {
      throw new AppError(
        'ui_changed',
        'ChatGPT displayed an image with unsupported intrinsic dimensions.',
      );
    }

    // Enlarging the element in place is not enough on its own: an ancestor still clips it, so
    // an element screenshot captures whatever the page renders across that box — the chat
    // chrome and blank background rather than the picture. Everything except the capture
    // target is therefore hidden, the target is lifted out of its clipping ancestor, and the
    // viewport is clipped to exactly its box. The node stays in ChatGPT's tree so React does
    // not detach the locator mid-capture, and the private image URL is never read or fetched.
    //
    // Device metrics are also pinned to a 1:1 ratio, because a page attached over CDP
    // inherits the host display's real scale factor and a fractional value rounds the clip to
    // a size that no longer matches the element's natural pixels.
    const deviceMetrics = await page.context().newCDPSession(page);
    // Playwright re-applies its own viewport when it screenshots, so the size must go through
    // setViewportSize; the CDP override is what pins the scale factor to 1:1 afterwards.
    const applyMetrics = async (width: number, height: number): Promise<void> => {
      await page.setViewportSize({ width, height });
      await deviceMetrics.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    };
    let overrideWidth = dimensions.width + CAPTURE_MARGIN_PX;
    let overrideHeight = dimensions.height + CAPTURE_MARGIN_PX;
    await applyMetrics(overrideWidth, overrideHeight);
    await image.evaluate((element) => {
      const candidate = element as HTMLImageElement;
      candidate.dataset.tab2apiCapture = 'true';
      const isolationStyle = document.createElement('style');
      isolationStyle.textContent = `
        body *:not([data-tab2api-capture="true"]),
        body *::before,
        body *::after { visibility: hidden !important; }
        [data-tab2api-capture="true"] { visibility: visible !important; }
      `;
      document.head.append(isolationStyle);
      const declarations: ReadonlyArray<readonly [string, string]> = [
        ['position', 'fixed'],
        ['left', '64px'],
        ['top', '64px'],
        ['width', `${candidate.naturalWidth}px`],
        ['height', `${candidate.naturalHeight}px`],
        ['max-width', 'none'],
        ['max-height', 'none'],
        ['object-fit', 'fill'],
        ['display', 'block'],
        ['border-radius', '0'],
        ['clip-path', 'none'],
        ['transform', 'none'],
        ['z-index', '2147483647'],
      ];
      for (const [property, value] of declarations)
        candidate.style.setProperty(property, value, 'important');
    });

    // `position: fixed` is only viewport-relative when no ancestor establishes a containing
    // block, and ChatGPT's message list uses a transform. Measure where the element really
    // landed and grow the viewport to contain it before clipping.
    let box = await image.boundingBox();
    if (box === null) throw this.uiChanged();
    const requiredWidth = Math.ceil(box.x + dimensions.width) + CAPTURE_MARGIN_PX;
    const requiredHeight = Math.ceil(box.y + dimensions.height) + CAPTURE_MARGIN_PX;
    if (requiredWidth > overrideWidth || requiredHeight > overrideHeight) {
      overrideWidth = Math.max(overrideWidth, requiredWidth);
      overrideHeight = Math.max(overrideHeight, requiredHeight);
      await applyMetrics(overrideWidth, overrideHeight);
      box = await image.boundingBox();
      if (box === null) throw this.uiChanged();
    }

    const data = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      scale: 'css',
      clip: { x: box.x, y: box.y, width: dimensions.width, height: dimensions.height },
    });
    return validateIntrinsicPng(data, dimensions, this.config.mediaLimitBytes);
  }

  private async classifyPage(page: Page, duringGeneration = false): Promise<SessionState> {
    if (page.isClosed()) return 'browser_disconnected';
    if ((await firstVisible(page, UI_SELECTORS.challenge)) !== undefined)
      return 'security_challenge';
    if ((await firstVisible(page, UI_SELECTORS.rateLimit)) !== undefined) return 'rate_limited';
    if (
      page.url().includes('/auth/') ||
      (await firstVisible(page, UI_SELECTORS.login)) !== undefined
    ) {
      return 'login_required';
    }
    if ((await firstVisible(page, UI_SELECTORS.stopButton)) !== undefined)
      return 'generation_in_progress';
    if ((await firstVisible(page, UI_SELECTORS.composer)) !== undefined) return 'ready';
    return duringGeneration ? 'generation_in_progress' : 'ui_changed';
  }

  private async waitForInitialState(page: Page): Promise<SessionState> {
    for (let attempt = 0; attempt < INITIAL_STATE_ATTEMPTS; attempt += 1) {
      const state = await this.classifyPage(page);
      if (state !== 'ui_changed') return state;
      if (attempt < INITIAL_STATE_ATTEMPTS - 1) await page.waitForTimeout(INITIAL_STATE_POLL_MS);
    }
    return 'ui_changed';
  }

  private assertReady(state: SessionState): void {
    if (state === 'ready') return;
    if (state === 'login_required') {
      throw new AppError(
        'login_required',
        'Manual ChatGPT login is required.',
        'Run `npm run login`.',
      );
    }
    if (state === 'security_challenge') {
      throw new AppError(
        'security_challenge',
        'ChatGPT displayed a security challenge.',
        'Complete the challenge manually in the headed login browser. tab2api will not bypass it.',
      );
    }
    if (state === 'rate_limited') {
      throw new AppError(
        'rate_limited',
        'ChatGPT displayed a rate-limit message.',
        'Wait and retry manually later.',
      );
    }
    if (state === 'browser_disconnected') {
      throw new AppError(
        'browser_disconnected',
        'The browser disconnected.',
        'Run `npm run doctor`.',
      );
    }
    throw this.uiChanged();
  }

  private uiChanged(): AppError {
    return new AppError(
      'ui_changed',
      'The current ChatGPT UI is not supported by these selectors.',
      this.config.debug
        ? `A redacted diagnostic screenshot may be written under ${path.basename(this.config.artifactDir)}.`
        : 'Run with TAB2API_DEBUG=true to enable local screenshot diagnostics, then file a selector bug.',
    );
  }
}
