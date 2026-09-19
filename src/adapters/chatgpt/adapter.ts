import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Logger } from 'pino';
import { AppError, abortError, asSafeAppError } from '../../errors.js';
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
import type { AppConfig } from '../../config/index.js';
import type { BrowserController } from '../../browser/controller.js';
import type { EventLog } from '../../observability/events.js';
import type { MetricsRegistry } from '../../observability/metrics.js';
import { assertSafeDataChildDirectory } from '../../security/paths.js';
import { hardenPrivateDirectoryPermissions } from '../../security/private-files.js';
import {
  CHATGPT_URL,
  TEMPORARY_CHAT_URL,
  conversationUrl,
  projectConversationUrl,
  projectUrl,
} from './identifiers.js';
import { observe } from './session.js';
import { waitForInitialObservation } from './session.js';
import { runTextTurn } from './turn.js';
import { runImageTurn } from './image-turn.js';
import { ProjectOps } from './projects.js';
import { TurnLifecycle, postSubmitError, turnAbortError } from './turn-lifecycle.js';
import type { DomObservation } from './observe-dom.js';
import {
  buildDiagnostics,
  capabilitySnapshot,
  fingerprintObservation,
  type AdapterDiagnostics,
  type CapabilitySnapshot,
  type CompatFingerprint,
} from './diagnostics.js';

/**
 * Continuing a conversation wins over starting a new one in the project. When both are
 * known the project-scoped conversation URL is used directly, because the bare `/c/<id>`
 * form only redirects there and the redirect can outlast the initial readiness wait.
 */
function navigationTarget(request: GenerateRequest): string {
  const { conversationId, projectId, temporary } = request;
  if ((conversationId !== undefined || projectId !== undefined) && temporary === true) {
    throw new AppError(
      'invalid_request',
      'Temporary Chat cannot continue a saved conversation or run inside a project.',
    );
  }
  if (conversationId !== undefined) {
    return projectId === undefined
      ? conversationUrl(conversationId)
      : projectConversationUrl(projectId, conversationId);
  }
  if (projectId !== undefined) return projectUrl(projectId);
  return temporary === true ? TEMPORARY_CHAT_URL : CHATGPT_URL;
}

/**
 * The provider orchestrator. UI knowledge lives in `selector-contracts.ts` (semantic
 * candidates) and `observe-dom.ts` (the shared decoder); turn flow lives in `turn.ts`,
 * `image-turn.ts`, and `turn-lifecycle.ts`; projects live in `projects.ts`. This class
 * owns page lifecycle, the post-submit error boundary, diagnostics capture, and session
 * state tracking — it never re-derives DOM facts itself.
 */
export class ChatGptAdapter implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;
  /**
   * The browser has not run until the first probe or turn, so `browser_disconnected`
   * is the honest pre-observation value rather than an invented `unknown` state.
   */
  private lastSessionState: SessionState = 'browser_disconnected';
  private lastFingerprint: CompatFingerprint | undefined;
  private lastCapabilities: CapabilitySnapshot | undefined;
  private readonly projects: ProjectOps;

  constructor(
    private readonly browser: BrowserController,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly observability?: { events?: EventLog; metrics?: MetricsRegistry },
  ) {
    this.projects = new ProjectOps(
      browser,
      logger,
      async (page, operation, requestId) => this.closePage(page, operation, requestId),
      (state) => {
        this.observeState(state);
      },
    );
  }

  private lifecycleFor(requestId: string): TurnLifecycle {
    return new TurnLifecycle((transition) => {
      this.observability?.events?.record('turn.phase', transition.phase, requestId);
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const metrics = this.observability?.metrics;
    const events = this.observability?.events;
    metrics?.increment('turns.started');
    const startedAt = Date.now();
    let page: Page | undefined;
    const lifecycle = this.lifecycleFor(request.requestId);
    try {
      if (request.signal.aborted) throw abortError(request.signal);
      // Resolve the target before opening a tab so a rejected identifier never navigates.
      const target = navigationTarget(request);
      page = await this.browser.getPage();
      if (request.signal.aborted) throw abortError(request.signal);
      const hooks = {
        onObservation: (observation: DomObservation, url: string) =>
          this.captureDiagnostics(observation, url, 'chat'),
      };
      const result = await runTextTurn(page, request, target, lifecycle, hooks);
      metrics?.increment('turns.completed');
      events?.record('turn.completed', undefined, request.requestId);
      return result;
    } catch (error) {
      if (request.signal.aborted) {
        const aborted = turnAbortError(request.signal, lifecycle.postSubmit);
        metrics?.increment('turns.failed');
        metrics?.recordError(aborted.code);
        events?.record('turn.failed', aborted.code, request.requestId);
        throw aborted;
      }
      if (error instanceof AppError) {
        metrics?.increment('turns.failed');
        metrics?.recordError(error.code);
        events?.record('turn.failed', error.code, request.requestId);
        if (error.code === 'ui_changed' && this.config.debug && page !== undefined) {
          await this.captureDebugScreenshot(page, request.requestId);
        }
        throw error;
      }
      metrics?.increment('turns.failed');
      const safe = lifecycle.postSubmit ? postSubmitError(error) : asSafeAppError(error);
      metrics?.recordError(safe.code);
      events?.record('turn.failed', safe.code, request.requestId);
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          requestId: request.requestId,
          postSubmit: lifecycle.postSubmit,
        },
        'browser request failed',
      );
      // A submitted prompt is never retried because generation may already have started.
      throw safe;
    } finally {
      metrics?.observeDuration('generate', Date.now() - startedAt);
      await this.closePage(page, 'generation', request.requestId);
    }
  }

  async generateImage(request: GenerateImageRequest): Promise<GenerateImageResult> {
    const metrics = this.observability?.metrics;
    const events = this.observability?.events;
    metrics?.increment('images.started');
    const startedAt = Date.now();
    let page: Page | undefined;
    const lifecycle = this.lifecycleFor(request.requestId);
    try {
      if (request.signal.aborted) throw abortError(request.signal);
      page = await this.browser.getPage();
      if (request.signal.aborted) throw abortError(request.signal);
      const hooks = {
        onObservation: (observation: DomObservation, url: string) =>
          this.captureDiagnostics(observation, url, 'chat'),
      };
      const result = await runImageTurn(page, request, lifecycle, this.config, hooks);
      metrics?.increment('images.completed');
      events?.record('image.completed', undefined, request.requestId);
      return result;
    } catch (error) {
      if (request.signal.aborted) {
        const aborted = turnAbortError(request.signal, lifecycle.postSubmit);
        metrics?.increment('images.failed');
        metrics?.recordError(aborted.code);
        events?.record('image.failed', aborted.code, request.requestId);
        throw aborted;
      }
      if (error instanceof AppError) {
        metrics?.increment('images.failed');
        metrics?.recordError(error.code);
        events?.record('image.failed', error.code, request.requestId);
        throw error;
      }
      metrics?.increment('images.failed');
      const safe = lifecycle.postSubmit ? postSubmitError(error) : asSafeAppError(error);
      metrics?.recordError(safe.code);
      events?.record('image.failed', safe.code, request.requestId);
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          requestId: request.requestId,
          postSubmit: lifecycle.postSubmit,
        },
        'browser image request failed',
      );
      throw safe;
    } finally {
      metrics?.observeDuration('generateImage', Date.now() - startedAt);
      await this.closePage(page, 'image_generation', request.requestId);
    }
  }

  async createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
    return this.projects.createProject(request);
  }

  async listProjects(request: ListProjectsRequest): Promise<readonly ProjectSummary[]> {
    return this.projects.listProjects(request);
  }

  async deleteProject(request: DeleteProjectRequest): Promise<void> {
    return this.projects.deleteProject(request);
  }

  async uploadProjectFiles(request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult> {
    return this.projects.uploadProjectFiles(request);
  }

  private async captureDebugScreenshot(page: Page, requestId: string): Promise<void> {
    try {
      await assertSafeDataChildDirectory(this.config.dataDir, this.config.artifactDir);
      await mkdir(this.config.artifactDir, { recursive: true, mode: 0o700 });
      await hardenPrivateDirectoryPermissions(this.config.dataDir);
      await hardenPrivateDirectoryPermissions(this.config.artifactDir);
      await assertSafeDataChildDirectory(this.config.dataDir, this.config.artifactDir);
      await page.screenshot({
        path: path.join(this.config.artifactDir, `ui-changed-${requestId}.png`),
        fullPage: false,
      });
    } catch (screenshotError) {
      this.logger.warn(
        {
          errorType: screenshotError instanceof Error ? screenshotError.name : 'unknown',
          requestId,
        },
        'diagnostic screenshot was not written',
      );
    }
  }

  private async closePage(
    page: Page | undefined,
    operation: string,
    requestId?: string,
  ): Promise<void> {
    if (page === undefined) return;
    try {
      await page.close();
    } catch (error) {
      this.logger.warn(
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          operation,
          ...(requestId === undefined ? {} : { requestId }),
        },
        'browser page cleanup failed',
      );
    }
  }

  async waitForManualLogin(onState: (state: SessionState) => void): Promise<void> {
    let page: Page | undefined;
    let previous: SessionState | undefined;
    try {
      page = await this.browser.getPage();
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      while (!page.isClosed()) {
        const state = (await observe(page)).session;
        if (state !== previous) {
          this.observeState(state);
          onState(state);
          previous = state;
        }
        if (state === 'ready') return;
        await page.waitForTimeout(1_000);
      }
      this.observeState('browser_disconnected');
      throw new AppError(
        'browser_disconnected',
        'The manual login window was closed before the session became ready.',
      );
    } finally {
      await this.closePage(page, 'manual_login');
    }
  }

  async health(): Promise<SessionState> {
    let page: Page | undefined;
    try {
      page = await this.browser.getPage();
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const observation = await waitForInitialObservation(page);
      this.captureDiagnostics(observation, page.url(), 'chat');
      return this.observeState(observation.session);
    } catch (error) {
      return this.observeState(
        error instanceof AppError && error.code === 'browser_disconnected'
          ? 'browser_disconnected'
          : 'ui_changed',
      );
    } finally {
      await this.closePage(page, 'health');
    }
  }

  sessionState(): SessionState {
    return this.lastSessionState;
  }

  /** Content-free diagnostics from the last live observation, for doctor and /admin. */
  diagnostics(): AdapterDiagnostics {
    return buildDiagnostics(this.lastSessionState, this.lastFingerprint, this.lastCapabilities);
  }

  private captureDiagnostics(
    observation: DomObservation,
    url: string,
    surface: 'chat' | 'projects' | 'unknown',
  ): void {
    this.lastFingerprint = fingerprintObservation(observation, url);
    this.lastCapabilities = capabilitySnapshot(observation, surface);
  }

  private observeState(state: SessionState): SessionState {
    if (state !== this.lastSessionState) {
      this.observability?.metrics?.recordSessionState(state);
      this.observability?.events?.record('session.state', state);
    }
    this.lastSessionState = state;
    return state;
  }

  async reset(): Promise<void> {
    await this.browser.close();
    this.lastSessionState = 'browser_disconnected';
  }

  async close(): Promise<void> {
    await this.browser.close();
    this.lastSessionState = 'browser_disconnected';
  }
}
