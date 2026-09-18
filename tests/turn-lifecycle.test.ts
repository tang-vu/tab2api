import { describe, expect, it } from 'vitest';
import {
  TurnLifecycle,
  postSubmitError,
  turnAbortError,
  type TurnPhase,
} from '../src/adapters/chatgpt/turn-lifecycle.js';
import { AppError } from '../src/errors.js';

const HAPPY_PATH: readonly TurnPhase[] = [
  'navigating',
  'observing',
  'preparing',
  'submitting',
  'submitted',
  'generating',
  'completing',
  'done',
];

function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe('TurnLifecycle', () => {
  it('walks the ordered happy path exactly once', () => {
    const lifecycle = new TurnLifecycle();
    expect(lifecycle.current).toBe('idle');
    for (const phase of HAPPY_PATH) lifecycle.transition(phase);
    expect(lifecycle.current).toBe('done');
  });

  it('reports transitions to the observation hook', () => {
    const phases: TurnPhase[] = [];
    const lifecycle = new TurnLifecycle((transition) => phases.push(transition.phase));
    lifecycle.transition('navigating');
    lifecycle.transition('observing');
    expect(phases).toEqual(['navigating', 'observing']);
  });

  it.each([
    ['idle', 'observing'],
    ['navigating', 'submitting'],
    ['preparing', 'done'],
    ['submitted', 'submitting'],
  ] as const)('rejects %s -> %s as a defect', (from, to) => {
    const lifecycle = new TurnLifecycle();
    const path = HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(from));
    for (const phase of path) lifecycle.transition(phase);
    expect(() => lifecycle.transition(to)).toThrow(/Invalid turn transition/);
  });

  it('never re-enters submitting once the send boundary is crossed', () => {
    const lifecycle = new TurnLifecycle();
    for (const phase of HAPPY_PATH.slice(0, 5)) lifecycle.transition(phase);
    expect(() => lifecycle.transition('submitting')).toThrow(/Invalid turn transition/);
  });

  it('flips postSubmit at the send gesture and never flips back', () => {
    const lifecycle = new TurnLifecycle();
    expect(lifecycle.postSubmit).toBe(false);
    lifecycle.transition('navigating');
    lifecycle.transition('observing');
    lifecycle.transition('preparing');
    expect(lifecycle.postSubmit).toBe(false);
    lifecycle.transition('submitting');
    expect(lifecycle.postSubmit).toBe(true);
    lifecycle.transition('submitted');
    lifecycle.transition('generating');
    expect(lifecycle.postSubmit).toBe(true);
  });

  it('keeps a bounded phase history', () => {
    const lifecycle = new TurnLifecycle();
    lifecycle.transition('navigating');
    lifecycle.transition('observing');
    expect(lifecycle.history.map((entry) => entry.phase)).toEqual([
      'idle',
      'navigating',
      'observing',
    ]);
  });

  it('fail() parks the machine in failed and returns the typed error', () => {
    const lifecycle = new TurnLifecycle();
    lifecycle.transition('navigating');
    const error = lifecycle.fail('navigation_failed', 'goto threw');
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('navigation_failed');
    expect(lifecycle.current).toBe('failed');
    expect(() => lifecycle.transition('observing')).toThrow(/Invalid turn transition/);
  });

  it('fail() after done is a no-op for the phase', () => {
    const lifecycle = new TurnLifecycle();
    for (const phase of HAPPY_PATH) lifecycle.transition(phase);
    lifecycle.fail('ui_changed', 'late failure');
    expect(lifecycle.current).toBe('done');
  });
});

describe('turnAbortError', () => {
  it('maps a pre-submit cancellation to cancelled', () => {
    const error = turnAbortError(abortedSignal(), false);
    expect(error.code).toBe('cancelled');
  });

  it('maps a pre-submit request timeout to timeout', () => {
    const error = turnAbortError(abortedSignal(new AppError('timeout', 'deadline')), false);
    expect(error.code).toBe('timeout');
  });

  it('maps a post-submit request timeout to generation_timeout', () => {
    const error = turnAbortError(abortedSignal(new AppError('timeout', 'deadline')), true);
    expect(error.code).toBe('generation_timeout');
    expect(error.remediation).toContain('TAB2API_REQUEST_TIMEOUT_MS');
  });

  it('maps a post-submit client disconnect to cancelled', () => {
    const error = turnAbortError(abortedSignal(), true);
    expect(error.code).toBe('cancelled');
  });
});

describe('postSubmitError', () => {
  it('passes typed errors through unchanged', () => {
    const typed = new AppError('generation_interrupted', 'turn vanished');
    expect(postSubmitError(typed)).toBe(typed);
  });

  it('maps unknown post-submit failures to submission_uncertain', () => {
    const error = postSubmitError(new Error('CDP went away'));
    expect(error.code).toBe('submission_uncertain');
    expect(error.remediation).toContain('not automatically resubmitted');
  });
});
