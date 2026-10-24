import type { Locator, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebTextAdapter } from '../src/adapters/web/adapter.js';
import {
  WEB_UI_DEFINITIONS,
  type ExperimentalWebProviderId,
} from '../src/adapters/web/definitions.js';
import type { WebSnapshot, WebTurnObservation } from '../src/adapters/web/dom.js';
import type { BrowserController } from '../src/browser/controller.js';
import { AppError } from '../src/errors.js';
import type { GenerateRequest, SessionState } from '../src/provider.js';
import { testConfig } from './helpers.js';

function snapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
  return {
    state: 'ready',
    composerCount: 1,
    composerEmpty: true,
    composerText: '',
    composerEnabled: true,
    sendCount: 1,
    sendEnabled: true,
    busy: false,
    userCount: 0,
    turns: [],
    invalid: false,
    ...overrides,
  };
}

function answer(overrides: Partial<WebTurnObservation> = {}): WebTurnObservation {
  return {
    id: 'new-answer',
    text: 'An offline answer.',
    ended: true,
    pending: false,
    completionAction: true,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakePage {
  currentUrl = 'about:blank';
  closed = false;
  closeCalls = 0;
  fills = 0;
  submissions = 0;
  navigations: string[] = [];
  prompt = '';
  evaluations = 0;
  responseIndex = 0;
  initial = snapshot();
  beforeSend: Partial<WebSnapshot> = {};
  responses: WebSnapshot[] = [snapshot({ turns: [answer()] })];
  redirect: string | undefined;
  redirectAfterFill: string | undefined;
  redirectDuringRead: string | undefined;
  failure: 'goto' | 'fill' | 'click' | 'read' | 'close' | undefined;
  pending: 'goto' | 'fill' | 'click' | 'read' | 'close' | undefined;
  readonly never = deferred<undefined>();
  onFill: (() => undefined) | undefined;

  url(): string {
    return this.currentUrl;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async goto(url: string): Promise<void> {
    this.navigations.push(url);
    this.currentUrl = this.redirect ?? url;
    if (this.failure === 'goto') throw new Error('private failure detail');
    if (this.pending === 'goto') await this.never.promise;
  }
  async evaluate(): Promise<WebSnapshot> {
    this.evaluations += 1;
    if (this.failure === 'read') throw new Error('private page detail');
    if (this.pending === 'read') await this.never.promise;
    if (this.redirectDuringRead !== undefined) this.currentUrl = this.redirectDuringRead;
    if (this.submissions > 0) {
      const observation = this.responses[Math.min(this.responseIndex, this.responses.length - 1)];
      this.responseIndex += 1;
      if (observation === undefined) throw new Error('invalid fake fixture');
      return observation;
    }
    if (this.fills > 0)
      return snapshot({
        composerEmpty: this.prompt.length === 0,
        composerText: this.prompt,
        ...this.beforeSend,
      });
    return this.initial;
  }
  locator(selector: string): Locator {
    return {
      fill: async (value: string): Promise<void> => {
        if (!selector.includes('contenteditable') && !selector.includes('textarea'))
          throw new Error('unexpected selector');
        this.fills += 1;
        this.prompt = value;
        this.onFill?.();
        if (this.redirectAfterFill !== undefined) this.currentUrl = this.redirectAfterFill;
        if (this.failure === 'fill') throw new Error('fill failed');
        if (this.pending === 'fill') await this.never.promise;
      },
      click: async (): Promise<void> => {
        if (!selector.includes('button')) throw new Error('unexpected selector');
        this.submissions += 1;
        this.prompt = '';
        if (this.failure === 'click') throw new Error('click result lost after possible delivery');
        if (this.pending === 'click') await this.never.promise;
      },
    } as unknown as Locator;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failure === 'close') throw new Error('close failed');
    if (this.pending === 'close') await this.never.promise;
    this.closed = true;
  }
}

class FakeBrowser implements BrowserController {
  readonly page = new FakePage();
  gets = 0;
  closes = 0;
  acquisition: Promise<Page> | undefined;
  async getPage(): Promise<Page> {
    this.gets += 1;
    return this.acquisition ?? (this.page as unknown as Page);
  }
  async close(): Promise<void> {
    this.closes += 1;
  }
}

function setup(id: ExperimentalWebProviderId, timeoutMs = 5_000) {
  const browser = new FakeBrowser();
  const config = testConfig({
    provider: id,
    experimentalProviders: true,
    providerPermission: id,
    requestTimeoutMs: timeoutMs,
  });
  const adapter = new WebTextAdapter(browser, config, id);
  const controller = new AbortController();
  const request: GenerateRequest = {
    prompt: 'Private offline test',
    requestId: 'offline-only',
    signal: controller.signal,
  };
  return { browser, page: browser.page, adapter, controller, request };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
});

for (const id of ['claude-web', 'grok-web'] as const) {
  describe(`${id} offline lifecycle`, () => {
    it('requires provider permission even through direct construction or mismatched config', () => {
      const browser = new FakeBrowser();
      expect(() => new WebTextAdapter(browser, testConfig(), id)).toThrow(
        expect.objectContaining({ code: 'provider_unavailable' }),
      );
      expect(
        () =>
          new WebTextAdapter(
            browser,
            testConfig({
              experimentalProviders: true,
              providerPermission: id === 'claude-web' ? 'grok-web' : 'claude-web',
            }),
            id,
          ),
      ).toThrow(expect.objectContaining({ code: 'provider_unavailable' }));
      expect(browser.gets).toBe(0);
    });

    it('submits exactly once, returns only a new stable ended answer and closes the tab', async () => {
      const { adapter, page, request } = setup(id);
      const result = adapter.generate(request);
      await vi.advanceTimersByTimeAsync(600);
      await expect(result).resolves.toEqual({ text: 'An offline answer.', providerModel: id });
      expect(page.navigations).toEqual([WEB_UI_DEFINITIONS[id].url]);
      expect(page.fills).toBe(1);
      expect(page.submissions).toBe(1);
      expect(page.closeCalls).toBe(1);
      expect(page.closed).toBe(true);
      expect(adapter.sessionState()).toBe('ready');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts positive busy-to-ended evidence with a turn-scoped completion action', async () => {
      const { adapter, page, request } = setup(id);
      page.responses = [
        snapshot({
          state: 'generation_in_progress',
          busy: true,
          turns: [answer({ ended: false, pending: true })],
        }),
        snapshot({ turns: [answer({ ended: false })] }),
      ];
      const result = adapter.generate(request);
      await vi.advanceTimersByTimeAsync(800);
      await expect(result).resolves.toMatchObject({ text: 'An offline answer.' });
    });

    it('does not accept stable text or copy actions alone as completion', async () => {
      const { adapter, page, request } = setup(id, 1_000);
      page.responses = [snapshot({ turns: [answer({ ended: false })] })];
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(page.closed).toBe(true);
      expect(page.submissions).toBe(1);
    });

    it('resets stability when response text changes or generation resumes', async () => {
      const { adapter, page, request } = setup(id);
      page.responses = [
        snapshot({ turns: [answer({ text: 'First' })] }),
        snapshot({ turns: [answer({ text: 'Second' })] }),
        snapshot({
          state: 'generation_in_progress',
          busy: true,
          turns: [answer({ text: 'Second', pending: true })],
        }),
        snapshot({ turns: [answer({ text: 'Final' })] }),
      ];
      const result = adapter.generate(request);
      await vi.advanceTimersByTimeAsync(800);
      expect(page.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ text: 'Final' });
    });

    it.each([
      {
        attachments: [
          { data: Buffer.from('x'), mimeType: 'image/png' as const, filename: 'x.png' },
        ],
      },
      { projectId: 'project' },
      { conversationId: 'conversation' },
      { temporary: true },
      { effort: 'high' as const },
    ])('rejects unsupported text options before acquisition: %j', async (options) => {
      const { adapter, browser, request } = setup(id);
      await expect(adapter.generate({ ...request, ...options })).rejects.toMatchObject({
        code: 'unsupported_capability',
      });
      expect(browser.gets).toBe(0);
    });

    it('allows explicit false temporary and empty attachment options without silently changing provider', async () => {
      const { adapter, request } = setup(id);
      const result = adapter.generate({ ...request, temporary: false, attachments: [] });
      await vi.advanceTimersByTimeAsync(600);
      await expect(result).resolves.toMatchObject({ providerModel: id });
    });

    it('rejects every non-text capability without browser access', async () => {
      const { adapter, browser, request } = setup(id);
      const attempts = [
        adapter.generateImage(request),
        adapter.createProject({ ...request, name: 'project' }),
        adapter.listProjects(request),
        adapter.deleteProject({ ...request, projectId: 'p' }),
        adapter.uploadProjectFiles({ ...request, projectId: 'p', attachments: [] }),
      ];
      await Promise.all(
        attempts.map(async (attempt) =>
          expect(attempt).rejects.toMatchObject({ code: 'unsupported_capability' }),
        ),
      );
      expect(browser.gets).toBe(0);
    });

    it.each(['login_required', 'security_challenge', 'rate_limited'] as const)(
      'fails closed on %s without filling or submitting',
      async (state) => {
        const { adapter, page, request } = setup(id);
        page.initial = snapshot({ state });
        await expect(adapter.generate(request)).rejects.toMatchObject({ code: state });
        expect(page.fills).toBe(0);
        expect(page.submissions).toBe(0);
        expect(page.closed).toBe(true);
      },
    );

    it.each([
      { composerEmpty: false, composerText: 'Someone else’s draft' },
      { state: 'generation_in_progress' as const, busy: true },
      { turns: [answer({ id: 'existing-answer' })] },
      { userCount: 1 },
      { state: 'ui_changed' as const, composerCount: 2 },
      { state: 'ui_changed' as const, invalid: true },
    ])('rejects existing or ambiguous initial state %j', async (state) => {
      const { adapter, page, request } = setup(id);
      page.initial = snapshot(state);
      await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'ui_changed' });
      expect(page.fills).toBe(0);
      expect(page.submissions).toBe(0);
      expect(page.closed).toBe(true);
    });

    it('returns a typed changed-UI error after bounded initial rendering observations', async () => {
      const { adapter, page, request } = setup(id);
      page.initial = snapshot({ state: 'ui_changed', composerCount: 0 });
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'ui_changed',
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await rejection;
      expect(page.fills).toBe(0);
      expect(page.evaluations).toBe(20);
    });

    it.each([
      { sendCount: 0 },
      { sendCount: 2 },
      { sendEnabled: false },
      { composerText: 'Changed draft' },
      { composerEmpty: true },
      { userCount: 1 },
      { turns: [answer()] },
      { state: 'login_required' as const },
    ])('does not send when the pre-submit UI changes: %j', async (state) => {
      const { adapter, page, request } = setup(id);
      page.beforeSend = state;
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: state.state === 'login_required' ? 'login_required' : 'ui_changed',
      });
      expect(page.submissions).toBe(0);
      expect(page.closed).toBe(true);
    });

    it.each(['redirect', 'redirectAfterFill', 'redirectDuringRead'] as const)(
      'blocks off-origin navigation at %s',
      async (field) => {
        const { adapter, page, request } = setup(id);
        page[field] = 'https://evil.invalid/';
        await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'ui_changed' });
        expect(page.submissions).toBe(0);
        if (field !== 'redirectAfterFill') expect(page.fills).toBe(0);
        expect(page.closed).toBe(true);
      },
    );

    it('does not retry or press Enter after an ambiguous submit error', async () => {
      const { adapter, page, request } = setup(id);
      page.failure = 'click';
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'submission_uncertain',
      });
      expect(page.submissions).toBe(1);
      expect(page.closed).toBe(true);
    });

    it.each(['goto', 'fill', 'read'] as const)(
      'sanitizes %s failures and cleans up',
      async (failure) => {
        const { adapter, page, request } = setup(id);
        page.failure = failure;
        await expect(adapter.generate(request)).rejects.toMatchObject({
          code: 'browser_disconnected',
          message: 'The browser operation failed.',
        });
        expect(page.submissions).toBe(0);
        expect(page.closed).toBe(true);
      },
    );

    it.each(['login_required', 'security_challenge', 'rate_limited', 'ui_changed'] as const)(
      'does not return partial text after %s mid-generation',
      async (state) => {
        const { adapter, page, request } = setup(id);
        page.responses = [snapshot({ state, turns: [answer()] })];
        await expect(adapter.generate(request)).rejects.toMatchObject({ code: state });
        expect(page.submissions).toBe(1);
        expect(page.closed).toBe(true);
      },
    );

    it.each([
      [snapshot({ turns: [answer(), answer({ id: 'another-answer' })] })],
      [
        snapshot({ turns: [answer()] }),
        snapshot({ turns: [answer({ id: 'replacement-answer' })] }),
      ],
      [snapshot({ invalid: true, state: 'generation_in_progress' })],
    ])('rejects ambiguous, replaced, or invalid new turns', async (...observations) => {
      const { adapter, page, request } = setup(id);
      page.responses = observations;
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'ui_changed',
      });
      await vi.advanceTimersByTimeAsync(400);
      await rejection;
      expect(page.closed).toBe(true);
    });

    it('never returns an empty or still pending answer', async () => {
      const { adapter, page, request } = setup(id, 1_000);
      page.responses = [
        snapshot({ turns: [answer({ text: '' })] }),
        snapshot({ state: 'generation_in_progress', turns: [answer({ pending: true })] }),
      ];
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    });

    it('supports cancellation before acquisition', async () => {
      const { adapter, browser, controller, request } = setup(id);
      controller.abort();
      await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'cancelled' });
      expect(browser.gets).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['cancelled', 'timeout'] as const)(
      'settles %s while acquisition is pending and cleans the late tab without navigation',
      async (code) => {
        const { adapter, browser, page, controller, request } = setup(id, 1_000);
        const acquisition = deferred<Page>();
        browser.acquisition = acquisition.promise;
        const rejection = expect(adapter.generate(request)).rejects.toMatchObject({ code });
        await vi.advanceTimersByTimeAsync(0);
        if (code === 'cancelled') controller.abort();
        else await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        expect(page.navigations).toHaveLength(0);
        acquisition.resolve(page as unknown as Page);
        await vi.advanceTimersByTimeAsync(0);
        expect(page.closeCalls).toBe(1);
        expect(page.navigations).toHaveLength(0);
        expect(page.fills).toBe(0);
        expect(page.submissions).toBe(0);
      },
    );

    it('cleans an acquisition resolving at the same time as cancellation', async () => {
      const { adapter, browser, page, controller, request } = setup(id);
      const acquisition = deferred<Page>();
      browser.acquisition = acquisition.promise;
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'cancelled',
      });
      await vi.advanceTimersByTimeAsync(0);
      acquisition.resolve(page as unknown as Page);
      controller.abort();
      await rejection;
      await vi.advanceTimersByTimeAsync(0);
      expect(page.closeCalls).toBe(1);
      expect(page.navigations).toHaveLength(0);
    });

    it.each(['goto', 'fill', 'read', 'click'] as const)(
      'cancels a pending %s operation promptly',
      async (pending) => {
        const { adapter, page, controller, request } = setup(id);
        page.pending = pending;
        const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
          code: 'cancelled',
        });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejection;
        expect(page.closed).toBe(true);
        expect(page.submissions).toBe(pending === 'click' ? 1 : 0);
      },
    );

    it('does not submit after cancellation following fill', async () => {
      const { adapter, page, controller, request } = setup(id);
      page.onFill = () => {
        controller.abort();
        return undefined;
      };
      await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'cancelled' });
      expect(page.submissions).toBe(0);
      expect(page.closed).toBe(true);
    });

    it('preserves external timeout reasons and removes external abort listeners', async () => {
      const { adapter, page, controller, request } = setup(id);
      page.responses = [snapshot()];
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new AppError('timeout', 'External deadline'));
      await rejection;
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(page.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds hanging page cleanup and reports the cleanup failure', async () => {
      const { adapter, page, request } = setup(id);
      page.pending = 'close';
      const rejection = expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'browser_disconnected',
      });
      await vi.advanceTimersByTimeAsync(1_600);
      await rejection;
      expect(page.closeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves the primary failure if cleanup also fails', async () => {
      const { adapter, page, request } = setup(id);
      page.initial = snapshot({ state: 'login_required' });
      page.failure = 'close';
      await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'login_required' });
      expect(adapter.sessionState()).toBe('browser_disconnected');
    });

    it('health uses an ephemeral read-only tab, then reset and close release the browser', async () => {
      const { adapter, browser, page } = setup(id);
      expect(adapter.sessionState()).toBe('browser_disconnected');
      expect(browser.gets).toBe(0);
      await expect(adapter.health()).resolves.toBe('ready');
      expect(page.closeCalls).toBe(1);
      expect(page.fills).toBe(0);
      expect(page.submissions).toBe(0);
      await adapter.reset();
      await adapter.close();
      expect(browser.closes).toBe(2);
      expect(adapter.sessionState()).toBe('browser_disconnected');
    });

    it('health reports connection failures and bounds pending acquisition', async () => {
      const { adapter, browser } = setup(id, 1_000);
      browser.acquisition = Promise.reject(new Error('offline'));
      await expect(adapter.health()).resolves.toBe('browser_disconnected');
      browser.acquisition = deferred<Page>().promise;
      const health = adapter.health();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(health).resolves.toBe('ui_changed');
    });

    it('manual login observes state changes without clicking and closes the tab on readiness', async () => {
      const { adapter, page } = setup(id);
      page.initial = snapshot({ state: 'login_required' });
      const states: SessionState[] = [];
      const login = adapter.waitForManualLogin((state) => states.push(state));
      await vi.advanceTimersByTimeAsync(400);
      page.initial = snapshot();
      await vi.advanceTimersByTimeAsync(200);
      await login;
      expect(states).toEqual(['login_required', 'ready']);
      expect(page.submissions).toBe(0);
      expect(page.closed).toBe(true);
    });

    it('manual login does not solve or wait through security challenges', async () => {
      const { adapter, page } = setup(id);
      page.initial = snapshot({ state: 'security_challenge' });
      await expect(adapter.waitForManualLogin(() => undefined)).rejects.toMatchObject({
        code: 'security_challenge',
      });
      expect(page.closed).toBe(true);
    });

    it('manual login is bounded and recognizes a manually closed tab', async () => {
      const { adapter, page } = setup(id, 1_000);
      page.initial = snapshot({ state: 'login_required' });
      const rejection = expect(adapter.waitForManualLogin(() => undefined)).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      const second = setup(id);
      second.page.closed = true;
      await expect(second.adapter.waitForManualLogin(() => undefined)).rejects.toMatchObject({
        code: 'browser_disconnected',
      });
    });
  });
}
