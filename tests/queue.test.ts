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
});
