import type { Page } from 'playwright';
import { AppError } from '../../errors.js';
import type { GenerateRequest, GenerateResult } from '../../provider.js';
import { CompletionStateMachine } from './completion-state.js';
import { isTurnIdSafe, selectNewTurnId } from './dom.js';
import { conversationIdFromUrl } from './identifiers.js';
import { observe } from './session.js';
import type { DomObservation } from './observe-dom.js';
import {
  assertGeneratingObservation,
  assertReadyObservation,
  errorForState,
  waitForInitialObservation,
} from './session.js';
import {
  attachFiles,
  assertTemporaryChat,
  resolveComposer,
  selectEffort,
  submitPrompt,
} from './composer.js';
import { abortRace, turnAbortError, type TurnLifecycle } from './turn-lifecycle.js';
import { operationTimeout } from '../../browser/deadline.js';

/**
 * One text turn through the ChatGPT composer, driven by the turn lifecycle machine and the
 * shared DOM observer. The post-submit boundary is a one-way door: once the send gesture
 * has run, no code path may resubmit, and failures are classified `submission_uncertain`,
 * `generation_interrupted`, or `generation_timeout` rather than a generic disconnect.
 */

const POLL_MS = 300;
/**
 * A bound turn id that vanishes is usually a virtualized-history remount; a bounded grace
 * is allowed before the disappearance is treated as an interrupted generation.
 */
const MISSING_BOUND_TURN_POLLS = 20;
/**
 * When turn ids exist in the DOM but the new turn never binds, a bounded number of polls
 * later the legacy count-based path takes over rather than waiting out the full timeout.
 */
const UNBOUND_POLL_GRACE = 40;

/**
 * Poll loop for completion. Each iteration is one `observePage` evaluate returning an
 * atomic snapshot — session state, turn binding, assistant text, pending markers, stop
 * control — so evidence can never mix two different renders mid-poll.
 */
export interface TurnHooks {
  /** Called with each live observation; used to refresh diagnostics. */
  onObservation?: (observation: DomObservation, url: string) => void;
}

async function waitForCompletion(
  page: Page,
  baseline: number,
  baselineCompletionActions: number,
  baselineTurnIds: ReadonlySet<string>,
  lifecycle: TurnLifecycle,
  signal: AbortSignal,
  hooks: TurnHooks | undefined,
): Promise<string> {
  const machine = new CompletionStateMachine(baseline);
  let boundTurnId: string | undefined;
  let turnIdsObserved = false;
  let unboundPolls = 0;
  let missingBoundTurnPolls = 0;
  while (true) {
    if (signal.aborted) throw turnAbortError(signal, lifecycle.postSubmit);
    const observation: DomObservation = await observe(page, {
      ...(boundTurnId === undefined ? {} : { boundTurnId }),
      duringGeneration: true,
    });
    hooks?.onObservation?.(observation, page.url());
    assertGeneratingObservation(observation);
    if (observation.session === 'browser_disconnected') {
      throw errorForState('browser_disconnected');
    }

    if (observation.turnIds.length > 0) turnIdsObserved = true;
    if (turnIdsObserved && boundTurnId === undefined) {
      const binding = selectNewTurnId(baselineTurnIds, observation.turnIds);
      if (binding.kind === 'bound' && isTurnIdSafe(binding.id)) boundTurnId = binding.id;
    }

    let assistantCount = observation.assistant.count;
    let text = observation.assistant.text;
    let pending = observation.assistant.pending;
    let completionActionAvailable =
      observation.completionActionCount > baselineCompletionActions;
    const generating = observation.stopVisible;

    if (turnIdsObserved) {
      if (boundTurnId !== undefined && observation.boundTurn !== undefined) {
        const bound = observation.boundTurn;
        if (bound.elements === 1) {
          missingBoundTurnPolls = 0;
          assistantCount = baseline + 1;
          text = bound.text;
          pending = bound.pending;
          completionActionAvailable = bound.completionActions > 0;
        } else if (bound.elements === 0) {
          missingBoundTurnPolls += 1;
          if (missingBoundTurnPolls > MISSING_BOUND_TURN_POLLS) {
            throw new AppError(
              'generation_interrupted',
              'The submitted turn disappeared from the page before its answer completed.',
              'Check the conversation in ChatGPT; generation may have been interrupted.',
            );
          }
          assistantCount = baseline;
          text = '';
          pending = false;
          completionActionAvailable = false;
        } else {
          // The turn id renders on more than one element: unbind rather than read a guess.
          boundTurnId = undefined;
        }
      } else if (boundTurnId === undefined) {
        unboundPolls += 1;
        if (unboundPolls <= UNBOUND_POLL_GRACE || observation.assistant.count <= baseline) {
          assistantCount = baseline;
          text = '';
          pending = false;
          completionActionAvailable = false;
        }
      }
    }

    if (
      machine.observe({
        assistantCount,
        text,
        generating,
        completionActionAvailable,
        pending,
      }) === 'complete'
    ) {
      return text;
    }
    if (
      lifecycle.current === 'submitted' &&
      (generating || pending || assistantCount > baseline)
    ) {
      lifecycle.transition('generating');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(turnAbortError(signal, lifecycle.postSubmit));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, POLL_MS);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function runTextTurn(
  page: Page,
  request: GenerateRequest,
  target: string,
  lifecycle: TurnLifecycle,
  hooks?: TurnHooks,
): Promise<GenerateResult> {
  lifecycle.transition('navigating');
  try {
    await abortRace(
      page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: operationTimeout(request.deadlineAt, 30_000),
      }),
      request.signal,
      false,
    );
  } catch {
    if (request.signal.aborted) throw turnAbortError(request.signal, false);
    throw new AppError(
      'navigation_failed',
      'ChatGPT did not finish navigating to the requested surface.',
      'Run `npm run doctor`; the prompt was not submitted.',
    );
  }
  lifecycle.transition('observing');
  const initial = await waitForInitialObservation(page, {
    signal: request.signal,
    deadlineAt: request.deadlineAt,
  });
  hooks?.onObservation?.(initial, page.url());
  if (request.signal.aborted) throw turnAbortError(request.signal, false);
  assertReadyObservation(initial);

  lifecycle.transition('preparing');
  const composer = await resolveComposer(page);
  if (request.temporary === true) {
    await assertTemporaryChat(page, request.signal, request.deadlineAt);
  }
  if (request.effort !== undefined) await selectEffort(page, request.effort, request.signal);
  const baselineObservation = await observe(page);
  const baseline = baselineObservation.assistant.count;
  const baselineCompletionActions = baselineObservation.completionActionCount;
  const baselineTurnIds = new Set(baselineObservation.turnIds);
  await attachFiles(page, request.attachments, request.signal, request.deadlineAt);

  lifecycle.transition('submitting');
  await submitPrompt(page, composer, request.prompt, request.signal);
  lifecycle.transition('submitted');

  const text = await waitForCompletion(
    page,
    baseline,
    baselineCompletionActions,
    baselineTurnIds,
    lifecycle,
    request.signal,
    hooks,
  );
  lifecycle.transition('completing');
  lifecycle.transition('done');
  // A new conversation only gets its URL once the turn is under way, so read it here.
  const conversationId = conversationIdFromUrl(page.url());
  return {
    text,
    providerModel: 'chatgpt-web',
    ...(conversationId !== undefined && { conversationId }),
  };
}
