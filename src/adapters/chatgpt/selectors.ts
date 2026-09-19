import { SELECTOR_CONTRACTS, contractCandidates, type ContractName } from './selector-contracts.js';

/**
 * Derived locator candidates for live Playwright interaction. The semantic definitions
 * (cardinality, text patterns, failure classification) live in `selector-contracts.ts`;
 * this map only flattens each contract's `css` + `playwright` candidate lists so call
 * sites that resolve locators keep a stable shape.
 */
function candidates(name: ContractName): readonly string[] {
  return contractCandidates(name);
}

export const UI_SELECTORS = {
  composer: candidates('composer'),
  sendButton: candidates('sendControl'),
  stopButton: candidates('stopControl'),
  completionAction: candidates('completionAction'),
  fileInput: candidates('fileInput'),
  attachmentReady: candidates('attachmentReady'),
  generatedImage: candidates('generatedImage'),
  generatedImageFallback: candidates('generatedImageFallback'),
  assistantMessage: candidates('assistantMessage'),
  login: candidates('login'),
  challenge: candidates('challenge'),
  rateLimit: candidates('rateLimit'),
  pendingAnswer: candidates('pendingAnswer'),
  turnId: candidates('turnId'),
  temporaryChat: candidates('temporaryChat'),
  effortButton: candidates('effortButton'),
  effortOption: candidates('effortOption'),
  newProjectButton: candidates('newProjectButton'),
  projectNameInput: candidates('projectNameInput'),
  projectCreateConfirm: candidates('projectCreateConfirm'),
  projectRow: candidates('projectRow'),
  projectTitle: candidates('projectTitle'),
  projectOptionsButton: candidates('projectOptionsButton'),
  projectDeleteMenuItem: candidates('projectDeleteMenuItem'),
  projectDeleteConfirm: candidates('projectDeleteConfirm'),
  projectFileInput: candidates('projectFileInput'),
  composerWrapper: SELECTOR_CONTRACTS.composerWrapper.css[0],
  projectSourceEntry: candidates('projectSourceEntry'),
} as const;

/**
 * Visible labels a requested effort is matched against, most specific first. Labels are
 * English and Vietnamese candidates because ChatGPT localizes the composer; a request that
 * matches nothing fails `ui_changed` instead of guessing at a neighbouring effort.
 */
export const EFFORT_LABELS = {
  minimal: [/^instant$/i, /^light$/i, /^nhanh$/i, /instant/i, /light/i],
  low: [/^instant$/i, /^light$/i, /^standard$/i, /instant/i, /light/i, /standard/i],
  medium: [/^standard$/i, /^thinking$/i, /standard/i, /thinking/i, /suy nghĩ/i],
  high: [/^extended$/i, /^high$/i, /extended/i, /thinking harder/i, /high/i],
  xhigh: [/^pro$/i, /^max$/i, /extra high/i, /^pro\b/i, /max/i],
} as const;

/**
 * Reduced marker sets for the pure-DOM fixture helpers in `dom.ts`. These stay aligned with
 * the contracts because both are derived from `SELECTOR_CONTRACTS`; the observer in
 * `observe-dom.ts` is the authoritative matcher and exercises the same candidates.
 */
export const DOM_MARKERS = {
  composer: SELECTOR_CONTRACTS.composer.css,
  assistant: SELECTOR_CONTRACTS.assistantMessage.css,
  login: SELECTOR_CONTRACTS.login.css,
  challenge: ['iframe[src*="challenges.cloudflare.com"]', '[id*="challenge"]'],
  rateLimit: ['[data-testid="rate-limit-error"]'],
  generatedImage: [
    'main img[alt^="Generated image"]',
    'main img[alt^="Ảnh đã tạo"]',
    'main [class*="imagegen-image"] img[alt]:not([alt=""])',
  ],
} as const;
