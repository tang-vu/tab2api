import { abortError } from '../errors.js';
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  ListProjectsRequest,
  ProjectSummary,
  SessionState,
  UploadProjectFilesRequest,
  UploadProjectFilesResult,
  WebChatProvider,
} from '../provider.js';

const FAKE_PROJECT_ID = 'g-p-00000000000000000000000000000001';
const FAKE_CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

export class FakeProvider implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;
  state: SessionState = 'ready';
  prompts: string[] = [];
  attachmentCounts: number[] = [];
  projectIds: (string | undefined)[] = [];
  conversationIds: (string | undefined)[] = [];
  createdProjectNames: string[] = [];
  deletedProjectIds: string[] = [];
  uploads: { projectId: string; count: number }[] = [];
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
    this.projectIds.push(request.projectId);
    this.conversationIds.push(request.conversationId);
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
      return {
        text: this.responseText,
        providerModel: this.id,
        conversationId: request.conversationId ?? FAKE_CONVERSATION_ID,
      };
    } finally {
      this.active -= 1;
    }
  }

  async generateImage(_request: GenerateImageRequest): Promise<GenerateImageResult> {
    return { data: Buffer.from('fake-png'), mimeType: 'image/png' };
  }

  async createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
    if (request.signal.aborted) throw abortError(request.signal);
    this.createdProjectNames.push(request.name);
    return { id: FAKE_PROJECT_ID, name: request.name };
  }

  async listProjects(request: ListProjectsRequest): Promise<readonly ProjectSummary[]> {
    if (request.signal.aborted) throw abortError(request.signal);
    return [{ id: FAKE_PROJECT_ID, name: 'Fake project' }];
  }

  async deleteProject(request: DeleteProjectRequest): Promise<void> {
    if (request.signal.aborted) throw abortError(request.signal);
    this.deletedProjectIds.push(request.projectId);
  }

  async uploadProjectFiles(request: UploadProjectFilesRequest): Promise<UploadProjectFilesResult> {
    if (request.signal.aborted) throw abortError(request.signal);
    this.uploads.push({ projectId: request.projectId, count: request.attachments.length });
    return { projectId: request.projectId, uploaded: request.attachments.length };
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
