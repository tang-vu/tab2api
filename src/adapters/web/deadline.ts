import { AppError, abortError, asSafeAppError } from '../../errors.js';

/** One wall-clock budget covers browser acquisition, UI work and observation polling. */
export class WebOperationDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly forwardAbort: () => void;

  constructor(
    timeoutMs: number,
    private readonly externalSignal?: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.expiresAt = Date.now() + timeoutMs;
    this.forwardAbort = () => this.controller.abort(externalSignal?.reason);
    this.timer = setTimeout(
      () => this.controller.abort(new AppError('timeout', 'The browser request timed out.')),
      timeoutMs,
    );
    externalSignal?.addEventListener('abort', this.forwardAbort, { once: true });
    if (externalSignal?.aborted) this.forwardAbort();
  }

  check(): void {
    if (!this.signal.aborted && Date.now() >= this.expiresAt) {
      this.controller.abort(new AppError('timeout', 'The browser request timed out.'));
    }
    if (this.signal.aborted) throw abortError(this.signal);
  }

  remaining(): number {
    this.check();
    return Math.max(1, this.expiresAt - Date.now());
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => this.signal.removeEventListener('abort', abort);
      const abort = (): void => {
        cleanup();
        reject(abortError(this.signal));
      };
      this.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.check();
          return operation();
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            cleanup();
            reject(asSafeAppError(error));
          },
        );
    });
  }

  pause(ms: number): Promise<void> {
    this.check();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        cleanup();
        reject(abortError(this.signal));
      };
      const timer = setTimeout(
        () => {
          cleanup();
          resolve();
        },
        Math.min(ms, this.remaining()),
      );
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener('abort', this.forwardAbort);
  }
}
