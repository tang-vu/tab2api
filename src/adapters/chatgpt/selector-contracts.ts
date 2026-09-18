import type { ErrorCode } from '../../errors.js';
import type { SessionState } from '../../provider.js';

/**
 * Selector contracts: the single registry of every volatile ChatGPT UI assumption.
 *
 * Each contract is data-only so it can be serialized into `page.evaluate` for the live
 * observer and into linkedom fixtures for the offline compatibility suite. Candidates are
 * ordered most-specific first. `css` entries are standard selectors that work identically
 * in `document.querySelectorAll`, Playwright locators, and linkedom; `playwright` entries
 * use Playwright-only engines (`:has-text`, `text=`) and exist solely for live interaction
 * paths where a text-matched click target is safer than a positional one.
 */

export type ContractCardinality = 'zeroOrOne' | 'zeroOrMany' | 'exactlyOne';

export interface SelectorContract {
  /** Stable semantic name; appears in fingerprints, diagnostics, and failures. */
  readonly name: string;
  /** Standard-CSS candidates, most specific first. */
  readonly css: readonly string[];
  /** Playwright-engine-only candidates for live interactions. */
  readonly playwright: readonly string[];
  /**
   * Extra elements collected for text matching: every element matching a `textScope`
   * selector is tested against `textPatterns` (visible text or aria-label, lowercase
   * substring match; `/regex/` literals are also accepted).
   */
  readonly textScope?: readonly string[];
  readonly textPatterns?: readonly string[];
  /**
   * Patterns matched against whole-page visible text for state surfaces (challenge,
   * rate-limit, not-found). Lowercase substrings or `/regex/` literals.
   */
  readonly pagePatterns?: readonly string[];
  /** Expected match shape; recorded in the compatibility fingerprint. */
  readonly cardinality: ContractCardinality;
  /** Typed failure raised when a required interaction contract cannot be satisfied. */
  readonly failure?: ErrorCode;
  /** Session state a positive match evidences (state contracts only). */
  readonly state?: SessionState;
}

function contract(definition: SelectorContract): SelectorContract {
  return definition;
}

/**
 * Text patterns are lowercase substrings by default; a `/source/` literal is compiled as
 * a RegExp so bounded expressions such as `reached.*limit` stay possible.
 */
export const SELECTOR_CONTRACTS = {
  composer: contract({
    name: 'composer',
    css: [
      '#prompt-textarea',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"][data-virtualkeyboard="true"]',
      'main [contenteditable="true"]',
    ],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'composer_unavailable',
  }),
  sendControl: contract({
    name: 'sendControl',
    css: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
    ],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  stopControl: contract({
    name: 'stopControl',
    css: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
    ],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  completionAction: contract({
    name: 'completionAction',
    css: [
      'button[data-testid="copy-turn-action-button"]',
      'button[aria-label*="Copy message"]',
      'button[aria-label*="Sao chép tin nhắn"]',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  fileInput: contract({
    name: 'fileInput',
    css: ['input[type="file"]'],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'attachment_failed',
  }),
  attachmentReady: contract({
    name: 'attachmentReady',
    css: [
      '[data-testid*="file"]',
      'button[aria-label*="Remove file"]',
      'button[aria-label*="Xóa tệp"]',
      '[class*="file-preview"]',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'attachment_failed',
  }),
  /**
   * Assistant-scoped candidates for a generated image. They stay correct even when the same
   * conversation also carries images the request uploaded.
   */
  generatedImage: contract({
    name: 'generatedImage',
    css: [
      '[data-message-author-role="assistant"] img[alt^="Generated image"]',
      '[data-message-author-role="assistant"] img[alt^="Ảnh đã tạo"]',
      '[data-message-author-role="assistant"] [class*="imagegen-image"] img[alt]:not([alt=""])',
      '[data-message-author-role="assistant"] img:not([alt="ChatGPT"])',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
  }),
  /**
   * Author-agnostic last resort. It matches the user's own turn as well, so it is only
   * consulted for a request that uploaded no reference images.
   */
  generatedImageFallback: contract({
    name: 'generatedImageFallback',
    css: ['article[data-testid^="conversation-turn-"] img[src]'],
    playwright: [],
    cardinality: 'zeroOrMany',
  }),
  assistantMessage: contract({
    name: 'assistantMessage',
    css: [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
      'main article .markdown',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  login: contract({
    name: 'login',
    css: ['button[data-testid="login-button"]', 'a[href*="/auth/login"]'],
    playwright: ['button:has-text("Log in")', 'button:has-text("Đăng nhập")'],
    textScope: ['main button', 'main a'],
    textPatterns: ['log in', 'đăng nhập'],
    cardinality: 'zeroOrMany',
    state: 'login_required',
  }),
  challenge: contract({
    name: 'challenge',
    css: ['iframe[src*="challenges.cloudflare.com"]', '[id*="challenge-running"]'],
    playwright: ['text=/verify you are human|security check|checking your browser/i'],
    pagePatterns: ['verify you are human', 'security check', 'checking your browser'],
    cardinality: 'zeroOrMany',
    state: 'security_challenge',
  }),
  rateLimit: contract({
    name: 'rateLimit',
    css: ['[data-testid="rate-limit-error"]'],
    playwright: ['text=/too many requests|rate limit|try again later|reached.*limit/i'],
    pagePatterns: ['too many requests', 'rate limit', 'try again later', '/reached.*limit/i'],
    cardinality: 'zeroOrMany',
    state: 'rate_limited',
  }),
  /**
   * Markers ChatGPT puts on a turn that is still working. The copy action already exists at
   * that point, so it cannot be used on its own to decide that an answer is final: while
   * these are present the visible text is a status line ("Analyzing image") or empty.
   */
  pendingAnswer: contract({
    name: 'pendingAnswer',
    css: [
      '[class*="loading-shimmer"]',
      '[class*="result-thinking"]',
      '[class*="aria-busy"]',
      '[aria-busy="true"]',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
  }),
  /**
   * ChatGPT's logical turn identity. Unlike the `conversation-turn-N` display index, which
   * can shift while virtualized history remounts, this attribute survives re-rendering, so
   * submission and completion are bound to it rather than to a message count.
   */
  turnId: contract({
    name: 'turnId',
    css: ['[data-turn-id]'],
    playwright: [],
    cardinality: 'zeroOrMany',
  }),
  /**
   * Evidence that a Temporary Chat is active. The URL query alone is not relied on because
   * the SPA can drop it after the first render; at least one visible marker must also exist.
   */
  temporaryChat: contract({
    name: 'temporaryChat',
    css: ['[data-testid*="temporary" i]', '[aria-label*="emporary" i]'],
    playwright: [
      'main :text-matches("temporary chat", "i")',
      'main :text-matches("trò chuyện tạm", "i")',
    ],
    textScope: ['main *'],
    textPatterns: ['temporary chat', 'trò chuyện tạm'],
    cardinality: 'zeroOrMany',
  }),
  /**
   * The composer's effort/reasoning control. The exact control varies by plan tier and UI
   * revision; absent controls fail explicitly rather than silently keeping the default.
   */
  effortButton: contract({
    name: 'effortButton',
    css: [
      'button[data-testid*="effort" i]',
      'button[aria-label*="effort" i]',
      'button[aria-label*="reasoning" i]',
      'button[data-testid*="reasoning" i]',
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[id*="composer"][aria-haspopup="menu"]',
    ],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'unsupported_capability',
  }),
  /** Menu surfaces the effort control opens. Options are matched by their visible label. */
  effortOption: contract({
    name: 'effortOption',
    css: ['[role="menuitemradio"]', '[role="option"]', '[role="menuitem"]'],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  // The projects surface renders a grid, not links: no element carries the `g-p-` id, so a
  // row's identity is only observable by opening it. These selectors are taken from the
  // live UI rather than guessed.
  newProjectButton: contract({
    name: 'newProjectButton',
    css: ['button[aria-label="Dự án mới"]', 'button[aria-label*="New project" i]'],
    playwright: [
      'main button:visible:has-text("Tạo")',
      'main button:visible:has-text("Create")',
    ],
    textScope: ['main button'],
    textPatterns: ['tạo', 'create'],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  projectNameInput: contract({
    name: 'projectNameInput',
    css: ['input#project-name', 'input[name="projectName"]'],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  projectCreateConfirm: contract({
    name: 'projectCreateConfirm',
    css: ['button[type="submit"]'],
    playwright: [
      'button[type="submit"]:has-text("Tạo dự án")',
      'button[type="submit"]:has-text("Create project")',
      'button[type="submit"]:visible',
    ],
    textScope: ['button[type="submit"]'],
    textPatterns: ['tạo dự án', 'create project'],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  projectRow: contract({
    name: 'projectRow',
    css: ['[role="row"][data-page-table-selectable-row]', '[role="grid"] [role="row"]'],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  projectTitle: contract({
    name: 'projectTitle',
    css: [
      'button[aria-label^="Chỉnh sửa tiêu đề của"]',
      'button[aria-label^="Edit title of"]',
      'button[aria-label*="tiêu đề" i]',
      'button[aria-label*="title" i]',
    ],
    playwright: [],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  projectOptionsButton: contract({
    name: 'projectOptionsButton',
    css: [
      'button[aria-label^="Mở các tùy chọn dự án cho"]',
      'button[aria-label^="Open project options for"]',
      'button[aria-label*="tùy chọn dự án" i]',
      'button[aria-label*="project options" i]',
    ],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  projectDeleteMenuItem: contract({
    name: 'projectDeleteMenuItem',
    css: ['[role="menuitem"]'],
    playwright: [
      '[role="menuitem"]:has-text("Xóa dự án")',
      '[role="menuitem"]:has-text("Xoá dự án")',
      '[role="menuitem"]:has-text("Delete project")',
    ],
    textScope: ['[role="menuitem"]'],
    textPatterns: ['xóa dự án', 'xoá dự án', 'delete project'],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  projectDeleteConfirm: contract({
    name: 'projectDeleteConfirm',
    css: ['[role="dialog"] button', 'button[data-testid*="confirm"]'],
    playwright: [
      '[role="dialog"] button:has-text("Xóa")',
      '[role="dialog"] button:has-text("Xoá")',
      '[role="dialog"] button:has-text("Delete")',
    ],
    textScope: ['[role="dialog"] button'],
    textPatterns: ['xóa', 'xoá', 'delete'],
    cardinality: 'zeroOrOne',
    failure: 'ui_changed',
  }),
  // On the sources tab two unrestricted file inputs exist: the composer's attachment input
  // and the project's own sources input. They are told apart by ancestry, not by selector,
  // because only the composer one sits inside the composer wrapper below.
  projectFileInput: contract({
    name: 'projectFileInput',
    css: ['input[type="file"][multiple]:not([accept])', 'input[type="file"][multiple]'],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  composerWrapper: contract({
    name: 'composerWrapper',
    css: ['[class*="group/composer"]'],
    playwright: [],
    cardinality: 'zeroOrMany',
  }),
  projectSourceEntry: contract({
    name: 'projectSourceEntry',
    css: ['[data-testid*="source"]', 'main'],
    playwright: [],
    cardinality: 'zeroOrMany',
    failure: 'ui_changed',
  }),
  /**
   * Generic "missing surface" text. It is only trusted as a not-found signal when the URL
   * names a conversation or project and the page renders no turns at all, which keeps an
   * answer that merely contains the words from being misread as a missing surface.
   */
  notFound: contract({
    name: 'notFound',
    css: [],
    playwright: [],
    pagePatterns: [
      'unable to load',
      "couldn't find",
      'could not find',
      'not found',
      "doesn't exist",
      'does not exist',
      'may have been deleted',
      'không tìm thấy',
    ],
    cardinality: 'zeroOrMany',
  }),
} as const;

export type ContractName = keyof typeof SELECTOR_CONTRACTS;

/** Every locator candidate for live Playwright interaction, preferred order first. */
export function contractCandidates(name: ContractName): readonly string[] {
  const definition = SELECTOR_CONTRACTS[name];
  return [...definition.css, ...definition.playwright];
}

/** Standard-CSS-only candidates, for `page.evaluate` and fixture matching. */
export function contractCss(name: ContractName): readonly string[] {
  return SELECTOR_CONTRACTS[name].css;
}

/** Serialisable view of the registry handed to the in-page observer. */
export type SerializedContracts = Record<
  string,
  {
    css: readonly string[];
    textScope?: readonly string[];
    textPatterns?: readonly string[];
    pagePatterns?: readonly string[];
  }
>;

export function serializeContracts(): SerializedContracts {
  const serialized: SerializedContracts = {};
  for (const [name, definition] of Object.entries(SELECTOR_CONTRACTS)) {
    serialized[name] = {
      css: definition.css,
      ...(definition.textScope === undefined ? {} : { textScope: definition.textScope }),
      ...(definition.textPatterns === undefined
        ? {}
        : { textPatterns: definition.textPatterns }),
      ...(definition.pagePatterns === undefined
        ? {}
        : { pagePatterns: definition.pagePatterns }),
    };
  }
  return serialized;
}
