import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchImplementation } from '../src/api/local-admin-client.js';
import { LocalGenerationClient } from '../src/api/local-generation-client.js';
import { testConfig } from './helpers.js';

const health = { status: 'ok', service: 'tab2api' };
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
function recordFetch(implementation: FetchImplementation) {
  const calls: FetchCall[] = [];
  const fetchImplementation: FetchImplementation = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return implementation(input, init);
  };
  return { calls, fetchImplementation };
}

function expectProbeOnly(calls: FetchCall[]): void {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('http://127.0.0.1:3210/healthz');
  expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
  expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
  expect(calls[0]?.init?.body).toBeUndefined();
}

describe('generation service identity', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['chat', 'count_tokens'] as const)(
    'never sends the key or prompt to an unrelated loopback service (%s)',
    async (operation) => {
      const requests: {
        method: string | undefined;
        url: string | undefined;
        authorization: string | undefined;
        body: string;
      }[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          requests.push({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            body,
          });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ status: 'ok', service: 'another-service' }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected loopback address.');
      const client = new LocalGenerationClient(
        testConfig({ port: address.port, apiToken: 'synthetic-test-only-generation-sentinel' }),
      );
      try {
        const pending =
          operation === 'chat'
            ? client.chat({ prompt: 'synthetic private prompt' })
            : client.countTokens('synthetic private prompt');
        await expect(pending).rejects.toMatchObject({ code: 'unexpected_service' });
        expect(requests).toEqual([
          { method: 'GET', url: '/healthz', authorization: undefined, body: '' },
        ]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
  );
});

describe('generation identity failures and deadlines', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [
      'wrong identity',
      () => jsonResponse({ status: 'ok', service: 'another-service' }),
      'unexpected_service',
    ],
    ['extra fields', () => jsonResponse({ ...health, extra: true }), 'unexpected_service'],
    [
      'HTTP failure',
      () => new Response('private server body', { status: 503 }),
      'unexpected_service',
    ],
    ['wrong content type', () => new Response(JSON.stringify(health)), 'unexpected_service'],
    [
      'malformed JSON',
      () =>
        new Response('private server body', { headers: { 'content-type': 'application/json' } }),
      'unexpected_service',
    ],
    [
      'invalid length',
      () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '-1' },
        }),
      'unexpected_service',
    ],
    [
      'oversized declared body',
      () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '2621441' },
        }),
      'response_too_large',
    ],
    [
      'oversized streamed body',
      () =>
        new Response(new Uint8Array(2_621_441), {
          headers: { 'content-type': 'application/json' },
        }),
      'response_too_large',
    ],
  ] as const)('fails closed for %s', async (_label, response, code) => {
    const { calls, fetchImplementation } = recordFetch(async () => response());
    const client = new LocalGenerationClient(testConfig(), { fetchImplementation });
    const error = await client
      .chat({ prompt: 'synthetic private prompt' })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'LocalGenerationError', code });
    expect(String(error)).not.toContain('private server body');
    expectProbeOnly(calls);
  });

  it('rejects a real loopback redirect without following it or sending credentials', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Expected loopback address.');
    const client = new LocalGenerationClient(testConfig({ port: address.port }));
    try {
      await expect(client.countTokens('synthetic private prompt')).rejects.toMatchObject({
        code: 'unreachable',
      });
      expect(paths).toEqual(['/healthz']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('probes every operation and preserves IPv6 loopback formatting', async () => {
    let probeCount = 0;
    const { calls, fetchImplementation } = recordFetch(async (input) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith('/healthz'))
        return jsonResponse(++probeCount === 1 ? health : { status: 'ok', service: 'unrelated' });
      return jsonResponse({ input_tokens: 1 });
    });
    const client = new LocalGenerationClient(testConfig({ host: '::1', port: 4321 }), {
      fetchImplementation,
    });
    await expect(client.countTokens('first')).resolves.toBe(1);
    await expect(client.countTokens('second')).rejects.toMatchObject({
      code: 'unexpected_service',
    });
    expect(calls.map(({ url }) => url)).toEqual([
      'http://[::1]:4321/healthz',
      'http://[::1]:4321/v1/messages/count_tokens',
      'http://[::1]:4321/healthz',
    ]);
    expect(new Headers(calls[2]?.init?.headers).has('authorization')).toBe(false);
    expect(calls[2]?.init?.body).toBeUndefined();
  });

  it.each(['cancelled', 'timeout'] as const)(
    'preserves %s while reading the health body',
    async (code) => {
      const controller = new AbortController();
      if (code === 'timeout') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const { calls, fetchImplementation } = recordFetch(
        async (_input, init) =>
          new Response(
            new ReadableStream({
              start(stream) {
                init?.signal?.addEventListener(
                  'abort',
                  () => stream.error(new Error('read aborted')),
                  { once: true },
                );
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      const client = new LocalGenerationClient(testConfig(), { fetchImplementation });
      const pending = client.chat(
        { prompt: 'synthetic private prompt' },
        code === 'cancelled' ? controller.signal : undefined,
      );
      controller.abort(new Error('synthetic abort'));
      await expect(pending).rejects.toMatchObject({ code });
      expectProbeOnly(calls);
    },
  );

  it.each([200, 503])(
    'does not send credentials when cancelled as the HTTP %s probe finishes',
    async (status) => {
      const controller = new AbortController();
      const { calls, fetchImplementation } = recordFetch(async () => {
        controller.abort(new Error('synthetic cancellation'));
        return new Response(JSON.stringify(health), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });
      const client = new LocalGenerationClient(testConfig(), { fetchImplementation });
      await expect(client.chat({ prompt: 'private' }, controller.signal)).rejects.toMatchObject({
        code: 'cancelled',
      });
      expectProbeOnly(calls);
    },
  );

  it('does not start a probe after caller cancellation', async () => {
    const { calls, fetchImplementation } = recordFetch(async () => jsonResponse(health));
    const client = new LocalGenerationClient(testConfig(), { fetchImplementation });
    await expect(client.chat({ prompt: 'private' }, AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });

  it('shares one timeout signal across the probe and authenticated request', async () => {
    const timeout = new AbortController();
    const createTimeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { calls, fetchImplementation } = recordFetch((input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith('/healthz'))
        return Promise.resolve(jsonResponse(health));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('deadline expired')), {
          once: true,
        });
        startedResolve?.();
      });
    });
    const client = new LocalGenerationClient(testConfig(), {
      fetchImplementation,
      timeoutMs: 1234,
    });
    const pending = client.countTokens('synthetic prompt');
    await started;
    timeout.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(createTimeout).toHaveBeenCalledExactlyOnceWith(1234);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.signal).toBe(calls[1]?.init?.signal);
  });
});
