import type { ErrorCode } from '../errors.js';
import type { SessionState } from '../provider.js';

/**
 * Bounded operational metrics. Counters are keyed by a fixed union of names plus the
 * closed `ErrorCode` and `SessionState` unions, so cardinality is bounded by construction —
 * metrics can never become an unbounded collection or a content channel.
 */

export interface DurationStat {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly counters: Record<string, number>;
  readonly errorsByCode: Record<string, number>;
  readonly sessionStates: Record<string, number>;
  readonly durations: Record<string, DurationStat>;
}

type CounterName =
  | 'turns.started'
  | 'turns.completed'
  | 'turns.failed'
  | 'images.started'
  | 'images.completed'
  | 'images.failed'
  | 'projects.operations'
  | 'requests.errors';

const COUNTER_NAMES: readonly CounterName[] = [
  'turns.started',
  'turns.completed',
  'turns.failed',
  'images.started',
  'images.completed',
  'images.failed',
  'projects.operations',
  'requests.errors',
];

type DurationName = 'generate' | 'generateImage' | 'projectOperation';

const DURATION_NAMES: readonly DurationName[] = [
  'generate',
  'generateImage',
  'projectOperation',
];

export class MetricsRegistry {
  private readonly startedAt = new Date();
  private readonly counters = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private readonly states = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  increment(name: CounterName, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  recordError(code: ErrorCode): void {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1);
    this.increment('requests.errors');
  }

  recordSessionState(state: SessionState): void {
    this.states.set(state, (this.states.get(state) ?? 0) + 1);
  }

  observeDuration(name: DurationName, ms: number): void {
    const stat = this.durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stat.count += 1;
    stat.totalMs += Math.max(0, Math.round(ms));
    stat.maxMs = Math.max(stat.maxMs, Math.round(ms));
    this.durations.set(name, stat);
  }

  /** Runs `fn`, recording duration and success/failure for the named operation. */
  async timed<T>(
    name: DurationName,
    started: CounterName,
    completed: CounterName,
    failed: CounterName,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.increment(started);
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.increment(completed);
      return result;
    } catch (error) {
      this.increment(failed);
      throw error;
    } finally {
      this.observeDuration(name, Date.now() - startedAt);
    }
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const name of COUNTER_NAMES) counters[name] = this.counters.get(name) ?? 0;
    const errorsByCode: Record<string, number> = {};
    for (const [code, count] of this.errors) errorsByCode[code] = count;
    const sessionStates: Record<string, number> = {};
    for (const [state, count] of this.states) sessionStates[state] = count;
    const durations: Record<string, DurationStat> = {};
    for (const name of DURATION_NAMES) {
      durations[name] = this.durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    }
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      counters,
      errorsByCode,
      sessionStates,
      durations,
    };
  }
}
