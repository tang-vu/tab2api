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
  /** Ask inside this ChatGPT project so its files and instructions apply. */
  projectId?: string;
  /** Continue this existing conversation instead of starting a new one. */
  conversationId?: string;
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
}

export interface ListProjectsRequest {
  signal: AbortSignal;
  requestId: string;
}

export interface DeleteProjectRequest {
  projectId: string;
  signal: AbortSignal;
  requestId: string;
}

export interface UploadProjectFilesRequest {
  projectId: string;
  attachments: readonly MediaAttachment[];
  signal: AbortSignal;
  requestId: string;
}

export interface UploadProjectFilesResult {
  projectId: string;
  uploaded: number;
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
  reset(): Promise<void>;
  close(): Promise<void>;
}
