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

  enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('cancelled', 'Queue is shutting down.'));
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
