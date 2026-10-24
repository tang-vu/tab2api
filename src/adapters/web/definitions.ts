/**
 * Experimental PUBLIC UI assumptions, not a verified integration contract. These selectors
 * have only synthetic offline fixtures; neither provider's authenticated UI was exercised.
 * Unknown markup must fail closed, never fall back to private APIs or guessed keystrokes.
 */
export type ExperimentalWebProviderId = 'claude-web' | 'grok-web';

export interface WebUiDefinition {
  readonly id: ExperimentalWebProviderId;
  readonly name: string;
  readonly url: string;
  readonly origin: string;
  readonly composer: string;
  readonly send: string;
  readonly assistant: string;
  readonly user: string;
  readonly busy: string;
  readonly login: string;
  readonly challenge: string;
  readonly rateLimit: string;
  readonly error: string;
  readonly status: string;
  readonly pending: string;
  readonly ended: string;
  readonly completionAction: string;
  readonly maxElements: number;
  readonly maxTextChars: number;
  readonly maxStatusChars: number;
}

const common = {
  login:
    'input[type="password"], form[action*="login"], [data-testid="login-button"], a[href="/login"], a[href="/sign-in"]',
  challenge:
    '#challenge-running, #cf-challenge-running, #challenge-form, [data-testid="challenge"], iframe[src*="challenges.cloudflare.com"]',
  rateLimit: '[data-testid="rate-limit"], [data-testid="usage-limit"]',
  error: '[role="alert"], [data-testid="error-message"], [data-testid="generation-error"]',
  status:
    '[role="alert"], [data-testid="error-message"], [data-testid="generation-error"], [data-testid="rate-limit"], [data-testid="usage-limit"], main > h1',
  pending:
    '[aria-busy="true"], [data-is-streaming="true"], [data-state="streaming"], [data-state="pending"]',
  ended: '[data-state="complete"], [data-is-streaming="false"]',
  completionAction:
    'button[aria-label="Copy"], button[aria-label="Copy response"], button[data-testid="copy-response"]',
  maxElements: 128,
  maxTextChars: 262_144,
  maxStatusChars: 4_096,
} as const;

export const WEB_UI_DEFINITIONS: Readonly<Record<ExperimentalWebProviderId, WebUiDefinition>> = {
  'claude-web': {
    ...common,
    id: 'claude-web',
    name: 'Claude',
    url: 'https://claude.ai/new',
    origin: 'https://claude.ai',
    composer:
      'div.ProseMirror[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    send: 'button[aria-label="Send message"], button[data-testid="send-button"]',
    assistant:
      '[data-testid="assistant-message"], [data-message-author-role="assistant"], .font-claude-response',
    user: '[data-testid="user-message"], [data-message-author-role="user"]',
    busy: 'button[aria-label="Stop response"], button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  },
  'grok-web': {
    ...common,
    id: 'grok-web',
    name: 'Grok',
    url: 'https://grok.com/',
    origin: 'https://grok.com',
    composer:
      'textarea[aria-label="Ask Grok anything"], textarea[placeholder="What do you want to know?"], div[role="textbox"][contenteditable="true"]',
    send: 'button[aria-label="Submit"], button[aria-label="Send message"], button[data-testid="send-button"]',
    assistant:
      '[data-testid="assistant-message"], [data-message-author-role="assistant"], [data-role="assistant"]',
    user: '[data-testid="user-message"], [data-message-author-role="user"], [data-role="user"]',
    busy: 'button[aria-label="Stop generating"], button[aria-label="Stop response"], button[data-testid="stop-button"]',
  },
};
