import type { Page } from 'playwright';
import type { SessionState } from '../../provider.js';
import { serializeContracts } from './selector-contracts.js';

/**
 * The Web UI observer: one deterministic decoder for the ChatGPT page.
 *
 * Every helper below is a module-level pure function over a minimal DOM surface, so the
 * same code that runs inside the live page through `page.evaluate` (see `observePage`)
 * also runs verbatim against linkedom fixtures in CI. That makes semantic classification,
 * turn binding, completion evidence, and capability signals testable offline without ever
 * contacting ChatGPT.
 *
 * Serialization rule: everything these functions reference at runtime must be either a
 * parameter or another function listed in `OBSERVER_BUNDLE` — module-scope constants and
 * imports do not exist inside the evaluated bundle, so literals are inlined on purpose.
 */

/** Minimal structural DOM types — satisfied by Document, Element, and linkedom's nodes. */
export interface DomNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<DomNode>;
}

export interface DomElement extends DomNode {
  readonly tagName?: string;
  readonly hidden?: boolean;
  readonly innerText?: string;
  readonly style?: { display?: string; visibility?: string };
  matches(selector: string): boolean;
  closest(selector: string): DomElement | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  checkVisibility?(options?: { checkVisibilityCSS?: boolean }): boolean;
}

export interface DomRoot {
  readonly URL?: string;
  readonly body?: DomElement | null;
  readonly documentElement?: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

interface SerializedContractDef {
  css: readonly string[];
  textScope?: readonly string[];
  textPatterns?: readonly string[];
  pagePatterns?: readonly string[];
}

export interface ObserveDomOptions {
  /** Page URL at observation time (state and not-found detection). */
  url: string;
  /** Serialized selector contracts (see `serializeContracts`). */
  contracts: Record<string, SerializedContractDef>;
  /** Logical `data-turn-id` the submitted turn is bound to, when known. */
  boundTurnId?: string;
  /** True while observing mid-generation: unknown pages read as still working. */
  duringGeneration?: boolean;
  /** Caps page-text scanning for state patterns. */
  maxPageTextChars?: number;
}

export interface ContractObservation {
  /** Elements matching any css candidate or text pattern (bounded). */
  count: number;
  /** Matched elements that also pass the visibility heuristics. */
  visible: number;
  /** Page-text pattern matched (state contracts only). */
  textMatch: boolean;
}

export interface BoundTurnObservation {
  /** Elements carrying the bound turn id; exactly one is required for scoped reads. */
  elements: number;
  /** Visible text of the last assistant node inside the bound turn. */
  text: string;
  /** Working markers inside the bound turn or on the turn element itself. */
  pending: boolean;
  /** Completed-turn actions rendered inside the bound turn. */
  completionActions: number;
}

export interface AssistantObservation {
  /** Largest assistant-node count across the candidates (legacy fallback baseline). */
  count: number;
  /** Visible text of the last assistant node for the first matching candidate. */
  text: string;
  /** Working markers on or inside that node. */
  pending: boolean;
}

export type MissingSurface = 'conversation_not_found' | 'project_not_found';

export interface DomObservation {
  session: SessionState;
  /** A missing conversation/project surface when the URL names one and no turns render. */
  missing: MissingSurface | undefined;
  composerPresent: boolean;
  composerVisible: boolean;
  stopVisible: boolean;
  turnIds: string[];
  boundTurn: BoundTurnObservation | undefined;
  assistant: AssistantObservation;
  completionActionCount: number;
  temporaryChatEvidence: boolean;
  effortControlPresent: boolean;
  fileInputCount: number;
  generatedImageCount: number;
  generatedImageFallbackCount: number;
  projectRowCount: number;
  newProjectControl: boolean;
  /** Per-contract bounded evidence; the compatibility fingerprint is built from this. */
  contracts: Record<string, ContractObservation>;
}

function toArray<T>(list: ArrayLike<T>): T[] {
  // `Array.from` honours iterables first and falls back to length/indexed access, which
  // covers both browser NodeLists and linkedom's array-like lists.
  return Array.from(list);
}

/** querySelectorAll that tolerates engines without a given candidate's syntax. */
export function queryAll(root: DomRoot | DomElement, selector: string): DomElement[] {
  try {
    return toArray(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function matches(el: DomElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Visibility heuristics. Real Chromium answers `checkVisibility` (CSS-aware); linkedom
 * fixtures fall back to hidden/aria-hidden/inline-style checks on the element and its
 * ancestors so mutated fixtures can still express "present but invisible".
 */
export function isVisible(el: DomElement): boolean {
  if (typeof el.checkVisibility === 'function') {
    try {
      return el.checkVisibility({ checkVisibilityCSS: true });
    } catch {
      // Fall through to the structural heuristics.
    }
  }
  if (el.hidden === true) return false;
  const style = el.style;
  if (
    style !== undefined &&
    (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')
  ) {
    return false;
  }
  const concealed = el.closest(
    '[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]',
  );
  return concealed === null;
}

/**
 * Rendered-text extraction. A custom walker keeps behaviour identical between Chromium and
 * linkedom fixtures: it skips invisible subtrees, turns block boundaries and <br> into
 * newlines, collapses inline whitespace outside <pre>, and preserves whitespace verbatim
 * inside <pre> so code blocks survive.
 */
export function visibleText(root: DomNode, exclude?: ReadonlySet<DomNode>): string {
  const blockTags = new Set(
    'address article aside blockquote dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split(
      ' ',
    ),
  );
  let output = '';
  const appendBoundary = () => {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n';
  };
  const walk = (node: DomNode, inPre: boolean): void => {
    if (node.nodeType === 3) {
      output += inPre ? (node.nodeValue ?? '') : (node.nodeValue ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;
    if (exclude?.has(node) === true) return;
    const el = node as DomElement;
    if (!isVisible(el)) return;
    const tag = (el.tagName ?? '').toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'noscript' ||
      tag === 'template' ||
      tag === 'head'
    ) {
      return;
    }
    if (tag === 'br') {
      output += '\n';
      return;
    }
    const block = blockTags.has(tag);
    if (block) appendBoundary();
    const children = el.childNodes;
    for (const child of toArray(children)) {
      walk(child, inPre || tag === 'pre');
    }
    if (block) appendBoundary();
  };
  walk(root, false);
  return output
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function compilePattern(pattern: string): { test: (value: string) => boolean } {
  if (pattern.length > 2 && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash > 0) {
      try {
        const regex = new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
        return { test: (value) => regex.test(value) };
      } catch {
        // Treat an uncompilable literal as a plain substring below.
      }
    }
  }
  const needle = pattern.toLowerCase();
  return { test: (value) => value.toLowerCase().includes(needle) };
}

function elementLabel(el: DomElement): string {
  return `${visibleText(el)}\n${el.getAttribute('aria-label') ?? ''}`;
}

/** Elements matching a contract's css candidates plus its text-matched scope. */
export function matchContract(
  root: DomRoot | DomElement,
  definition: SerializedContractDef,
): DomElement[] {
  const maxMatches = 64;
  const found: DomElement[] = [];
  const seen = new Set<DomElement>();
  for (const selector of definition.css) {
    for (const el of queryAll(root, selector)) {
      if (!seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    }
    if (found.length >= maxMatches) return found;
  }
  if (definition.textScope !== undefined && definition.textPatterns !== undefined) {
    const patterns = definition.textPatterns.map(compilePattern);
    let scanned = 0;
    for (const scopeSelector of definition.textScope) {
      for (const el of queryAll(root, scopeSelector)) {
        scanned += 1;
        if (scanned > 2_000) return found;
        if (seen.has(el)) continue;
        const label = elementLabel(el);
        if (patterns.some((pattern) => pattern.test(label))) {
          seen.add(el);
          found.push(el);
          if (found.length >= maxMatches) return found;
        }
      }
    }
  }
  return found;
}

function pageRoot(root: DomRoot): DomNode {
  // `documentElement` first: linkedom parses fragments without populating `body`, while in
  // a real browser the <html> root still covers the whole document.
  return root.documentElement ?? root.body ?? (root as unknown as DomNode);
}

function pageText(root: DomRoot, maxChars: number, exclude?: ReadonlySet<DomNode>): string {
  const text = visibleText(pageRoot(root), exclude);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function anyPagePattern(definition: SerializedContractDef | undefined, text: string): boolean {
  if (definition?.pagePatterns === undefined) return false;
  return definition.pagePatterns.some((pattern) => compilePattern(pattern).test(text));
}

/** Working-marker count inside a scope or on the scope element itself. */
function pendingWithin(el: DomElement, markerSelectors: readonly string[]): number {
  let count = 0;
  for (const selector of markerSelectors) {
    count += queryAll(el, selector).length;
    if (matches(el, selector)) count += 1;
    if (count > 0) return count;
  }
  return count;
}

function lastAssistant(
  assistantEls: DomElement[],
  markerSelectors: readonly string[],
): AssistantObservation {
  const last = assistantEls.at(-1);
  if (last === undefined) return { count: 0, text: '', pending: false };
  return {
    count: assistantEls.length,
    text: visibleText(last).trim(),
    pending: pendingWithin(last, markerSelectors) > 0,
  };
}

/**
 * The observation decoder. It must stay self-contained: `observePage` serializes this
 * function together with its helpers into the page, and the compat suite calls it with a
 * linkedom document. `contracts` arrives as plain data so no module state is required.
 */
export function observeChatDom(root: DomRoot, options: ObserveDomOptions): DomObservation {
  const maxTurnIds = 256;
  const contracts = options.contracts;
  const contractResults: Record<string, ContractObservation> = {};
  const matched: Record<string, DomElement[]> = {};
  for (const [name, definition] of Object.entries(contracts)) {
    const elements = matchContract(root, definition);
    matched[name] = elements;
    contractResults[name] = {
      count: elements.length,
      visible: elements.reduce((total, el) => total + (isVisible(el) ? 1 : 0), 0),
      textMatch: false,
    };
  }
  // State page-patterns (challenge, rate-limit, not-found) must not read assistant answer
  // text: an answer merely quoting "rate limit" is content, not a session state surface.
  const stateText = pageText(
    root,
    options.maxPageTextChars ?? 20_000,
    new Set<DomNode>(matched.assistantMessage ?? []),
  );
  for (const [name, definition] of Object.entries(contracts)) {
    const result = contractResults[name];
    if (result !== undefined) result.textMatch = anyPagePattern(definition, stateText);
  }

  const challengeHit =
    (matched.challenge?.length ?? 0) > 0 || contractResults.challenge?.textMatch === true;
  const rateLimitHit =
    (matched.rateLimit?.length ?? 0) > 0 || contractResults.rateLimit?.textMatch === true;
  const loginHit = (matched.login?.length ?? 0) > 0 || options.url.includes('/auth/');
  const stopVisible = (matched.stopControl ?? []).some(isVisible);
  const composerEls = matched.composer ?? [];
  const composerVisible = composerEls.some(isVisible);

  let session: SessionState;
  if (challengeHit) session = 'security_challenge';
  else if (rateLimitHit) session = 'rate_limited';
  else if (loginHit) session = 'login_required';
  else if (stopVisible) session = 'generation_in_progress';
  else if (composerVisible) session = 'ready';
  else session = options.duringGeneration === true ? 'generation_in_progress' : 'ui_changed';

  const turnIds: string[] = [];
  for (const el of matched.turnId ?? []) {
    const id = el.getAttribute('data-turn-id') ?? '';
    if (id.length > 0 && turnIds.length < maxTurnIds) turnIds.push(id);
  }

  const assistantSelectors = contracts.assistantMessage?.css ?? [];
  const markerSelectors = contracts.pendingAnswer?.css ?? [];
  let assistant: AssistantObservation = { count: 0, text: '', pending: false };
  for (const selector of assistantSelectors) {
    const elements = queryAll(root, selector);
    if (elements.length > 0) {
      assistant = lastAssistant(elements, markerSelectors);
      break;
    }
  }
  assistant.count = Math.max(
    assistant.count,
    ...assistantSelectors.map((selector) => queryAll(root, selector).length),
  );

  let boundTurn: BoundTurnObservation | undefined;
  if (options.boundTurnId !== undefined) {
    const turnEls = queryAll(root, `[data-turn-id="${options.boundTurnId}"]`);
    const turn = turnEls.length === 1 ? turnEls[0] : undefined;
    if (turn === undefined) {
      boundTurn = { elements: turnEls.length, text: '', pending: false, completionActions: 0 };
    } else {
      let scopedAssistant: DomElement[] = [];
      for (const selector of assistantSelectors) {
        scopedAssistant = queryAll(turn, selector);
        if (scopedAssistant.length > 0) break;
      }
      const lastScoped = scopedAssistant.at(-1);
      const selfAssistant = assistantSelectors.some((selector) => matches(turn, selector));
      boundTurn = {
        elements: 1,
        text:
          lastScoped !== undefined
            ? visibleText(lastScoped).trim()
            : selfAssistant
              ? visibleText(turn).trim()
              : '',
        pending: pendingWithin(turn, markerSelectors) > 0,
        completionActions:
          contracts.completionAction === undefined
            ? 0
            : matchContract(turn, contracts.completionAction).length,
      };
    }
  }

  const notFoundHit =
    (matched.notFound?.length ?? 0) > 0 || contractResults.notFound?.textMatch === true;
  let missing: MissingSurface | undefined;
  if (notFoundHit && turnIds.length === 0 && assistant.count === 0) {
    if (options.url.includes('/c/')) missing = 'conversation_not_found';
    else if (options.url.includes('/g/g-p-')) missing = 'project_not_found';
  }

  return {
    session,
    missing,
    composerPresent: composerEls.length > 0,
    composerVisible,
    stopVisible,
    turnIds,
    boundTurn,
    assistant,
    completionActionCount: contractResults.completionAction?.count ?? 0,
    temporaryChatEvidence:
      (matched.temporaryChat?.length ?? 0) > 0 || options.url.includes('temporary-chat'),
    effortControlPresent: (matched.effortButton?.length ?? 0) > 0,
    fileInputCount: contractResults.fileInput?.count ?? 0,
    generatedImageCount: Math.max(
      0,
      ...(contracts.generatedImage?.css ?? []).map((selector) => queryAll(root, selector).length),
    ),
    generatedImageFallbackCount: Math.max(
      0,
      ...(contracts.generatedImageFallback?.css ?? []).map(
        (selector) => queryAll(root, selector).length,
      ),
    ),
    projectRowCount: contractResults.projectRow?.count ?? 0,
    newProjectControl: (matched.newProjectButton?.length ?? 0) > 0,
    contracts: contractResults,
  };
}

export interface ObservePageOptions {
  boundTurnId?: string;
  duringGeneration?: boolean;
}

const OBSERVER_BUNDLE = [
  toArray,
  queryAll,
  matches,
  isVisible,
  visibleText,
  compilePattern,
  elementLabel,
  matchContract,
  pageRoot,
  pageText,
  anyPagePattern,
  pendingWithin,
  lastAssistant,
  observeChatDom,
]
  .map((fn) => fn.toString())
  .join('\n');

/**
 * Runs the same observation the compat suite exercises against fixtures, serialized into
 * the live page. One evaluate round trip replaces a dozen locator probes per poll and
 * returns an atomic snapshot, so a mid-poll DOM remount cannot mix observations.
 */
export async function observePage(
  page: Page,
  options: ObservePageOptions = {},
): Promise<DomObservation> {
  const payload = {
    url: page.url(),
    contracts: serializeContracts(),
    ...(options.boundTurnId === undefined ? {} : { boundTurnId: options.boundTurnId }),
    ...(options.duringGeneration === undefined
      ? {}
      : { duringGeneration: options.duringGeneration }),
  };
  const source = `(() => {\n${OBSERVER_BUNDLE}\nreturn observeChatDom(document, ${JSON.stringify(payload)});\n})()`;
  return page.evaluate<DomObservation>(source);
}
