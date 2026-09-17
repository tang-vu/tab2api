import { describe, expect, it } from 'vitest';
import { FifoQueue } from '../src/queue/fifo.js';

describe('bounded FIFO queue', () => {
  it('processes concurrent requests FIFO with concurrency one', async () => {
    const queue = new FifoQueue(1, 4);
    const events: string[] = [];
    const task = (name: string, delay: number) =>
      queue.enqueue(async () => {
        events.push(`start-${name}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        events.push(`end-${name}`);
        return name;
      });
    await Promise.all([task('a', 20), task('b', 0)]);
    expect(events).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
  });

  it('runs up to the configured concurrency while preserving FIFO admission', async () => {
    const queue = new FifoQueue(2, 4);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const task = (name: string) =>
      queue.enqueue(async () => {
        started.push(name);
        await gate;
        return name;
      });
    const jobs = [task('a'), task('b'), task('c')];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['a', 'b']);
    release();
    await Promise.all(jobs);
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('cancels a queued task without running it', async () => {
    const queue = new FifoQueue(1, 3);
    let release!: () => void;
    const blocker = queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    let ran = false;
    const cancelled = queue.enqueue(async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    release();
    await blocker;
    expect(ran).toBe(false);
  });

  it('rejects work beyond capacity', async () => {
    const queue = new FifoQueue(1, 1);
    let release!: () => void;
    const active = queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(queue.enqueue(async () => undefined)).rejects.toMatchObject({
      code: 'queue_full',
    });
    release();
    await active;
  });

  it('drains in-flight work while rejecting new intake', async () => {
    const queue = new FifoQueue(1, 4);
    const events: string[] = [];
    let release!: () => void;
    const blocker = queue.enqueue(async () => {
      events.push('start-blocker');
      await new Promise<void>((resolve) => (release = resolve));
      events.push('end-blocker');
    });
    const queued = queue.enqueue(async () => {
      events.push('start-queued');
    });
    queue.beginDrain();
    expect(queue.isDraining).toBe(true);
    await expect(queue.enqueue(async () => undefined)).rejects.toMatchObject({
      code: 'draining',
    });
    release();
    await Promise.all([blocker, queued]);
    expect(events).toEqual(['start-blocker', 'end-blocker', 'start-queued']);
  });

  it('accepts work again after the drain ends', async () => {
    const queue = new FifoQueue(1, 4);
    queue.beginDrain();
    await expect(queue.enqueue(async () => undefined)).rejects.toMatchObject({
      code: 'draining',
    });
    queue.endDrain();
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('waits for an idle queue and times out on a stuck item', async () => {
    const queue = new FifoQueue(1, 4);
    await expect(queue.waitForIdle(50)).resolves.toBeUndefined();
    let release!: () => void;
    const stuck = queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(queue.waitForIdle(30)).rejects.toMatchObject({ code: 'timeout' });
    release();
    await stuck;
    await expect(queue.waitForIdle(50)).resolves.toBeUndefined();
  });

  it('lets a queued task cancel itself during a drain', async () => {
    const queue = new FifoQueue(1, 4);
    let release!: () => void;
    const blocker = queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const cancelled = queue.enqueue(async () => 'never', controller.signal);
    queue.beginDrain();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    release();
    await blocker;
    await expect(queue.waitForIdle(50)).resolves.toBeUndefined();
  });
});
