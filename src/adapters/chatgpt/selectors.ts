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
  // The projects surface renders a grid, not links: no element carries the `g-p-` id, so a
  // row's identity is only observable by opening it. These selectors are taken from the
  // live UI rather than guessed.
  newProjectButton: [
    'main button:visible:has-text("Tạo")',
    'main button:visible:has-text("Create")',
    'button[aria-label="Dự án mới"]',
    'button[aria-label*="New project" i]',
  ],
  projectNameInput: ['input#project-name', 'input[name="projectName"]'],
  projectCreateConfirm: [
    'button[type="submit"]:has-text("Tạo dự án")',
    'button[type="submit"]:has-text("Create project")',
    'button[type="submit"]:visible',
  ],
  projectRow: ['[role="row"][data-page-table-selectable-row]', '[role="grid"] [role="row"]'],
  projectTitle: [
    'button[aria-label^="Chỉnh sửa tiêu đề của"]',
    'button[aria-label^="Edit title of"]',
    'button[aria-label*="tiêu đề" i]',
    'button[aria-label*="title" i]',
  ],
  projectOptionsButton: [
    'button[aria-label^="Mở các tùy chọn dự án cho"]',
    'button[aria-label^="Open project options for"]',
    'button[aria-label*="tùy chọn dự án" i]',
    'button[aria-label*="project options" i]',
  ],
  projectDeleteMenuItem: [
    '[role="menuitem"]:has-text("Xóa dự án")',
    '[role="menuitem"]:has-text("Xoá dự án")',
    '[role="menuitem"]:has-text("Delete project")',
  ],
  projectDeleteConfirm: [
    '[role="dialog"] button:has-text("Xóa")',
    '[role="dialog"] button:has-text("Xoá")',
    '[role="dialog"] button:has-text("Delete")',
    'button[data-testid*="confirm"]',
  ],
  // On the sources tab two unrestricted file inputs exist: the composer's attachment input
  // and the project's own sources input. They are told apart by ancestry, not by selector,
  // because only the composer one sits inside the composer wrapper below.
  projectFileInput: ['input[type="file"][multiple]:not([accept])', 'input[type="file"][multiple]'],
  composerWrapper: '[class*="group/composer"]',
  projectSourceEntry: ['[data-testid*="source"]', 'main'],
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
