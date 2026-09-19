import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';
import { AppError, abortError, asSafeAppError } from '../../errors.js';
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  ListProjectsRequest,
  ProjectSummary,
  SessionState,
  UploadProjectFilesRequest,
  UploadProjectFilesResult,
} from '../../provider.js';
import type { BrowserController } from '../../browser/controller.js';
import { boundedAttempts, operationTimeout } from '../../browser/deadline.js';
import { abortRace } from './turn-lifecycle.js';
import { contractError, firstVisible } from './locators.js';
import { contractCandidates } from './selector-contracts.js';
import { UI_SELECTORS } from './selectors.js';
import { waitForProjectObservation, errorForState } from './session.js';
import { PROJECTS_URL, projectIdFromHref, projectSourcesUrl, projectUrl } from './identifiers.js';

/**
 * Project operations on the ChatGPT projects grid. The grid renders a table rather than
 * links and publishes no project id in the DOM, so a row's identity is only observable by
 * opening it; the bounded walks below keep that cost proportional to a bounded row count,
 * not to an unbounded account.
 */

const POLL_MS = 300;
const INITIAL_STATE_ATTEMPTS = 40;
const INITIAL_STATE_POLL_MS = 250;
const PROJECT_UPLOAD_TIMEOUT_MS = 120_000;
const PROJECT_ID_ATTEMPTS = 40;
const PROJECT_ROW_STABLE_OBSERVATIONS = 4;
/**
 * Listing and deleting cost one navigation per row because the grid publishes no id, so the
 * work is bounded rather than proportional to an unbounded account.
 */
const MAX_LISTED_PROJECTS = 25;

export class ProjectOps {
  constructor(
    private readonly browser: BrowserController,
    private readonly logger: Logger,
    private readonly closePage: (
      page: Page | undefined,
      operation: string,
      requestId?: string,
    ) => Promise<void>,
    private readonly observeState: (state: SessionState) => void,
  ) {}

  async createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
    return this.withProjectPage(
      PROJECTS_URL,
      request.signal,
      request.requestId,
      request.deadlineAt,
      async (page) => {
        const newProject = await firstVisible(page, contractCandidates('newProjectButton'));
        if (newProject === undefined) throw contractError('newProjectButton', 'ui_changed');
        await newProject.click();
        const nameInput = await this.waitForVisible(
          page,
          contractCandidates('projectNameInput'),
          request.signal,
          request.deadlineAt,
        );
        await nameInput.fill(request.name);
        const confirm = await firstVisible(page, contractCandidates('projectCreateConfirm'));
        if (confirm === undefined) throw contractError('projectCreateConfirm', 'ui_changed');
        await confirm.click();
        // Creating navigates into the new project, which is the only place its id appears.
        const id = await this.waitForProjectId(page, request.signal, request.deadlineAt);
        return { id, name: request.name };
      },
    );
  }

  async listProjects(request: ListProjectsRequest): Promise<readonly ProjectSummary[]> {
    return this.withProjectPage(
      PROJECTS_URL,
      request.signal,
      request.requestId,
      request.deadlineAt,
      async (page) => {
        const rows = await this.waitForProjectRows(page, request.signal, request.deadlineAt);
        if (rows === undefined) return [];
        const summaries = new Map<string, string>();
        const total = Math.min(rows.count, MAX_LISTED_PROJECTS);
        for (let visited = 0; visited < total; visited += 1) {
          if (request.signal.aborted) throw abortError(request.signal);
          // Opening a project moves it to the front of ChatGPT's modified-time-sorted grid.
          // Repeatedly opening the last row in the bounded prefix walks that prefix backwards
          // without skipping the row shifted into the previous index.
          const opened = await this.openProjectRow(
            page,
            rows.selector,
            total - 1,
            request.signal,
            request.deadlineAt,
          );
          summaries.set(opened.id, opened.name);
          await this.returnToProjects(page, request.signal, request.deadlineAt);
        }
        return [...summaries].map(([id, name]) => ({ id, name }));
      },
    );
  }

  async deleteProject(request: DeleteProjectRequest): Promise<void> {
    const target = projectUrl(request.projectId);
    await this.withProjectPage(
      target,
      request.signal,
      request.requestId,
      request.deadlineAt,
      async (page) => {
        // Resolve the id to its name inside the project, then delete the row bearing that
        // name. Row position must not be used: opening a project updates its modified time
        // and re-sorts the grid, so an index captured beforehand can point at a different
        // project by the time the delete runs.
        const name = await this.readProjectName(page, request.signal, request.deadlineAt);
        await this.returnToProjects(page, request.signal, request.deadlineAt);
        const options = await this.projectOptionsForName(page, name);
        if (options.length === 0)
          throw new AppError(
            'project_not_found',
            'No project with that id is listed for this account.',
          );
        if (options.length > 1)
          throw new AppError(
            'invalid_request',
            `More than one project is named "${name}". Rename them so deletion is unambiguous.`,
          );
        // The per-row options control is only revealed while its row is hovered.
        const optionsButton = options[0];
        if (optionsButton === undefined) throw contractError('projectOptionsButton', 'ui_changed');
        await optionsButton.locator('xpath=ancestor::*[@role="row"][1]').hover();
        await optionsButton.click();
        const remove = await this.waitForVisible(
          page,
          contractCandidates('projectDeleteMenuItem'),
          request.signal,
          request.deadlineAt,
        );
        await remove.click();
        const confirm = await this.waitForVisible(
          page,
          contractCandidates('projectDeleteConfirm'),
          request.signal,
          request.deadlineAt,
        );
        await confirm.click();
        await this.waitForProjectGone(page, name, request.signal, request.deadlineAt);
      },
    );
  }

  async uploadProjectFiles(request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult> {
    // The sources tab is the project's own file store. Uploading through the composer
    // instead would attach the files to a single message that is discarded with the tab.
    const target = projectSourcesUrl(request.projectId);
    return this.withProjectPage(
      target,
      request.signal,
      request.requestId,
      request.deadlineAt,
      async (page) => {
        const fileInput = await this.projectSourcesInput(page, request.signal, request.deadlineAt);
        await abortRace(
          fileInput.setInputFiles(
            request.attachments.map((attachment) => ({
              name: attachment.filename,
              mimeType: attachment.mimeType,
              buffer: attachment.data,
            })),
            { timeout: operationTimeout(request.deadlineAt, 30_000) },
          ),
          request.signal,
          false,
        );
        // Confirm the sources list actually took the files rather than sleeping blindly.
        await this.waitForSourceNames(
          page,
          request.attachments.map((attachment) => attachment.filename),
          request.signal,
          request.deadlineAt,
        );
        return { projectId: request.projectId, uploaded: request.attachments.length };
      },
    );
  }

  private async waitForVisible(
    page: Page,
    selectors: readonly string[],
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<Locator> {
    const attempts = boundedAttempts(deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      const locator = await firstVisible(page, selectors);
      if (locator !== undefined) return locator;
      await page.waitForTimeout(INITIAL_STATE_POLL_MS);
    }
    throw contractError('projectRow', 'ui_changed');
  }

  /** Finds the options control without interpolating an account-controlled title into CSS. */
  private async projectOptionsForName(page: Page, name: string): Promise<Locator[]> {
    for (const selector of UI_SELECTORS.projectOptionsButton) {
      const candidates = page.locator(selector);
      const count = await candidates.count();
      if (count === 0) continue;
      const matches: Locator[] = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const label = await candidate.getAttribute('aria-label');
        if (label?.endsWith(name) === true) matches.push(candidate);
      }
      return matches;
    }
    return [];
  }

  private async readProjectName(
    page: Page,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<string> {
    const title = await this.waitForVisible(page, UI_SELECTORS.projectTitle, signal, deadlineAt);
    const name = (await title.innerText().catch(() => '')).trim().split('\n')[0] ?? '';
    if (name.length === 0)
      throw new AppError('ui_changed', 'The ChatGPT project title could not be read.');
    return name;
  }

  /** A destructive step is only reported as done once the row is actually gone. */
  private async waitForProjectGone(
    page: Page,
    name: string,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<void> {
    const attempts = boundedAttempts(deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      if ((await this.projectOptionsForName(page, name)).length === 0) return;
      await page.waitForTimeout(INITIAL_STATE_POLL_MS);
    }
    throw new AppError('ui_changed', 'ChatGPT still lists the project after the delete action.');
  }

  /**
   * The sources tab exposes two unrestricted file inputs. Only the composer's one sits
   * inside the composer wrapper, so ancestry — not order — selects the project's input.
   */
  private async projectSourcesInput(
    page: Page,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<Locator> {
    const attempts = boundedAttempts(deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      for (const selector of UI_SELECTORS.projectFileInput) {
        const candidates = page.locator(selector);
        const count = await candidates.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          const insideComposer = await candidate
            .evaluate(
              (element, wrapper) => element.closest(wrapper) !== null,
              UI_SELECTORS.composerWrapper,
            )
            .catch(() => true);
          if (!insideComposer) return candidate;
        }
      }
      await page.waitForTimeout(INITIAL_STATE_POLL_MS);
    }
    throw new AppError('ui_changed', 'The ChatGPT project sources file input is unavailable.');
  }

  private async waitForSourceNames(
    page: Page,
    filenames: readonly string[],
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<void> {
    const deadline = Date.now() + operationTimeout(deadlineAt, PROJECT_UPLOAD_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError(signal);
      const text = await page
        .locator(UI_SELECTORS.projectSourceEntry.at(-1) ?? 'main')
        .innerText()
        .catch(() => '');
      if (filenames.every((filename) => text.includes(filename))) return;
      await page.waitForTimeout(POLL_MS);
    }
    throw new AppError(
      'attachment_failed',
      'ChatGPT did not list the uploaded files in the project sources.',
    );
  }

  /**
   * Opens the row at `index` and reports the project it belongs to. The projects grid
   * publishes no identifier, so opening the row is the only way to learn its id.
   */
  private async openProjectRow(
    page: Page,
    selector: string,
    index: number,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProjectSummary> {
    const row = page.locator(selector).nth(index);
    if ((await row.count()) === 0) throw contractError('projectRow', 'ui_changed');
    const name = (await row.innerText().catch(() => '')).trim().split('\n')[0] ?? '';
    if (name.length === 0) throw contractError('projectRow', 'ui_changed');
    await row.click();
    const id = await this.waitForProjectId(page, signal, deadlineAt);
    return { id, name };
  }

  private async returnToProjects(
    page: Page,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<void> {
    await abortRace(
      page.goto(PROJECTS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: operationTimeout(deadlineAt, 30_000),
      }),
      signal,
      false,
    );
    const observation = await waitForProjectObservation(page, signal, deadlineAt);
    if (observation.session !== 'ready') throw errorForState(observation.session);
    await this.waitForProjectRows(page, signal, deadlineAt);
  }

  /**
   * Resolves the row selector once and reports how many rows it matches. Counting with one
   * selector and indexing with another would address different elements, which previously
   * made a single project appear twice.
   */
  private async projectRowSelector(
    page: Page,
  ): Promise<{ selector: string; count: number } | undefined> {
    for (const selector of UI_SELECTORS.projectRow) {
      const count = await page.locator(selector).count();
      if (count > 0) return { selector, count };
    }
    return undefined;
  }

  /** Waits for the dynamically rendered project grid to stop changing without a fixed sleep. */
  private async waitForProjectRows(
    page: Page,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<{ selector: string; count: number } | undefined> {
    let previousKey: string | undefined;
    let stableObservations = 0;
    let current: { selector: string; count: number } | undefined;
    const attempts = boundedAttempts(deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      current = await this.projectRowSelector(page);
      const key = current === undefined ? 'empty' : `${current.selector}\0${current.count}`;
      stableObservations = key === previousKey ? stableObservations + 1 : 1;
      previousKey = key;
      if (stableObservations >= PROJECT_ROW_STABLE_OBSERVATIONS) return current;
      await page.waitForTimeout(INITIAL_STATE_POLL_MS);
    }
    throw contractError('projectRow', 'ui_changed');
  }

  private async waitForProjectId(
    page: Page,
    signal: AbortSignal,
    deadlineAt?: number,
  ): Promise<string> {
    const attempts = boundedAttempts(deadlineAt, PROJECT_ID_ATTEMPTS, POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw abortError(signal);
      const id = projectIdFromHref(page.url());
      if (id !== undefined) return id;
      await page.waitForTimeout(POLL_MS);
    }
    throw contractError('projectTitle', 'ui_changed', 'The ChatGPT project id was not exposed.');
  }

  /** Opens a tab on a project surface, asserts it is usable, and always closes it. */
  private async withProjectPage<T>(
    url: string,
    signal: AbortSignal,
    requestId: string,
    deadlineAt: number | undefined,
    action: (page: Page) => Promise<T>,
  ): Promise<T> {
    let page: Page | undefined;
    try {
      if (signal.aborted) throw abortError(signal);
      page = await this.browser.getPage();
      if (signal.aborted) throw abortError(signal);
      try {
        await abortRace(
          page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: operationTimeout(deadlineAt, 30_000),
          }),
          signal,
          false,
        );
      } catch {
        if (signal.aborted) throw abortError(signal);
        throw new AppError(
          'navigation_failed',
          'ChatGPT did not finish navigating to the requested project surface.',
        );
      }
      const observation = await waitForProjectObservation(page, signal, deadlineAt);
      this.observeState(observation.session);
      if (observation.missing === 'project_not_found') {
        throw new AppError(
          'project_not_found',
          'ChatGPT reported the requested project as missing.',
        );
      }
      if (observation.session !== 'ready') throw errorForState(observation.session);
      return await action(page);
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof AppError) throw error;
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : 'unknown', requestId },
        'browser project request failed',
      );
      throw asSafeAppError(error);
    } finally {
      await this.closePage(page, 'project', requestId);
    }
  }
}
