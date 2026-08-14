export const UI_SELECTORS = {
  composer: [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][data-virtualkeyboard="true"]',
    'main [contenteditable="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
  ],
  completionAction: [
    'button[data-testid="copy-turn-action-button"]',
    'button[aria-label*="Copy message"]',
    'button[aria-label*="Sao chép tin nhắn"]',
  ],
  assistantMessage: [
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    'main article .markdown',
  ],
  login: [
    'button[data-testid="login-button"]',
    'a[href*="/auth/login"]',
    'button:has-text("Log in")',
    'button:has-text("Đăng nhập")',
  ],
  challenge: [
    'iframe[src*="challenges.cloudflare.com"]',
    '[id*="challenge-running"]',
    'text=/verify you are human|security check|checking your browser/i',
  ],
  rateLimit: [
    'text=/too many requests|rate limit|try again later|reached.*limit/i',
    '[data-testid="rate-limit-error"]',
  ],
} as const;

export const DOM_MARKERS = {
  composer: ['#prompt-textarea', '[contenteditable="true"]', 'textarea'],
  assistant: ['[data-message-author-role="assistant"]', 'main article .markdown'],
  login: ['[data-testid="login-button"]', 'a[href*="/auth/login"]'],
  challenge: ['iframe[src*="challenges.cloudflare.com"]', '[id*="challenge"]'],
  rateLimit: ['[data-testid="rate-limit-error"]'],
} as const;
