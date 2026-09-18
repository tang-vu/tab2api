/**
 * Request-deadline helpers for browser operations. The HTTP layer bounds every request
 * with one deadline; individual page operations (navigation, uploads, locator waits) must
 * never budget past it, or a cancelled request would keep driving the browser after its
 * caller is gone.
 */

/**
 * The timeout for a single browser operation: the operation's own budget capped by the
 * request's remaining deadline, floored at 1 ms so a nearly-expired deadline still yields
 * a deterministic, immediately-failing call rather than a negative timeout.
 */
export function operationTimeout(deadlineAt: number | undefined, budgetMs: number): number {
  if (deadlineAt === undefined) return budgetMs;
  return Math.max(1, Math.min(budgetMs, deadlineAt - Date.now()));
}

/**
 * How many poll attempts fit inside the remaining deadline. Each attempt costs roughly
 * `pollMs`; the result is capped by `attempts` and never below zero.
 */
export function boundedAttempts(
  deadlineAt: number | undefined,
  attempts: number,
  pollMs: number,
): number {
  if (deadlineAt === undefined) return attempts;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return 0;
  return Math.min(attempts, Math.ceil(remaining / pollMs));
}
