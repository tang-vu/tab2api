export type SessionState =
  | 'ready'
  | 'login_required'
  | 'security_challenge'
  | 'generation_in_progress'
  | 'rate_limited'
  | 'ui_changed'
  | 'browser_disconnected';

export interface GenerateRequest {
  prompt: string;
  signal: AbortSignal;
  requestId: string;
  attachments?: readonly MediaAttachment[];
}

export interface MediaAttachment {
  data: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | AudioMimeType;
  filename: string;
}

export type AudioMimeType =
  | 'audio/aac'
  | 'audio/flac'
  | 'audio/m4a'
  | 'audio/mp3'
  | 'audio/mp4'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/wave'
  | 'audio/webm'
  | 'audio/x-m4a'
  | 'audio/x-wav';

export interface GenerateResult {
  text: string;
  providerModel: 'chatgpt-web';
}

export interface GenerateImageRequest {
  prompt: string;
  signal: AbortSignal;
  requestId: string;
}

export interface GenerateImageResult {
  data: Buffer;
  mimeType: 'image/png';
}

export interface WebChatProvider {
  readonly id: 'chatgpt-web';
  generate(request: GenerateRequest): Promise<GenerateResult>;
  generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>;
  health(): Promise<SessionState>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
