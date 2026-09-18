import type { Page } from 'playwright';
import { AppError, abortError } from '../../errors.js';
import type { SessionState } from '../../provider.js';
import { boundedAttempts } from '../../browser/deadline.js';
import { observePage, type DomObservation, type ObservePageOptions } from './observe-dom.js';
import { firstVisible } from './locators.js';

/**
 * Session observation helpers. Classification runs inside the page through
 * `observePage`, so one poll is one evaluate round trip returning an atomic snapshot —
 * a mid-poll DOM remount cannot mix evidence from two renders.
 */

const INITIAL_STATE_ATTEMPTS = 40;
const INITIAL_STATE_POLL_MS = 250;

export function emptyObservation(session: SessionState): DomObservation {
  return {
    session,
    missing: undefined,
    composerPresent: false,
    composerVisible: false,
    stopVisible: false,
    turnIds: [],
    boundTurn: undefined,
    assistant: { count: 0, text: '', pending: false },
    completionActionCount: 0,
    temporaryChatEvidence: false,
    effortControlPresent: false,
    fileInputCount: 0,
    generatedImageCount: 0,
    generatedImageFallbackCount: 0,
    projectRowCount: 0,
    newProjectControl: false,
    contracts: {},
  };
}

/** Observe the page, or report a disconnected browser without throwing on a closed tab. */
export async function observe(
  page: Page,
  options: ObservePageOptions = {},
): Promise<DomObservation> {
  if (page.isClosed()) return emptyObservation('browser_disconnected');
  return observePage(page, options);
}

export interface InitialObservationOptions {
  /** Cancels the wait between polls; checked every attempt. */
  signal?: AbortSignal;
  /** Caps the wait at the request deadline rather than the full poll budget. */
  deadlineAt?: number | undefined;
}

/**
 * Waits for any known surface after navigation. Opening a saved conversation can involve a
 * redirect plus an SPA render, so readiness is given more room than a cold composer needs
 * before it is called a UI change — but never past the request's own deadline.
 */
export async function waitForInitialObservation(
  page: Page,
  options: InitialObservationOptions = {},
): Promise<DomObservation> {
  const attempts = boundedAttempts(options.deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    const observation = await observe(page);
    if (observation.session !== 'ui_changed') return observation;
    if (attempt < attempts - 1) await page.waitForTimeout(INITIAL_STATE_POLL_MS);
  }
  return observe(page);
}

/**
 * The projects surface has no composer, so a plain observation reads `ui_changed`.
 * "A project row or the create control is present" counts as ready instead, while login,
 * challenge, and rate-limit states still surface normally.
 */
export async function waitForProjectObservation(
  page: Page,
  signal: AbortSignal,
  deadlineAt?: number,
): Promise<DomObservation> {
  const attempts = boundedAttempts(deadlineAt, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw abortError(signal);
    const observation = await observe(page);
    if (observation.session !== 'ui_changed') return observation;
    if (observation.newProjectControl || observation.projectRowCount > 0) {
      return { ...observation, session: 'ready' };
    }
    if (attempt < attempts - 1) await page.waitForTimeout(INITIAL_STATE_POLL_MS);
  }
  return observe(page);
}

/** Maps a session state to the typed failure the client should see. */
export function errorForState(state: SessionState): AppError {
  if (state === 'login_required') {
    return new AppError(
      'login_required',
      'Manual ChatGPT login is required.',
      'Run `npm run login`.',
    );
  }
  if (state === 'security_challenge') {
    return new AppError(
      'security_challenge',
      'ChatGPT displayed a security challenge.',
      'Complete the challenge manually in the headed login browser. tab2api will not bypass it.',
    );
  }
  if (state === 'rate_limited') {
    return new AppError(
      'rate_limited',
      'ChatGPT displayed a rate-limit message.',
      'Wait and retry manually later.',
    );
  }
  if (state === 'browser_disconnected') {
    return new AppError(
      'browser_disconnected',
      'The browser disconnected.',
      'Run `npm run doctor`.',
    );
  }
  return new AppError(
    'ui_changed',
    'The current ChatGPT UI is not supported by these selectors.',
    'Run `npm run doctor` and file a selector bug with the diagnostic output.',
  );
}

/**
 * Asserts a usable surface after navigation. `ready` proceeds; explicit account states
 * raise their typed errors; a missing conversation or project surface raises the matching
 * 404; anything else is a selector/UI change.
 */
export function assertReadyObservation(observation: DomObservation): void {
  if (observation.session === 'ready' || observation.session === 'generation_in_progress') {
    if (observation.missing === 'conversation_not_found') {
      throw new AppError(
        'conversation_not_found',
        'ChatGPT reported the requested conversation as missing.',
        'Verify the conversation id, or start a new conversation.',
      );
    }
    if (observation.missing === 'project_not_found') {
      throw new AppError(
        'project_not_found',
        'ChatGPT reported the requested project as missing.',
        'Verify the project id with `GET /v1/projects`.',
      );
    }
    return;
  }
  if (observation.missing === 'conversation_not_found') {
    throw new AppError(
      'conversation_not_found',
      'ChatGPT reported the requested conversation as missing.',
      'Verify the conversation id, or start a new conversation.',
    );
  }
  if (observation.missing === 'project_not_found') {
    throw new AppError(
      'project_not_found',
      'ChatGPT reported the requested project as missing.',
      'Verify the project id with `GET /v1/projects`.',
    );
  }
  throw errorForState(observation.session);
}

/**
 * While a turn is in flight only the interrupting account surfaces are errors; transient
 * `ui_changed` reads during a remount are tolerated by the caller's poll loop.
 */
export function assertGeneratingObservation(observation: DomObservation): void {
  const state = observation.session;
  if (
    state === 'rate_limited' ||
    state === 'security_challenge' ||
    state === 'login_required'
  ) {
    throw errorForState(state);
  }
}

export { firstVisible, INITIAL_STATE_ATTEMPTS, INITIAL_STATE_POLL_MS };
