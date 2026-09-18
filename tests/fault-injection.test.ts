import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ChatGptAdapter } from '../src/adapters/chatgpt/adapter.js';
import type { DomObservation } from '../src/adapters/chatgpt/observe-dom.js';
import { emptyObservation } from '../src/adapters/chatgpt/session.js';
import type { BrowserController } from '../src/browser/controller.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import type { ErrorCode } from '../src/errors.js';
import { testConfig } from './helpers.js';

/**
 * Fault-injection harness: a scripted page that answers the observer's `evaluate` calls
 * from a deterministic script and can be told to throw at any instrumented call site.
 * The point is not that the fake resembles Chromium — it is that every fault lands in
 * the same error taxonomy a real failure would, with the page always accounted for.
 */

interface Fault {
  /** Instrumented method: 'goto' | 'evaluate' | 'waitForTimeout' | 'fill' | 'click' | 'press' | 'close'. */
  at: string;
  /** Throw when the call count reaches this value (default: every call). */
  atCall?: number;
  error: unknown;
}

class ScriptedLocator {
  constructor(
    private readonly page: ScriptedPage,
    private readonly selector: string,
  ) {}

  first(): this {
    return this;
  }
  nth(): this {
    return this;
  }
  filter(): this {
    return this;
  }
  async isVisible(): Promise<boolean> {
    return true;
  }
  async count(): Promise<number> {
    return this.selector === 'input[type="file"]' ? this.page.fileInputCount : 1;
  }
  async fill(value: string): Promise<void> {
    this.page.record('fill');
    this.page.maybeThrow('fill');
    this.page.submissions.push(value);
  }
  async click(): Promise<void> {
    this.page.record('click');
    this.page.maybeThrow('click');
  }
  async press(_key: string): Promise<void> {
    this.page.record('press');
    this.page.maybeThrow('press');
  }
  async waitFor(): Promise<void> {}
  async setInputFiles(): Promise<void> {}
  async innerText(): Promise<string> {
    return '';
  }
  async getAttribute(): Promise<string | null> {
    return null;
  }
}

class ScriptedPage {
  closed = false;
  navigations = 0;
  submissions: string[] = [];
  fileInputCount = 1;
  currentUrl = 'https://chatgpt.com/';
  readonly calls: Record<string, number> = {};
  private readonly faults: Fault[];

  constructor(
    private readonly script: (call: number) => DomObservation | Promise<DomObservation>,
    faults: Fault[] = [],
  ) {
    this.faults = faults;
  }

  record(method: string): number {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    return this.calls[method] ?? 0;
  }

  maybeThrow(method: string): void {
    for (const fault of this.faults) {
      if (fault.at !== method) continue;
      const calls = this.calls[method] ?? 0;
      if (fault.atCall === undefined || calls === fault.atCall) throw fault.error;
    }
  }

  async goto(): Promise<void> {
    this.record('goto');
    this.maybeThrow('goto');
    this.navigations += 1;
  }
  async evaluate(): Promise<DomObservation> {
    const call = this.record('evaluate');
    this.maybeThrow('evaluate');
    return this.script(call);
  }
  async waitForTimeout(): Promise<void> {
    this.record('waitForTimeout');
    this.maybeThrow('waitForTimeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  url(): string {
    return this.currentUrl;
  }
  isClosed(): boolean {
    return this.closed;
  }
  locator(selector: string): Locator {
    return new ScriptedLocator(this, selector) as unknown as Locator;
  }
  async close(): Promise<void> {
    this.record('close');
    this.maybeThrow('close');
    this.closed = true;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
}

/** Counts leased pages so a leak is observable, mirroring BrowserManager.ownedPages. */
class LeaseBrowser implements BrowserController {
  readonly pages: ScriptedPage[] = [];
  private leased = 0;

  constructor(private readonly factory: () => ScriptedPage) {}

  async getPage(): Promise<Page> {
    const page = this.factory();
    this.pages.push(page);
    this.leased += 1;
    const close = page.close.bind(page);
    page.close = async () => {
      await close();
      this.leased -= 1;
    };
    return page as unknown as Page;
  }
  openPageCount(): number {
    return this.leased;
  }
  async close(): Promise<void> {}
}

function adapterFor(browser: BrowserController): ChatGptAdapter {
  return new ChatGptAdapter(browser, testConfig(), createLogger('silent'));
}

function readyObservation(): DomObservation {
  return {
    ...emptyObservation('ready'),
    composerPresent: true,
    composerVisible: true,
  };
}

function completedTurnObservation(text: string): DomObservation {
  return {
    ...emptyObservation('ready'),
    composerPresent: true,
    composerVisible: true,
    turnIds: ['turn-1'],
    completionActionCount: 1,
    assistant: { count: 1, text, pending: false },
    boundTurn: { elements: 1, text, pending: false, completionActions: 1 },
  };
}

/** Initial observation, baseline, then a settled completed turn on every poll. */
function successfulTurn(text = 'Final answer') {
  return (call: number): DomObservation =>
    call <= 2 ? readyObservation() : completedTurnObservation(text);
}

const KNOWN_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'cancelled',
  'timeout',
  'generation_timeout',
  'generation_interrupted',
  'submission_uncertain',
  'navigation_failed',
  'composer_unavailable',
  'attachment_failed',
  'unsupported_capability',
  'conversation_not_found',
  'project_not_found',
  'ui_changed',
  'login_required',
  'security_challenge',
  'rate_limited',
  'browser_disconnected',
  'queue_full',
  'draining',
]);

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('fault injection', () => {
  it('maps a navigation throw to navigation_failed and closes the page', async () => {
    const browser = new LeaseBrowser(
      () =>
        new ScriptedPage(successfulTurn(), [
          { at: 'goto', error: new Error('net::ERR_CONNECTION_RESET') },
        ]),
    );
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f1' }),
    ).rejects.toMatchObject({ code: 'navigation_failed' });
    expect(browser.pages[0]?.closed).toBe(true);
    expect(browser.pages[0]?.submissions).toHaveLength(0);
    expect(browser.openPageCount()).toBe(0);
  });

  it('maps a pre-submit observer failure to a safe browser error', async () => {
    const browser = new LeaseBrowser(
      () =>
        new ScriptedPage(successfulTurn(), [
          { at: 'evaluate', atCall: 1, error: new Error('Execution context destroyed') },
        ]),
    );
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f2' }),
    ).rejects.toMatchObject({ code: 'browser_disconnected' });
    expect(browser.pages[0]?.submissions).toHaveLength(0);
    expect(browser.openPageCount()).toBe(0);
  });

  it('maps a post-submit observer failure to submission_uncertain and never resubmits', async () => {
    const page = new ScriptedPage(successfulTurn(), [
      { at: 'evaluate', atCall: 3, error: new Error('Execution context destroyed') },
    ]);
    const browser = new LeaseBrowser(() => page);
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f3' }),
    ).rejects.toMatchObject({ code: 'submission_uncertain' });
    // The failure is reported once; nothing silently retries navigation or the send.
    expect(page.navigations).toBe(1);
    expect(page.submissions).toEqual(['hi']);
    expect(page.closed).toBe(true);
    expect(browser.openPageCount()).toBe(0);
  });

  it('maps a send-gesture throw to submission_uncertain', async () => {
    const browser = new LeaseBrowser(
      () =>
        new ScriptedPage(successfulTurn(), [{ at: 'click', error: new Error('element detached') }]),
    );
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f4' }),
    ).rejects.toMatchObject({ code: 'submission_uncertain' });
    expect(browser.pages[0]?.closed).toBe(true);
  });

  it('maps a composer fill failure to a safe pre-submit error without the send gesture', async () => {
    const page = new ScriptedPage(successfulTurn(), [
      { at: 'fill', error: new Error('not editable') },
    ]);
    const browser = new LeaseBrowser(() => page);
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f5' }),
    ).rejects.toMatchObject({ code: 'browser_disconnected' });
    expect(page.calls.click ?? 0).toBe(0);
    expect(page.calls.press ?? 0).toBe(0);
    expect(page.closed).toBe(true);
  });

  it('maps a missing file input to attachment_failed', async () => {
    const page = new ScriptedPage(successfulTurn());
    page.fileInputCount = 0;
    const browser = new LeaseBrowser(() => page);
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({
        prompt: 'describe this',
        signal: new AbortController().signal,
        requestId: 'f6',
        attachments: [{ data: Buffer.from('x'), mimeType: 'image/png', filename: 'x.png' }],
      }),
    ).rejects.toMatchObject({ code: 'attachment_failed' });
    expect(page.submissions).toHaveLength(0);
    expect(page.closed).toBe(true);
  });

  it('reports a mid-generation account surface as its typed state error', async () => {
    let call = 0;
    const page = new ScriptedPage(() => {
      call += 1;
      if (call <= 2) return readyObservation();
      return { ...emptyObservation('rate_limited'), turnIds: ['turn-1'] };
    });
    const browser = new LeaseBrowser(() => page);
    const adapter = adapterFor(browser);
    await expect(
      adapter.generate({ prompt: 'hi', signal: new AbortController().signal, requestId: 'f7' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(page.closed).toBe(true);
  });
});

describe('chaos loop', () => {
  const faultPoints = ['goto', 'evaluate', 'fill', 'click', 'waitForTimeout', 'close'];

  it.each([1, 7, 19, 42, 137, 4242])(
    'seed %i: every fault combination settles into a typed outcome with the page accounted for',
    async (seed) => {
      const random = mulberry32(seed);
      for (let run = 0; run < 12; run += 1) {
        const at = faultPoints[Math.floor(random() * faultPoints.length)] ?? 'goto';
        const atCall = 1 + Math.floor(random() * 6);
        const abortCall = random() < 0.4 ? 1 + Math.floor(random() * 6) : undefined;
        const controller = new AbortController();
        const page = new ScriptedPage(
          (call) => {
            if (abortCall !== undefined && call === abortCall) controller.abort();
            return successfulTurn()(call);
          },
          [{ at, atCall, error: new Error(`injected ${at}#${atCall}`) }],
        );
        const browser = new LeaseBrowser(() => page);
        const adapter = adapterFor(browser);
        try {
          await adapter.generate({
            prompt: 'chaos',
            signal: controller.signal,
            requestId: `chaos-${seed}-${run}`,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          expect(KNOWN_CODES.has((error as AppError).code)).toBe(true);
        }
        // Ownership tracking must mirror reality: a page whose cleanup failed stays
        // counted instead of silently leaking past diagnostics.
        expect(browser.openPageCount()).toBe(page.closed ? 0 : 1);
      }
    },
  );
});

describe('observer property checks', () => {
  const SESSION_STATES = new Set([
    'ready',
    'login_required',
    'security_challenge',
    'generation_in_progress',
    'rate_limited',
    'ui_changed',
    'browser_disconnected',
  ]);

  it('always returns a bounded, well-formed observation for generated DOMs', async () => {
    const { parseHTML } = await import('linkedom');
    const { observeChatDom } = await import('../src/adapters/chatgpt/observe-dom.js');
    const { serializeContracts } = await import('../src/adapters/chatgpt/selector-contracts.js');
    const contracts = serializeContracts();
    const random = mulberry32(9_991);
    const tags = ['div', 'span', 'button', 'textarea', 'article', 'main', 'a', 'img'];
    const attrs = [
      'data-testid="send-button"',
      'id="prompt-textarea"',
      'data-message-author-role="assistant"',
      'data-turn-id="t-x"',
      'role="row"',
      'hidden',
      'aria-busy="true"',
      'contenteditable="true"',
    ];
    for (let i = 0; i < 200; i += 1) {
      const depth = 1 + Math.floor(random() * 4);
      let html = '<main>';
      for (let d = 0; d < depth; d += 1) {
        const tag = tags[Math.floor(random() * tags.length)];
        const attr = random() < 0.5 ? ` ${attrs[Math.floor(random() * attrs.length)]}` : '';
        html += `<${tag}${attr}>text-${i}-${d}`;
      }
      html += '</main>';
      const doc = parseHTML(html).document;
      const observation = observeChatDom(doc, { url: 'https://chatgpt.com/', contracts });
      expect(SESSION_STATES.has(observation.session)).toBe(true);
      expect(observation.turnIds.length).toBeLessThanOrEqual(256);
      expect(observation.completionActionCount).toBeGreaterThanOrEqual(0);
      for (const result of Object.values(observation.contracts)) {
        expect(result.count).toBeGreaterThanOrEqual(0);
        expect(result.visible).toBeLessThanOrEqual(result.count);
      }
    }
  });
});
