import type { SessionState } from '../../provider.js';
import type { WebUiDefinition } from './definitions.js';

export interface WebTurnObservation {
  id: string;
  text: string;
  pending: boolean;
  ended: boolean;
  completionAction: boolean;
}

export interface WebSnapshot {
  state: SessionState;
  composerCount: number;
  composerEmpty: boolean;
  composerText: string;
  composerEnabled: boolean;
  sendCount: number;
  sendEnabled: boolean;
  busy: boolean;
  userCount: number;
  turns: WebTurnObservation[];
  invalid: boolean;
}

/**
 * Self-contained so Playwright can serialize it. Only public rendered DOM is inspected.
 * `document` is injectable for offline fixtures; production passes only the definition.
 * Both the serialized result and DOM traversal are bounded. No HTML, page scripts,
 * cookies, storage, requests, or framework-internal state are read.
 */
export function inspectWebDocument(input: {
  definition: WebUiDefinition;
  document?: Document;
}): WebSnapshot {
  const root = input.document ?? document;
  const definition = input.definition;
  let invalid = false;
  let remainingText = definition.maxTextChars;
  const visible = (element: Element): boolean => {
    if (element.closest('[hidden], [aria-hidden="true"]') !== null) return false;
    const style = root.defaultView?.getComputedStyle(element);
    return (
      style?.display !== 'none' &&
      style?.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    );
  };
  const elements = (selector: string, parent: ParentNode = root): Element[] => {
    const matches = parent.querySelectorAll(selector);
    if (matches.length > definition.maxElements) invalid = true;
    const result: Element[] = [];
    for (let index = 0; index < Math.min(matches.length, definition.maxElements); index += 1) {
      const element = matches.item(index);
      if (visible(element)) result.push(element);
    }
    return result;
  };
  const boundedText = (element: Element, limit: number): string => {
    const walker = root.createTreeWalker(element, 4 /* SHOW_TEXT */);
    const budget = Math.min(limit, remainingText);
    let text = '';
    let visited = 0;
    let previousBlock: Element | null = null;
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      visited += 1;
      if (visited > 4_096) {
        invalid = true;
        break;
      }
      const parent = node.parentElement;
      if (
        parent === null ||
        !visible(parent) ||
        parent.closest('button, input, textarea, select, script, style, svg') !== null
      )
        continue;
      const block = parent.closest('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr, div');
      const newline =
        text.length > 0 &&
        ((block !== null && block !== previousBlock) || node.previousSibling?.nodeName === 'BR')
          ? '\n'
          : '';
      const part = newline + (node.nodeValue ?? '');
      if (part.length > budget - text.length) {
        invalid = true;
        break;
      }
      text += part;
      previousBlock = block;
    }
    remainingText -= text.length;
    return text.trim();
  };
  const enabled = (element: Element | undefined): boolean =>
    element !== undefined &&
    !element.hasAttribute('disabled') &&
    element.getAttribute('aria-disabled') !== 'true' &&
    element.getAttribute('aria-readonly') !== 'true' &&
    !element.hasAttribute('readonly');
  const matchesVisible = (element: Element, selector: string): boolean =>
    element.matches(selector) || elements(selector, element).length > 0;

  const composers = elements(definition.composer);
  const composer = composers[0];
  const composerValue =
    composer?.tagName.toLowerCase() === 'textarea'
      ? (composer as HTMLTextAreaElement).value
      : composer === undefined
        ? ''
        : boundedText(composer, definition.maxTextChars);
  if (composerValue.length > definition.maxTextChars) invalid = true;
  if (composer?.tagName.toLowerCase() === 'textarea')
    remainingText -= Math.min(composerValue.length, definition.maxTextChars);
  const sends = elements(definition.send);
  const busy = elements(definition.busy).length > 0;
  const status = elements(definition.status)
    .map((element) => boundedText(element, definition.maxStatusChars))
    .join('\n')
    .slice(0, definition.maxStatusChars)
    .toLowerCase();
  const challenge = elements(definition.challenge).length > 0;
  const limited = elements(definition.rateLimit).length > 0;
  const login = elements(definition.login).length > 0;
  const error = elements(definition.error).length > 0;
  const turns = elements(definition.assistant).map((element) => {
    const id =
      element.getAttribute('data-message-id') ??
      element.getAttribute('data-turn-id') ??
      element.getAttribute('id') ??
      '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) invalid = true;
    return {
      id,
      text: boundedText(element, definition.maxTextChars),
      pending: matchesVisible(element, definition.pending),
      ended: matchesVisible(element, definition.ended),
      completionAction: elements(definition.completionAction, element).length > 0,
    };
  });
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) invalid = true;
  const userCount = elements(definition.user).length;
  let state: SessionState;
  if (challenge || /verify you are human|security check|checking your browser/.test(status)) {
    state = 'security_challenge';
  } else if (limited || /rate limit|too many requests|usage limit|message limit/.test(status)) {
    state = 'rate_limited';
  } else if (login) {
    state = 'login_required';
  } else if (
    invalid ||
    error ||
    /something went wrong|failed to generate|please try again/.test(status)
  ) {
    state = 'ui_changed';
  } else if (busy || turns.some((turn) => turn.pending)) {
    state = 'generation_in_progress';
  } else {
    state = composers.length === 1 && enabled(composer) ? 'ready' : 'ui_changed';
  }
  return {
    state,
    composerCount: composers.length,
    composerEmpty: composerValue.trim().length === 0,
    composerText: composerValue.slice(0, definition.maxTextChars).trim(),
    composerEnabled: enabled(composer),
    sendCount: sends.length,
    sendEnabled: sends.length === 1 && enabled(sends[0]),
    busy,
    userCount,
    turns,
    invalid,
  };
}
