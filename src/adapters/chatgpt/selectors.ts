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
  fileInput: ['input[type="file"]'],
  attachmentReady: [
    '[data-testid*="file"]',
    'button[aria-label*="Remove file"]',
    'button[aria-label*="Xóa tệp"]',
    '[class*="file-preview"]',
  ],
  generatedImage: [
    'main img[alt^="Generated image"]',
    'main img[alt^="Ảnh đã tạo"]',
    'main [class*="imagegen-image"] img[alt]:not([alt=""])',
    '[data-message-author-role="assistant"] img:not([alt="ChatGPT"])',
    'article[data-testid^="conversation-turn-"] img[src]',
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
  /**
   * Markers ChatGPT puts on a turn that is still working. The copy action already exists at
   * that point, so it cannot be used on its own to decide that an answer is final: while
   * these are present the visible text is a status line ("Analyzing image") or empty.
   */
  pendingAnswer: [
    '[class*="loading-shimmer"]',
    '[class*="result-thinking"]',
    '[class*="aria-busy"]',
    '[aria-busy="true"]',
  ],
  newProjectButton: [
    'button[aria-label="Dự án mới"]',
    'button[aria-label*="New project" i]',
    'button[data-testid*="new-project"]',
  ],
  projectNameInput: [
    '[role="dialog"] input[type="text"]',
    '[role="dialog"] input:not([type="hidden"])',
    '[role="dialog"] textarea',
  ],
  projectCreateConfirm: [
    '[role="dialog"] button[type="submit"]',
    '[role="dialog"] button:has-text("Tạo dự án")',
    '[role="dialog"] button:has-text("Create project")',
    '[role="dialog"] button:has-text("Tạo")',
    '[role="dialog"] button:has-text("Create")',
  ],
  projectLink: ['a[href*="/g/g-p-"]'],
  projectOptionsButton: [
    'button[aria-label*="tùy chọn" i]',
    'button[aria-label*="options" i]',
    'button[aria-label*="More" i]',
  ],
  projectDeleteMenuItem: [
    '[role="menuitem"]:has-text("Xóa")',
    '[role="menuitem"]:has-text("Xoá")',
    '[role="menuitem"]:has-text("Delete")',
  ],
  projectDeleteConfirm: [
    '[role="dialog"] button:has-text("Xóa")',
    '[role="dialog"] button:has-text("Xoá")',
    '[role="dialog"] button:has-text("Delete")',
  ],
} as const;

export const DOM_MARKERS = {
  composer: ['#prompt-textarea', '[contenteditable="true"]', 'textarea'],
  assistant: ['[data-message-author-role="assistant"]', 'main article .markdown'],
  login: ['[data-testid="login-button"]', 'a[href*="/auth/login"]'],
  challenge: ['iframe[src*="challenges.cloudflare.com"]', '[id*="challenge"]'],
  rateLimit: ['[data-testid="rate-limit-error"]'],
  generatedImage: [
    'main img[alt^="Generated image"]',
    'main img[alt^="Ảnh đã tạo"]',
    'main [class*="imagegen-image"] img[alt]:not([alt=""])',
  ],
} as const;
