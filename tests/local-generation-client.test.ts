import { describe, expect, it } from 'vitest';
import { LocalGenerationClient } from '../src/api/local-generation-client.js';
import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

describe('loopback generation client', () => {
  it('sends chat completions with bearer auth and returns the answer text', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async (input, init) => {
        calls.push({
          url: input instanceof Request ? input.url : input.toString(),
          init,
        });
        return jsonResponse({
          id: 'chatcmpl-x',
          choices: [{ message: { role: 'assistant', content: 'the answer' } }],
        });
      },
    });

    await expect(
      client.chat({
        prompt: 'hi',
        temporary: true,
        reasoningEffort: 'low',
        conversationId: 'conv-9',
        projectId: 'g-p-abc',
      }),
    ).resolves.toBe('the answer');

    expect(calls[0]?.url).toBe('http://127.0.0.1:4321/v1/chat/completions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${testConfig().apiToken}`,
    );
    const body = calls[0]?.init?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(body)).toMatchObject({
      model: 'chatgpt-web',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      temporary: true,
      reasoning_effort: 'low',
      conversation_id: 'conv-9',
      project_id: 'g-p-abc',
    });
  });

  it('counts tokens through the Anthropic-shaped endpoint', async () => {
    const calls: { url: string }[] = [];
    const client = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async (input) => {
        calls.push({ url: input instanceof Request ? input.url : input.toString() });
        return jsonResponse({ input_tokens: 321 });
      },
    });
    await expect(client.countTokens('hello')).resolves.toBe(321);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4321/v1/messages/count_tokens');
  });

  it('passes server error codes through from both envelope shapes', async () => {
    const openAiShape = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async () =>
        jsonResponse(
          { error: { code: 'draining', message: 'Intake is closed for a lifecycle step.' } },
          503,
        ),
    });
    await expect(openAiShape.chat({ prompt: 'x' })).rejects.toMatchObject({
      code: 'draining',
      message: 'Intake is closed for a lifecycle step.',
    });

    const anthropicShape = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              tab2api_code: 'invalid_request',
              message: 'bad',
            },
          },
          400,
        ),
    });
    await expect(anthropicShape.countTokens('x')).rejects.toMatchObject({
      code: 'invalid_request',
    });

    const unknownShape = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async () => new Response('nope', { status: 500 }),
    });
    await expect(unknownShape.chat({ prompt: 'x' })).rejects.toMatchObject({
      code: 'request_failed',
    });
  });

  it('types malformed success bodies, cancellation, and unreachable services', async () => {
    const malformed = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async () => jsonResponse({ choices: [] }),
    });
    await expect(malformed.chat({ prompt: 'x' })).rejects.toMatchObject({
      code: 'invalid_response',
    });

    const unreachable = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(unreachable.chat({ prompt: 'x' })).rejects.toMatchObject({
      code: 'unreachable',
    });

    const controller = new AbortController();
    const hanging = new LocalGenerationClient(testConfig({ port: 4321 }), {
      fetchImplementation: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = init?.signal?.reason;
              reject(reason instanceof Error ? reason : new Error('aborted'));
            },
            { once: true },
          );
        }),
    });
    const pending = hanging.chat({ prompt: 'x' }, controller.signal);
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('works end to end against a live loopback server', async () => {
    const provider = new FakeProvider('live answer');
    const app = buildServer({ config: testConfig(), provider, logger: createLogger('silent') });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const config = testConfig({ port: Number(new URL(address).port) });
    const client = new LocalGenerationClient(config);
    try {
      await expect(client.chat({ prompt: 'ping' })).resolves.toBe('live answer');
      await expect(client.countTokens('ping')).resolves.toBeGreaterThan(0);
      expect(provider.prompts[0]).toContain('ping');
    } finally {
      await app.close();
    }
  });
});
