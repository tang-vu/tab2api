import type { Page } from 'playwright';
import type { BrowserController } from '../../browser/controller.js';
import type { AppConfig } from '../../config/index.js';
import { AppError, asSafeAppError } from '../../errors.js';
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  ListProjectsRequest,
  ProjectSummary,
  SessionState,
  UploadProjectFilesRequest,
  UploadProjectFilesResult,
  WebChatProvider,
} from '../../provider.js';
import { assertTextCapabilities, validateProviderConfiguration } from '../../providers/catalog.js';
import {
  WEB_UI_DEFINITIONS,
  type ExperimentalWebProviderId,
  type WebUiDefinition,
} from './definitions.js';
import { WebOperationDeadline } from './deadline.js';
import { inspectWebDocument, type WebSnapshot } from './dom.js';

const POLL_MS = 200;
const MAX_OBSERVATIONS = 3_000;
const INITIAL_OBSERVATIONS = 20;
const STABLE_ENDED_OBSERVATIONS = 3;
const CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Opt-in, text-only experiments against public UI, not official provider integrations.
 * Each operation owns exactly one fresh tab. There is deliberately no submit fallback,
 * retry, history continuation, hidden endpoint, credential access, or challenge handling.
 */
export class WebTextAdapter implements WebChatProvider {
  readonly id: ExperimentalWebProviderId;
  private readonly definition: WebUiDefinition;
  private lastSessionState: SessionState = 'browser_disconnected';

  constructor(
    private readonly browser: BrowserController,
    private readonly config: AppConfig,
    providerId: ExperimentalWebProviderId,
  ) {
    // Validate the requested adapter, not only config.provider: direct construction must
    // not turn a permitted/default provider config into access to a different provider.
    validateProviderConfiguration({ ...config, provider: providerId });
    this.id = providerId;
    this.definition = WEB_UI_DEFINITIONS[providerId];
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    assertTextCapabilities(this.id, request);
    return this.withPage(request.signal, async (page, deadline) => {
      const initial = await this.initialSnapshot(page, deadline);
      this.assertReady(initial);
      if (!initial.composerEmpty || initial.userCount > 0 || initial.turns.length > 0) {
        throw this.uiChanged('The new-chat page contains an existing draft or conversation.');
      }
      const baseline = new Set(initial.turns.map((turn) => turn.id));
      const composer = page.locator(`:is(${this.definition.composer}):visible`);
      this.assertOrigin(page);
      await deadline.run(() => composer.fill(request.prompt, { timeout: deadline.remaining() }));
      const beforeSend = await this.snapshot(page, deadline);
      this.assertReady(beforeSend);
      if (
        beforeSend.composerEmpty ||
        beforeSend.composerText !== request.prompt.trim() ||
        beforeSend.sendCount !== 1 ||
        !beforeSend.sendEnabled ||
        beforeSend.userCount !== initial.userCount ||
        beforeSend.turns.length !== initial.turns.length
      ) {
        throw this.uiChanged('The composer or send control changed before submission.');
      }
      this.assertOrigin(page);
      deadline.check();
      try {
        // Exactly one gesture. A rejected click can still have sent the prompt; never
        // retry it and never follow it with Enter or another send button.
        await deadline.run(() =>
          page.locator(`:is(${this.definition.send}):visible`).click({
            timeout: deadline.remaining(),
          }),
        );
      } catch (error) {
        if (deadline.signal.aborted) throw error;
        throw new AppError(
          'submission_uncertain',
          `${this.definition.name} did not confirm the submit gesture. The prompt may have been sent.`,
          'Inspect the provider manually before retrying. tab2api did not submit again.',
        );
      }
      const text = await this.waitForAnswer(page, deadline, baseline);
      return { text, providerModel: this.id };
    });
  }

  async health(): Promise<SessionState> {
    try {
      return await this.withPage(
        undefined,
        async (page, deadline) => (await this.initialSnapshot(page, deadline)).state,
      );
    } catch (error) {
      const state = error instanceof AppError ? this.stateForError(error) : 'browser_disconnected';
      this.lastSessionState = state;
      return state;
    }
  }

  async waitForManualLogin(onState: (state: SessionState) => void): Promise<void> {
    await this.withPage(undefined, async (page, deadline) => {
      let previous: SessionState | undefined;
      for (let observation = 0; observation < MAX_OBSERVATIONS; observation += 1) {
        const snapshot = await this.snapshot(page, deadline);
        if (snapshot.state !== previous) {
          onState(snapshot.state);
          previous = snapshot.state;
        }
        if (snapshot.state === 'ready') return;
        // Login is the only manual flow this method waits for. It does not click login,
        // inspect credentials, solve challenges, or wait through provider rate limits.
        if (snapshot.state !== 'login_required' && snapshot.state !== 'ui_changed') {
          this.assertReady(snapshot);
        }
        await deadline.pause(POLL_MS);
      }
      throw new AppError('timeout', 'The manual login observation limit was reached.');
    });
  }

  sessionState(): SessionState {
    return this.lastSessionState;
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.lastSessionState = 'browser_disconnected';
    await this.browser.close();
  }

  async generateImage(_request: GenerateImageRequest): Promise<GenerateImageResult> {
    throw this.unsupported('image generation');
  }

  async createProject(_request: CreateProjectRequest): Promise<ProjectSummary> {
    throw this.unsupported('projects');
  }

  async listProjects(_request: ListProjectsRequest): Promise<readonly ProjectSummary[]> {
    throw this.unsupported('projects');
  }

  async deleteProject(_request: DeleteProjectRequest): Promise<void> {
    throw this.unsupported('projects');
  }

  async uploadProjectFiles(_request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult> {
    throw this.unsupported('project file uploads');
  }

  private unsupported(capability: string): AppError {
    return new AppError('unsupported_capability', `${this.id} does not support ${capability}.`);
  }

  private uiChanged(
    message = 'The experimental provider UI could not be identified safely.',
  ): AppError {
    return new AppError(
      'ui_changed',
      message,
      'Do not retry automatically. Inspect the provider manually.',
    );
  }

  private assertOrigin(page: Page): void {
    let url: URL;
    try {
      url = new URL(page.url());
    } catch {
      throw this.uiChanged('The provider page has an invalid URL.');
    }
    if (url.origin !== this.definition.origin || url.username !== '' || url.password !== '') {
      throw this.uiChanged('The provider navigated outside its allowed HTTPS origin.');
    }
  }

  private assertReady(snapshot: WebSnapshot): void {
    if (snapshot.state === 'ready' && !snapshot.invalid) return;
    if (
      snapshot.state === 'login_required' ||
      snapshot.state === 'security_challenge' ||
      snapshot.state === 'rate_limited'
    ) {
      throw new AppError(snapshot.state, `${this.definition.name} reported ${snapshot.state}.`);
    }
    if (snapshot.state === 'generation_in_progress') {
      throw this.uiChanged('The provider already has a generation in progress.');
    }
    throw this.uiChanged();
  }

  private async snapshot(page: Page, deadline: WebOperationDeadline): Promise<WebSnapshot> {
    deadline.check();
    if (page.isClosed()) throw new AppError('browser_disconnected', 'The provider tab was closed.');
    this.assertOrigin(page);
    const snapshot = await deadline.run(() =>
      page.evaluate(inspectWebDocument, { definition: this.definition }),
    );
    // Navigation may have occurred while the DOM was being observed.
    this.assertOrigin(page);
    this.lastSessionState = snapshot.state;
    return snapshot;
  }

  private async initialSnapshot(page: Page, deadline: WebOperationDeadline): Promise<WebSnapshot> {
    for (let attempt = 0; attempt < INITIAL_OBSERVATIONS; attempt += 1) {
      const snapshot = await this.snapshot(page, deadline);
      if (snapshot.state !== 'ui_changed' || snapshot.invalid || snapshot.composerCount > 1)
        return snapshot;
      if (attempt === INITIAL_OBSERVATIONS - 1) return snapshot;
      await deadline.pause(POLL_MS);
    }
    throw this.uiChanged();
  }

  private async waitForAnswer(
    page: Page,
    deadline: WebOperationDeadline,
    baseline: ReadonlySet<string>,
  ): Promise<string> {
    let boundId: string | undefined;
    let lastText = '';
    let stableEnded = 0;
    let sawBusy = false;
    for (let observation = 0; observation < MAX_OBSERVATIONS; observation += 1) {
      const snapshot = await this.snapshot(page, deadline);
      if (snapshot.state !== 'generation_in_progress') this.assertReady(snapshot);
      if (snapshot.invalid) throw this.uiChanged();
      sawBusy ||= snapshot.busy || snapshot.turns.some((turn) => turn.pending);
      const fresh = snapshot.turns.filter((turn) => !baseline.has(turn.id));
      if (fresh.length > 1) throw this.uiChanged('More than one new assistant turn appeared.');
      const turn = fresh[0];
      if (turn !== undefined) {
        if (boundId !== undefined && boundId !== turn.id) {
          throw this.uiChanged('The new assistant turn changed identity.');
        }
        boundId = turn.id;
        const ended =
          !snapshot.busy &&
          !turn.pending &&
          snapshot.composerEmpty &&
          (turn.ended || (sawBusy && turn.completionAction));
        if (ended && turn.text.length > 0) {
          stableEnded = turn.text === lastText ? stableEnded + 1 : 1;
          if (stableEnded >= STABLE_ENDED_OBSERVATIONS) return turn.text;
        } else {
          stableEnded = 0;
        }
        lastText = turn.text;
      } else {
        stableEnded = 0;
      }
      await deadline.pause(POLL_MS);
    }
    throw new AppError('timeout', 'The provider response observation limit was reached.');
  }

  private stateForError(error: AppError): SessionState {
    if (
      error.code === 'login_required' ||
      error.code === 'security_challenge' ||
      error.code === 'rate_limited' ||
      error.code === 'browser_disconnected'
    )
      return error.code;
    return 'ui_changed';
  }

  private async closePage(page: Page): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.close().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withPage<T>(
    signal: AbortSignal | undefined,
    action: (page: Page, deadline: WebOperationDeadline) => Promise<T>,
  ): Promise<T> {
    const deadline = new WebOperationDeadline(this.config.requestTimeoutMs, signal);
    let page: Page | undefined;
    let finished = false;
    let failure: AppError | undefined;
    let result: { value: T } | undefined;
    try {
      const currentPage = await deadline.run(() =>
        this.browser.getPage().then(async (acquired) => {
          if (finished) {
            // A browser attachment is not cancellable. If it resolves after our deadline,
            // close its late tab without navigating, filling or ever submitting anything.
            if (!(await this.closePage(acquired))) this.lastSessionState = 'browser_disconnected';
          } else {
            page = acquired;
          }
          return acquired;
        }),
      );
      deadline.check();
      await deadline.run(() =>
        currentPage.goto(this.definition.url, {
          waitUntil: 'domcontentloaded',
          timeout: deadline.remaining(),
        }),
      );
      result = { value: await action(currentPage, deadline) };
    } catch (error) {
      failure = asSafeAppError(error);
      this.lastSessionState = this.stateForError(failure);
    } finally {
      finished = true;
      deadline.dispose();
      if (page !== undefined && !(await this.closePage(page))) {
        this.lastSessionState = 'browser_disconnected';
        failure ??= new AppError(
          'browser_disconnected',
          'The owned provider tab could not be closed cleanly.',
        );
      }
    }
    if (failure !== undefined) throw failure;
    if (result === undefined) throw this.uiChanged();
    return result.value;
  }
}
