import { AppError, abortError, type ErrorCode } from '../../errors.js';

/**
 * Explicit turn lifecycle. A text or image turn moves through exactly one ordered path:
 * navigate → observe → prepare → submit → generate → complete → done. The transition
 * table below is the whole contract; anything else is a programming error, not a UI state.
 *
 * The boundary that matters is `submitted`: once the send gesture has run, the prompt may
 * already exist on ChatGPT's side, so the machine never re-enters `submitting` and errors
 * are classified honestly (`submission_uncertain`, `generation_interrupted`,
 * `generation_timeout`) instead of collapsing into `browser_disconnected`.
 */

export type TurnPhase =
  | 'idle'
  | 'navigating'
  | 'observing'
  | 'preparing'
  | 'submitting'
  | 'submitted'
  | 'generating'
  | 'completing'
  | 'done'
  | 'failed';

const TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  idle: ['navigating', 'failed'],
  navigating: ['observing', 'failed'],
  observing: ['preparing', 'failed'],
  preparing: ['submitting', 'failed'],
  submitting: ['submitted', 'failed'],
  submitted: ['generating', 'completing', 'failed'],
  generating: ['completing', 'generating', 'failed'],
  completing: ['generating', 'done', 'failed'],
  done: [],
  failed: [],
};

const POST_SUBMIT_PHASES: ReadonlySet<TurnPhase> = new Set([
  'submitting',
  'submitted',
  'generating',
  'completing',
  'done',
]);

export interface TurnTransition {
  readonly phase: TurnPhase;
  readonly at: number;
}

/**
 * One turn's phase machine. `postSubmit` is the safety property callers rely on: it stays
 * true for the remainder of the turn once the send gesture has been attempted, even when
 * the attempt threw before producing observable evidence.
 */
export class TurnLifecycle {
  private phase: TurnPhase = 'idle';
  private readonly transitions: TurnTransition[] = [{ phase: 'idle', at: Date.now() }];

  constructor(
    private readonly onTransition?: (transition: TurnTransition) => void,
  ) {}

  get current(): TurnPhase {
    return this.phase;
  }

  /** True once the send gesture was attempted; a failure here must never resubmit. */
  get postSubmit(): boolean {
    return POST_SUBMIT_PHASES.has(this.phase);
  }

  /** Bounded transition history for diagnostics; phases only, never content. */
  get history(): readonly TurnTransition[] {
    return this.transitions;
  }

  transition(to: TurnPhase): void {
    if (!TRANSITIONS[this.phase].includes(to)) {
      throw new AppError(
        'ui_changed',
        `Invalid turn transition ${this.phase} -> ${to}.`,
        'This is a tab2api defect; report the transition sequence.',
      );
    }
    this.phase = to;
    if (this.transitions.length < 64) this.transitions.push({ phase: to, at: Date.now() });
    this.onTransition?.({ phase: to, at: Date.now() });
  }

  /** Mark the turn failed and return the typed error to throw. */
  fail(code: ErrorCode, message: string, remediation?: string): AppError {
    if (this.phase !== 'done' && this.phase !== 'failed') {
      this.phase = 'failed';
      this.onTransition?.({ phase: 'failed', at: Date.now() });
    }
    return new AppError(code, message, remediation);
  }
}

/**
 * Error mapping at the turn boundary. A caller abort before submission stays `cancelled`;
 * a request-deadline abort after submission is `generation_timeout`, and any other
 * post-submit interruption is `submission_uncertain` — the prompt may have landed, so the
 * caller must decide whether to retry rather than the runtime doing it silently.
 */
export function turnAbortError(signal: AbortSignal, postSubmit: boolean): AppError {
  const timedOut =
    signal.reason instanceof AppError && signal.reason.code === 'timeout';
  if (!postSubmit) return abortError(signal);
  if (timedOut) {
    return new AppError(
      'generation_timeout',
      'The prompt was submitted but the answer did not complete before the request timeout.',
      'Increase TAB2API_REQUEST_TIMEOUT_MS or check the conversation in ChatGPT; it may still finish.',
    );
  }
  return abortError(signal);
}

/**
 * Races a browser operation against the request signal so a cancelled or timed-out request
 * does not keep waiting out a slow `page.goto` or file upload. The underlying operation is
 * not cancelled — the page's `finally` cleanup tears it down — but the caller stops
 * waiting immediately, classified through `turnAbortError`.
 */
export function abortRace<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  postSubmit: boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal === undefined) {
      void work.then(resolve, reject);
      return;
    }
    if (signal.aborted) {
      reject(turnAbortError(signal, postSubmit));
      return;
    }
    const onAbort = () => reject(turnAbortError(signal, postSubmit));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Maps an unexpected post-submit failure to `submission_uncertain`: the send gesture ran,
 * so the prompt may exist upstream even though this process lost track of the turn.
 */
export function postSubmitError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    'submission_uncertain',
    'The prompt may have been submitted before the failure; the outcome is unknown.',
    'Check the conversation in ChatGPT before retrying. The prompt was not automatically resubmitted.',
  );
}
