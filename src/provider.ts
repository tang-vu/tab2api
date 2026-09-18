export type SessionState =
  | 'ready'
  | 'login_required'
  | 'security_challenge'
  | 'generation_in_progress'
  | 'rate_limited'
  | 'ui_changed'
  | 'browser_disconnected';

/**
 * Reasoning depth requested for the turn. `tab2api` maps it onto the ChatGPT composer's
 * effort control when the account exposes one; it never picks a different model.
 */
export type UiEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface GenerateRequest {
  prompt: string;
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
  attachments?: readonly MediaAttachment[];
  /** Ask inside this ChatGPT project so its files and instructions apply. */
  projectId?: string;
  /** Continue this existing conversation instead of starting a new one. */
  conversationId?: string;
  /** Run the turn in a ChatGPT Temporary Chat that is not kept in account history. */
  temporary?: boolean;
  /** Requested composer effort; absent values leave the account default untouched. */
  effort?: UiEffort;
}

export interface MediaAttachment {
  data: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | AudioMimeType | DocumentMimeType;
  filename: string;
}

/**
 * Types accepted for project file uploads. Source files carry no single registered type,
 * so the API layer normalises anything textual to `text/plain` rather than widening this
 * union to an arbitrary string.
 */
export type DocumentMimeType =
  | 'application/json'
  | 'application/pdf'
  | 'application/zip'
  | 'text/csv'
  | 'text/html'
  | 'text/markdown'
  | 'text/plain';

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
  /**
   * The conversation the answer was produced in, when the UI exposed one. Clients pass it
   * back as `conversation_id` to continue the same thread.
   */
  conversationId?: string;
}

export interface GenerateImageRequest {
  prompt: string;
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
  /** Visual references uploaded with the prompt so the generated image can follow them. */
  attachments?: readonly MediaAttachment[];
  /** Run the turn in a ChatGPT Temporary Chat that is not kept in account history. */
  temporary?: boolean;
}

export interface GenerateImageResult {
  data: Buffer;
  mimeType: 'image/png';
}

export interface ProjectSummary {
  /** The ChatGPT project identifier, always in `g-p-<hex>` form. */
  id: string;
  name: string;
}

export interface CreateProjectRequest {
  name: string;
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
}

export interface ListProjectsRequest {
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
}

export interface DeleteProjectRequest {
  projectId: string;
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
}

export interface UploadProjectFilesRequest {
  projectId: string;
  attachments: readonly MediaAttachment[];
  signal: AbortSignal;
  requestId: string;
  /** Epoch ms when the caller's request budget expires; browser operations must not
   * budget past it. Derived from the request timeout at enqueue time. */
  deadlineAt?: number;
}

export interface UploadProjectFilesResult {
  projectId: string;
  uploaded: number;
}

/**
 * Content-free provider diagnostics: the last live observation's session state, which
 * selector contracts matched, and which capabilities were observed. Carries no prompt
 * text, assistant output, titles, file names, or account data.
 */
export interface ProviderDiagnostics {
  readonly state: SessionState;
  /**
   * Per-contract match evidence from the last observation, when one has run. The shape is
   * provider-specific (see the adapter's diagnostics module); it is always a
   * JSON-serializable, content-free structure.
   */
  readonly fingerprint: unknown;
  /** Three-valued capability evidence from the last observation. */
  readonly capabilities: unknown;
  /** Semantic contract names whose declared cardinality was not satisfied. */
  readonly unsatisfiedContracts: readonly string[];
}

export interface WebChatProvider {
  readonly id: 'chatgpt-web';
  generate(request: GenerateRequest): Promise<GenerateResult>;
  generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>;
  createProject(request: CreateProjectRequest): Promise<ProjectSummary>;
  listProjects(request: ListProjectsRequest): Promise<readonly ProjectSummary[]>;
  deleteProject(request: DeleteProjectRequest): Promise<void>;
  uploadProjectFiles(request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult>;
  health(): Promise<SessionState>;
  /**
   * The most recent state observed by a live probe or turn. Cheap and never opens a
   * browser tab; before the first observation the browser has not run, so this reports
   * `browser_disconnected`. Callers needing a live probe use `health()` instead.
   */
  sessionState(): SessionState;
  /**
   * Content-free diagnostics from the last live observation. Providers that cannot inspect
   * the upstream UI may omit it; callers treat its absence as "no observation yet".
   */
  diagnostics?(): ProviderDiagnostics;
  reset(): Promise<void>;
  close(): Promise<void>;
}
