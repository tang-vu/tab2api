import type { Locator, Page } from 'playwright';
import { AppError, abortError } from '../../errors.js';
import type { ErrorCode } from '../../errors.js';
import { SELECTOR_CONTRACTS, contractCandidates, type ContractName } from './selector-contracts.js';

/**
 * Live locator resolution against contract candidates. Candidates run in registry order —
 * the stable `data-testid`/aria forms first, text-engine forms last — and the first visible
 * match wins. A contract that cannot be satisfied raises its declared `failure` code.
 */

export async function firstVisible(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}

export async function countAll(page: Page, selectors: readonly string[]): Promise<number> {
  let maximum = 0;
  for (const selector of selectors)
    maximum = Math.max(maximum, await page.locator(selector).count());
  return maximum;
}

export async function countEach(page: Page, selectors: readonly string[]): Promise<number[]> {
  return Promise.all(selectors.map(async (selector) => page.locator(selector).count()));
}

/** The contract's declared failure code with a message naming the semantic contract. */
export function contractError(
  name: ContractName,
  fallback: ErrorCode,
  detail?: string,
): AppError {
  const definition = SELECTOR_CONTRACTS[name];
  const code = definition.failure ?? fallback;
  return new AppError(
    code,
    detail ?? `The ChatGPT "${name}" surface is unavailable.`,
    code === 'ui_changed'
      ? 'Run `npm run doctor` and file a selector bug with the diagnostic output.'
      : undefined,
  );
}

/**
 * Polls the contract candidates until one is visible. Required interaction targets use
 * this rather than a single probe so a slow SPA render is not mistaken for a UI change.
 */
export async function waitForContract(
  page: Page,
  name: ContractName,
  signal: AbortSignal,
  attempts = 40,
  pollMs = 250,
): Promise<Locator> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw abortError(signal);
    const locator = await firstVisible(page, contractCandidates(name));
    if (locator !== undefined) return locator;
    await page.waitForTimeout(pollMs);
  }
  throw contractError(name, 'ui_changed');
}
