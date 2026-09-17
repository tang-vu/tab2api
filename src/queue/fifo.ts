import { AppError, abortError } from '../errors.js';

interface Pending<T> {
  run: () => Promise<T>;
  signal?: AbortSignal;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

export class FifoQueue {
  private readonly pending: Pending<unknown>[] = [];
  private active = 0;
  private closed = false;
  private draining = false;

  constructor(
    readonly concurrency = 1,
    readonly capacity = 16,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error('concurrency must be positive');
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be positive');
  }

  get size(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Stops accepting new work while letting queued and active items finish. Callers poll the
   * counters until both reach zero before a lifecycle step such as a browser reset or a
   * supervised restart, instead of cutting a request off mid-turn.
   */
  beginDrain(): void {
    this.draining = true;
  }

  endDrain(): void {
    this.draining = false;
  }

  /**
   * Resolves once nothing is queued or running — the point where a browser reset or restart
   * is safe. A lifecycle caller bounds the wait with `timeoutMs`; on expiry the error is a
   * typed `timeout`, and the caller decides whether to keep the drain open or resume intake.
   */
  async waitForIdle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length > 0 || this.active > 0) {
      if (signal?.aborted) throw abortError(signal);
      if (Date.now() >= deadline) {
        throw new AppError(
          'timeout',
          'Draining the queue did not finish before the timeout; the service resumed intake.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('cancelled', 'Queue is shutting down.'));
    if (this.draining)
      return Promise.reject(
        new AppError(
          'draining',
          'The service is draining for a lifecycle operation and is not accepting work.',
        ),
      );
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.pending.length + this.active >= this.capacity) {
      return Promise.reject(new AppError('queue_full', 'The local request queue is full.'));
    }
    return new Promise<T>((resolve, reject) => {
      const item: Pending<T> = { run, resolve, reject };
      if (signal !== undefined) {
        item.signal = signal;
        item.onAbort = () => {
          const index = this.pending.indexOf(item as Pending<unknown>);
          if (index >= 0) {
            this.pending.splice(index, 1);
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      this.pending.push(item as Pending<unknown>);
      this.drain();
    });
  }

  close(): void {
    this.closed = true;
    for (const item of this.pending.splice(0)) {
      item.reject(new AppError('cancelled', 'Queue is shutting down.'));
    }
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const item = this.pending.shift();
      if (item === undefined) return;
      if (item.onAbort !== undefined && item.signal !== undefined) {
        item.signal.removeEventListener('abort', item.onAbort);
      }
      if (item.signal?.aborted) {
        item.reject(abortError(item.signal));
        continue;
      }
      this.active += 1;
      void item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
