import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

const auth = { authorization: 'Bearer test-only-token-that-is-long-enough' };
const PROJECT_ID = 'g-p-0123456789abcdef0123456789abcdef';
const CONVERSATION_ID = '0123abcd-4567-89ef-0123-456789abcdef';

function server(provider: FakeProvider) {
  return buildServer({
    config: testConfig({ requestTimeoutMs: 2_000 }),
    provider,
    logger: createLogger('silent'),
  });
}

function multipart(files: { field: string; filename: string; type: string; body: string }[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = '----tab2apitestboundary';
  const chunks = files.map(
    (file) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n${file.body}\r\n`,
  );
  return {
    payload: Buffer.from(`${chunks.join('')}--${boundary}--\r\n`),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('project routes', () => {
  it('requires a bearer key on every project route', async () => {
    const app = server(new FakeProvider());
    for (const [method, url] of [
      ['POST', '/v1/projects'],
      ['GET', '/v1/projects'],
      ['DELETE', `/v1/projects/${PROJECT_ID}`],
      ['POST', `/v1/projects/${PROJECT_ID}/chat/completions`],
      ['POST', `/v1/projects/${PROJECT_ID}/responses`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it('creates a project and lists what the browser reports', async () => {
    const provider = new FakeProvider();
    const app = server(provider);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth,
      payload: { name: 'my codebase' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'my codebase' });
    expect(provider.createdProjectNames).toEqual(['my codebase']);

    const listed = await app.inject({ method: 'GET', url: '/v1/projects', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().object).toBe('list');
    expect(listed.json().data).toHaveLength(1);
    await app.close();
  });

  it('deletes exactly the requested project id', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${PROJECT_ID}`,
      headers: { ...auth, 'x-tab2api-confirm-delete': PROJECT_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: PROJECT_ID, object: 'project', deleted: true });
    expect(provider.deletedProjectIds).toEqual([PROJECT_ID]);
    await app.close();
  });

  it('requires an exact project-id confirmation before deletion', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${PROJECT_ID}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(provider.deletedProjectIds).toEqual([]);
    await app.close();
  });

  it('trims project names and rejects whitespace-only names', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth,
      payload: { name: '  codebase  ' },
    });
    expect(created.statusCode).toBe(200);
    expect(provider.createdProjectNames).toEqual(['codebase']);

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth,
      payload: { name: '   ' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(provider.createdProjectNames).toEqual(['codebase']);
    await app.close();
  });

  it.each([
    ['../../etc/passwd', 'traversal'],
    ['g-p-NOTHEX', 'non-hex'],
    ['g-p-', 'empty suffix'],
  ])('rejects %s project ids as invalid_request (%s)', async (projectId) => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${encodeURIComponent(projectId)}`,
      headers: auth,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    // A rejected identifier must never reach the browser layer.
    expect(provider.deletedProjectIds).toEqual([]);
    await app.close();
  });

  it('routes a project chat through the provider with the project id attached', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/chat/completions`,
      headers: auth,
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.projectIds).toEqual([PROJECT_ID]);
    expect(response.json().tab2api.conversation_id).toBeTypeOf('string');
    await app.close();
  });

  it('passes conversation_id through so a thread can be continued', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/chat/completions`,
      headers: auth,
      payload: {
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'and then?' }],
        conversation_id: CONVERSATION_ID,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.conversationIds).toEqual([CONVERSATION_ID]);
    expect(response.json().tab2api.conversation_id).toBe(CONVERSATION_ID);
    await app.close();
  });

  it('rejects a malformed conversation_id before touching the browser', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: {
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'hi' }],
        conversation_id: '../../admin',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(provider.prompts).toEqual([]);
    await app.close();
  });

  it('exposes the project conversation id on the responses route metadata', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/responses`,
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'summarise the codebase' },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.projectIds).toEqual([PROJECT_ID]);
    expect(response.json().metadata.tab2api_conversation_id).toBeTypeOf('string');
    await app.close();
  });

  it('uploads multiple files and sanitises client-supplied names', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const { payload, contentType } = multipart([
      { field: 'file', filename: '../../escape.ts', type: 'text/x-typescript', body: 'export {}' },
      { field: 'file', filename: 'README.md', type: 'text/markdown', body: '# hi' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/files`,
      headers: { ...auth, 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projectId: PROJECT_ID, uploaded: 2 });
    expect(provider.uploads).toEqual([{ projectId: PROJECT_ID, count: 2 }]);
    await app.close();
  });

  it('rejects an upload with no file part', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/files`,
      headers: { ...auth, 'content-type': 'multipart/form-data; boundary=----empty' },
      payload: Buffer.from('------empty--\r\n'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    expect(provider.uploads).toEqual([]);
    await app.close();
  });
});
