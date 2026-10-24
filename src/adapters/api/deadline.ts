import { AppError } from '../../errors.js';

/** A single deadline includes fetch headers and every body read, even for a stalled fetch. */
export class ApiDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly forwardAbort: () => void;

  constructor(
    timeoutMs: number,
    private readonly externalSignal: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.expiresAt = Date.now() + timeoutMs;
    this.forwardAbort = () => {
      this.controller.abort(
        new AppError(
          externalSignal.reason instanceof AppError && externalSignal.reason.code === 'timeout'
            ? 'timeout'
            : 'cancelled',
          'The API request was interrupted. It was not retried.',
        ),
      );
    };
    this.timer = setTimeout(
      () => this.controller.abort(new AppError('timeout', 'The API request timed out.')),
      timeoutMs,
    );
    externalSignal.addEventListener('abort', this.forwardAbort, { once: true });
    if (externalSignal.aborted) this.forwardAbort();
  }

  check(): void {
    if (!this.signal.aborted && Date.now() >= this.expiresAt) {
      this.controller.abort(new AppError('timeout', 'The API request timed out.'));
    }
    if (this.signal.aborted) throw this.error();
  }

  error(): AppError {
    const timeout = this.signal.reason instanceof AppError && this.signal.reason.code === 'timeout';
    return new AppError(
      timeout ? 'timeout' : 'cancelled',
      timeout ? 'The API request timed out.' : 'The API request was cancelled.',
      'The request may already have been processed or billed. tab2api did not retry it.',
    );
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => this.signal.removeEventListener('abort', abort);
      const abort = (): void => {
        cleanup();
        reject(this.error());
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
            try {
              this.check();
              resolve(value);
            } catch (error) {
              reject(
                error instanceof AppError
                  ? error
                  : new AppError('provider_unavailable', 'The API operation failed.'),
              );
            }
          },
          (error: unknown) => {
            cleanup();
            reject(
              error instanceof AppError
                ? error
                : new AppError('provider_unavailable', 'The API operation failed.'),
            );
          },
        );
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal.removeEventListener('abort', this.forwardAbort);
    // Also terminate transport resources after malformed/oversize/error responses.
    this.controller.abort();
  }
}
