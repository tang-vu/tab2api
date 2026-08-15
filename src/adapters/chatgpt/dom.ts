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
