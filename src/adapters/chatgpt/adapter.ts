import path from 'node:path';
import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { AppError, abortError, asSafeAppError } from '../../errors.js';
import type {
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
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const state = await this.classifyPage(page);
      this.assertReady(state);
      const composer = await firstVisible(page, UI_SELECTORS.composer);
      if (composer === undefined) throw this.uiChanged();
      const baseline = await countAll(page, UI_SELECTORS.assistantMessage);
      await composer.fill(request.prompt);
      const send = await firstVisible(page, UI_SELECTORS.sendButton);
      if (send !== undefined) await send.click();
      else await composer.press('Enter');
      submitted = true;
      const text = await this.waitForCompletion(page, baseline, request.signal);
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
      return await this.classifyPage(page);
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
      if (machine.observe({ assistantCount, text, generating }) === 'complete') return text;
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
