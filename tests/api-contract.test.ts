import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api/server.js';
import { AppError } from '../src/errors.js';
import { createLogger } from '../src/observability/logger.js';
import type {
  GenerateImageRequest,
  GenerateImageResult,
  GenerateRequest,
  GenerateResult,
  SessionState,
  WebChatProvider,
} from '../src/provider.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';
import type { SpeechSynthesizer } from '../src/audio/system-speech.js';

const auth = { authorization: 'Bearer test-only-token-that-is-long-enough' };

class ErrorProvider implements WebChatProvider {
  readonly id = 'chatgpt-web' as const;
  constructor(private readonly error: AppError) {}
  async generate(_request: GenerateRequest): Promise<GenerateResult> {
    throw this.error;
  }
  async generateImage(_request: GenerateImageRequest): Promise<GenerateImageResult> {
    throw this.error;
  }
  async health(): Promise<SessionState> {
    return this.error.code === 'login_required' ? 'login_required' : 'ui_changed';
  }
  async reset(): Promise<void> {}
  async close(): Promise<void> {}
}

function server(provider: WebChatProvider, timeoutMs = 2_000, speech?: SpeechSynthesizer) {
  return buildServer({
    config: testConfig({ requestTimeoutMs: timeoutMs }),
    provider,
    logger: createLogger('silent'),
    ...(speech === undefined ? {} : { speech }),
  });
}

describe('Fastify API contract', () => {
  it('exposes liveness but protects model and generation routes', async () => {
    const app = server(new FakeProvider());
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('authentication_error');
    await app.close();
  });

  it('lists truthful text, image, transcription, and local speech capabilities', async () => {
    const app = server(new FakeProvider());
    const response = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    const body = z
      .object({ data: z.array(z.object({ id: z.string(), owned_by: z.string() })) })
      .parse(response.json());
    expect(body.data.map((model) => model.id)).toEqual([
      'chatgpt-web',
      'chatgpt-web-image',
      'chatgpt-web-transcribe',
      'system-tts',
    ]);
    expect(body.data.at(-1)?.owned_by).toBe('local-operating-system');
    await app.close();
  });

  it('completes Chat Completions through a fake browser adapter', async () => {
    const provider = new FakeProvider('chat answer');
    const app = server(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'ignored-client-alias', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe('chatgpt-web');
    expect(response.json().choices[0].message.content).toBe('chat answer');
    expect(provider.prompts[0]).toContain('hello');
    await app.close();
  });

  it('completes a Responses request and buffered stream', async () => {
    const app = server(new FakeProvider('response answer'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'hello' },
    });
    expect(response.json().output[0].content[0].text).toBe('response answer');
    const stream = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'hello', stream: true },
    });
    expect(stream.headers['x-tab2api-stream-mode']).toBe('buffered');
    expect(stream.body).toContain('event: response.completed');
    expect(stream.body).not.toContain('[DONE]');
    await app.close();
  });

  it('accepts vision data and maps image generation to base64 JSON', async () => {
    const provider = new FakeProvider('vision answer');
    const app = server(provider);
    const pixel =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const vision = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: {
        model: 'chatgpt-web',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: pixel } },
            ],
          },
        ],
      },
    });
    expect(vision.statusCode).toBe(200);
    expect(provider.attachmentCounts).toEqual([1]);
    const image = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: auth,
      payload: { model: 'chatgpt-web-image', prompt: 'a square' },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['x-tab2api-image-mode']).toBe('ui-element-screenshot');
    const imageBody = z
      .object({ data: z.array(z.object({ b64_json: z.string() })).min(1) })
      .parse(image.json());
    expect(Buffer.from(imageBody.data[0]?.b64_json ?? '', 'base64').toString()).toBe('fake-png');
    await app.close();
  });

  it('returns local WAV speech without claiming the ChatGPT backend', async () => {
    const speech: SpeechSynthesizer = {
      synthesize: async () => Buffer.from('RIFF-fake-wave'),
      check: async () => undefined,
    };
    const app = server(new FakeProvider(), 2_000, speech);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/audio/speech',
      headers: auth,
      payload: { model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'wav' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['x-tab2api-audio-backend']).toBe('operating-system');
    expect(response.rawPayload.toString()).toBe('RIFF-fake-wave');
    await app.close();
  });

  it('accepts one bounded multipart audio file for transcription', async () => {
    const provider = new FakeProvider('spoken words');
    const app = server(provider);
    const boundary = 'tab2api-test-boundary';
    const multipart = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFfake\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'spoken words' });
    expect(provider.attachmentCounts).toEqual([1]);
    await app.close();
  });

  it('rejects unsupported transcription media with a safe error', async () => {
    const app = server(new FakeProvider());
    const boundary = 'tab2api-invalid-media';
    const multipart = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.exe"\r\nContent-Type: application/octet-stream\r\n\r\ndata\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    await app.close();
  });

  it('serializes simultaneous API requests at default concurrency one', async () => {
    const provider = new FakeProvider('ok', 20);
    const app = server(provider);
    await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth,
        payload: { model: 'x', input: 'one' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth,
        payload: { model: 'x', input: 'two' },
      }),
    ]);
    expect(provider.maxActive).toBe(1);
    expect(provider.prompts[0]).toContain('one');
    expect(provider.prompts[1]).toContain('two');
    await app.close();
  });

  it.each([
    ['login_required', 503],
    ['security_challenge', 503],
    ['rate_limited', 429],
    ['ui_changed', 503],
  ] as const)('returns machine-readable %s errors', async (code, status) => {
    const app = server(new ErrorProvider(new AppError(code, `simulated ${code}`)));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'x', input: 'hello' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    await app.close();
  });

  it('aborts timed-out work and releases fake resources', async () => {
    const provider = new FakeProvider('late', 100);
    const app = server(provider, 10);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'x', input: 'hello' },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('timeout');
    expect(provider.active).toBe(0);
    await app.close();
  });

  it('rejects invalid request fields rather than silently ignoring them', async () => {
    const app = server(new FakeProvider());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'x', messages: [{ role: 'user', content: 'x' }], tools: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
    await app.close();
  });
});
