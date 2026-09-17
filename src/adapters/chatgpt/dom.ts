import { DOM_MARKERS } from './selectors.js';
import type { SessionState } from '../../provider.js';

function matchesAny(document: Document, selectors: readonly string[]): boolean {
  return selectors.some((selector) => document.querySelector(selector) !== null);
}

export function classifyDocument(document: Document, visibleText = ''): SessionState {
  const normalized = visibleText.toLowerCase();
  if (
    matchesAny(document, DOM_MARKERS.challenge) ||
    /verify you are human|security check|checking your browser/.test(normalized)
  ) {
    return 'security_challenge';
  }
  if (
    matchesAny(document, DOM_MARKERS.rateLimit) ||
    /rate limit|too many requests/.test(normalized)
  ) {
    return 'rate_limited';
  }
  if (matchesAny(document, DOM_MARKERS.login)) return 'login_required';
  if (matchesAny(document, DOM_MARKERS.composer)) return 'ready';
  return 'ui_changed';
}

export function extractLatestAssistant(document: Document): string | undefined {
  for (const selector of DOM_MARKERS.assistant) {
    const matches = [...document.querySelectorAll(selector)];
    const last = matches.at(-1);
    const text = last?.textContent.trim();
    if (text !== undefined && text.length > 0) return text;
  }
  return undefined;
}

export function hasGeneratedImage(document: Document): boolean {
  return matchesAny(document, DOM_MARKERS.generatedImage);
}

/**
 * ChatGPT's logical turn ids in DOM order. `data-turn-id` survives virtualized-history
 * remounts, so a turn is identified by an id the baseline never saw rather than by a count
 * of rendered messages.
 */
export function collectTurnIds(document: Document): string[] {
  return [...document.querySelectorAll('[data-turn-id]')]
    .map((element) => element.getAttribute('data-turn-id') ?? '')
    .filter((id) => id.length > 0);
}

export type TurnBinding =
  { kind: 'none' } | { kind: 'bound'; id: string } | { kind: 'ambiguous'; id: string };

/**
 * The turn this submission created is the newest logical id absent from the baseline. When
 * that id renders on more than one element the DOM is ambiguous and the turn stays unbound
 * rather than answering from a guessed element.
 */
export function selectNewTurnId(
  baseline: ReadonlySet<string>,
  current: readonly string[],
): TurnBinding {
  const fresh = current.filter((id) => !baseline.has(id));
  const candidate = fresh.at(-1);
  if (candidate === undefined) return { kind: 'none' };
  if (current.filter((id) => id === candidate).length !== 1) {
    return { kind: 'ambiguous', id: candidate };
  }
  return { kind: 'bound', id: candidate };
}

/** Turn ids are interpolated into a CSS attribute selector, so unexpected characters opt out. */
export function isTurnIdSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
