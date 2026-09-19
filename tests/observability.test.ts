import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/observability/events.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

describe('EventLog', () => {
  it('records events with monotonic sequence numbers', () => {
    const log = new EventLog();
    const first = log.record('turn.phase', 'navigating', 'req-1');
    const second = log.record('turn.completed');
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.detail).toBe('navigating');
    expect(first.requestId).toBe('req-1');
    expect(second.detail).toBeUndefined();
    expect(second.requestId).toBeUndefined();
  });

  it('lists retained events oldest-first', () => {
    const log = new EventLog();
    log.record('queue.draining');
    log.record('queue.resumed');
    expect(log.list().map((event) => event.type)).toEqual(['queue.draining', 'queue.resumed']);
  });

  it('evicts the oldest events once the ring wraps', () => {
    const log = new EventLog(3);
    for (let index = 0; index < 5; index += 1) {
      log.record('turn.phase', `phase-${index}`);
    }
    const retained = log.list();
    expect(retained).toHaveLength(3);
    expect(retained.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(retained[0]?.detail).toBe('phase-2');
    expect(log.size).toBe(3);
  });

  it('returns only the newest events when limited', () => {
    const log = new EventLog();
    for (let index = 0; index < 6; index += 1) log.record('session.state', `${index}`);
    const limited = log.list(2);
    expect(limited.map((event) => event.detail)).toEqual(['4', '5']);
  });

  it('carries only content-free detail fields', () => {
    const log = new EventLog();
    const event = log.record('request.error', 'rate_limited', 'req-9');
    expect(Object.keys(event).sort()).toEqual(['at', 'detail', 'requestId', 'seq', 'type']);
  });
});

describe('MetricsRegistry', () => {
  it('counts named operations', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('turns.started');
    metrics.increment('turns.started');
    metrics.increment('turns.completed');
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['turns.started']).toBe(2);
    expect(snapshot.counters['turns.completed']).toBe(1);
    expect(snapshot.counters['turns.failed']).toBe(0);
  });

  it('counts errors per code and in aggregate', () => {
    const metrics = new MetricsRegistry();
    metrics.recordError('rate_limited');
    metrics.recordError('rate_limited');
    metrics.recordError('ui_changed');
    const snapshot = metrics.snapshot();
    expect(snapshot.errorsByCode).toEqual({ rate_limited: 2, ui_changed: 1 });
    expect(snapshot.counters['requests.errors']).toBe(3);
  });

  it('counts session-state transitions', () => {
    const metrics = new MetricsRegistry();
    metrics.recordSessionState('ready');
    metrics.recordSessionState('ready');
    metrics.recordSessionState('login_required');
    expect(metrics.snapshot().sessionStates).toEqual({
      ready: 2,
      login_required: 1,
    });
  });

  it('aggregates duration count, total, and max', () => {
    const metrics = new MetricsRegistry();
    metrics.observeDuration('generate', 100);
    metrics.observeDuration('generate', 40);
    metrics.observeDuration('generate', 260);
    expect(metrics.snapshot().durations.generate).toEqual({
      count: 3,
      totalMs: 400,
      maxMs: 260,
    });
  });

  it('clamps negative durations to zero', () => {
    const metrics = new MetricsRegistry();
    metrics.observeDuration('generateImage', -50);
    expect(metrics.snapshot().durations.generateImage).toMatchObject({ totalMs: 0 });
  });

  it('timed() records success and failure outcomes', async () => {
    const metrics = new MetricsRegistry();
    const result = await metrics.timed(
      'generate',
      'turns.started',
      'turns.completed',
      'turns.failed',
      async () => 'ok',
    );
    expect(result).toBe('ok');
    await expect(
      metrics.timed('generate', 'turns.started', 'turns.completed', 'turns.failed', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['turns.started']).toBe(2);
    expect(snapshot.counters['turns.completed']).toBe(1);
    expect(snapshot.counters['turns.failed']).toBe(1);
    expect(snapshot.durations.generate?.count).toBe(2);
  });

  it('exposes a zero-filled snapshot before anything runs', () => {
    const snapshot = new MetricsRegistry().snapshot();
    expect(snapshot.counters['turns.started']).toBe(0);
    expect(snapshot.counters['projects.operations']).toBe(0);
    expect(snapshot.durations.generateImage).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    expect(snapshot.errorsByCode).toEqual({});
    expect(snapshot.sessionStates).toEqual({});
    expect(typeof snapshot.uptimeMs).toBe('number');
  });
});
