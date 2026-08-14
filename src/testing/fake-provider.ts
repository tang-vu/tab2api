import { abortError } from '../errors.js';
import type {
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  SessionState,
  WebChatProvider,
} from '../provider.js';

export class FakeProvider implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;
  state: SessionState = 'ready';
  prompts: string[] = [];
  attachmentCounts: number[] = [];
  active = 0;
  maxActive = 0;
  closed = false;

  constructor(
    private readonly responseText = 'Fake browser response',
    private readonly delayMs = 0,
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(request.prompt);
    this.attachmentCounts.push(request.attachments?.length ?? 0);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (request.signal.aborted) throw abortError(request.signal);
      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(abortError(request.signal));
            },
            { once: true },
          );
        });
      }
      return { text: this.responseText, providerModel: this.id };
    } finally {
      this.active -= 1;
    }
  }

  async generateImage(_request: GenerateImageRequest): Promise<GenerateImageResult> {
    return { data: Buffer.from('fake-png'), mimeType: 'image/png' };
  }

  async health(): Promise<SessionState> {
    return this.state;
  }

  async reset(): Promise<void> {
    this.state = 'browser_disconnected';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
