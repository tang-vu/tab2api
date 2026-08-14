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
}

export interface GenerateResult {
  text: string;
  providerModel: 'chatgpt-web';
}

export interface WebChatProvider {
  readonly id: 'chatgpt-web';
  generate(request: GenerateRequest): Promise<GenerateResult>;
  health(): Promise<SessionState>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
