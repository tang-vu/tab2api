import { describe, expect, it } from 'vitest';
import { LocalAdminClient, type FetchImplementation } from '../src/api/local-admin-client.js';
import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function queuedFetch(responses: readonly Response[]): {
  calls: FetchCall[];
  fetchImplementation: FetchImplementation;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  return {
    calls,
    fetchImplementation: async (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
      const response = responses[index];
      index += 1;
      if (response === undefined) throw new Error('Unexpected fetch in test.');
      return response;
    },
  };
}

function hangingFetch(calls: FetchCall[]): FetchImplementation {
  return (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error('Test fetch requires an abort signal.'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Test request aborted.'));
        return;
      }
      signal.addEventListener(
        'abort',
        () =>
          reject(
            signal.reason instanceof Error ? signal.reason : new Error('Test request aborted.'),
          ),
        { once: true },
      );
    });
  };
}

const health = { status: 'ok', service: 'tab2api' };
const adminKey = {
  id: 'local-admin',
  label: 'Local administrator',
  role: 'admin',
  createdAt: 'runtime',
};

describe('loopback administration client', () => {
  it('manages live server state end to end over loopback', async () => {
    const config = testConfig();
    const provider = new FakeProvider();
    const app = buildServer({ config, provider, logger: createLogger('silent') });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(address).port);
    const client = new LocalAdminClient({ ...config, port });

    try {
      await expect(client.listApiKeys()).resolves.toEqual({ data: [adminKey] });
      const created = await client.createApiKey('Integration laptop');
      expect(created).toMatchObject({ label: 'Integration laptop', role: 'client' });
      const active = (await client.listApiKeys()).data.find(({ id }) => id === created.id);
      expect(active).toMatchObject({ id: created.id });
      expect(active).not.toHaveProperty('revokedAt');
      await client.revokeApiKey(created.id);
      const revoked = (await client.listApiKeys()).data.find(({ id }) => id === created.id);
      expect(revoked).toMatchObject({ id: created.id });
      expect(revoked?.role === 'client' && typeof revoked.revokedAt === 'string').toBe(true);
      await expect(client.usage()).resolves.toMatchObject({ tokenCounts: 'estimated' });
      await client.resetSession();
      expect(provider.state).toBe('browser_disconnected');
    } finally {
      await app.close();
    }
  });

  it('probes exact service identity before sending the administrator key', async () => {
    const clientKey = {
      id: '0123456789abcdef',
      label: 'Laptop',
      role: 'client',
      createdAt: '2026-08-23T00:00:00.000Z',
    };
    const { calls, fetchImplementation } = queuedFetch([
      jsonResponse(health),
      jsonResponse({ data: [adminKey, clientKey] }),
    ]);
    const config = testConfig({ port: 4321 });
    const client = new LocalAdminClient(config, { fetchImplementation });

    await expect(client.listApiKeys()).resolves.toEqual({ data: [adminKey, clientKey] });
    expect(calls.map(({ url }) => url)).toEqual([
      'http://127.0.0.1:4321/healthz',
      'http://127.0.0.1:4321/admin/api-keys',
    ]);
    expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe(
      `Bearer ${config.apiToken}`,
    );
    expect(calls.every(({ init }) => init?.redirect === 'error')).toBe(true);
  });

  it('normalizes a new key label and validates the one-time token response', async () => {
    const created = {
      id: '0123456789abcdef',
      label: 'Personal laptop',
      role: 'client',
      createdAt: '2026-08-23T00:00:00.000Z',
      token: `tab2api_0123456789abcdef_${'A'.repeat(43)}`,
    };
    const { calls, fetchImplementation } = queuedFetch([
      jsonResponse(health),
      jsonResponse(created),
    ]);
    const client = new LocalAdminClient(testConfig(), { fetchImplementation });

    await expect(client.createApiKey('  Personal laptop  ')).resolves.toEqual(created);
    const body = calls[1]?.init?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
    expect(JSON.parse(body)).toEqual({ label: 'Personal laptop' });
    expect(calls[1]?.init?.method).toBe('POST');
  });

  it('never sends the key when the loopback service identity is wrong', async () => {
    const { calls, fetchImplementation } = queuedFetch([
      jsonResponse({ status: 'ok', service: 'another-service' }),
    ]);
    const client = new LocalAdminClient(testConfig(), { fetchImplementation });

    await expect(client.usage()).rejects.toMatchObject({ code: 'unexpected_service' });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  it('maps authentication and malformed success responses to typed failures', async () => {
    const unauthorized = queuedFetch([
      jsonResponse(health),
      jsonResponse({ secret: 'must-not-appear-in-errors' }, 401),
    ]);
    const unauthorizedClient = new LocalAdminClient(testConfig(), {
      fetchImplementation: unauthorized.fetchImplementation,
    });
    const authenticationFailure = await unauthorizedClient.usage().catch((error: unknown) => error);
    expect(authenticationFailure).toMatchObject({ code: 'authentication_failed' });
    expect(authenticationFailure).not.toHaveProperty('message', expect.stringContaining('secret'));

    const malformed = queuedFetch([jsonResponse(health), jsonResponse({ data: [] })]);
    const malformedClient = new LocalAdminClient(testConfig(), {
      fetchImplementation: malformed.fetchImplementation,
    });
    await expect(malformedClient.listApiKeys()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('bounds response bytes before consuming an oversized administration body', async () => {
    const { calls, fetchImplementation } = queuedFetch([
      jsonResponse(health),
      jsonResponse({}, 200, { 'content-length': '3000000' }),
    ]);
    const client = new LocalAdminClient(testConfig(), { fetchImplementation });

    await expect(client.usage()).rejects.toMatchObject({ code: 'response_too_large' });
    expect(calls).toHaveLength(2);
  });

  it('reports deterministic timeout and caller cancellation failures', async () => {
    const timeoutController = new AbortController();
    const timeoutCalls: FetchCall[] = [];
    const timeoutClient = new LocalAdminClient(testConfig(), {
      fetchImplementation: hangingFetch(timeoutCalls),
      createTimeoutSignal: () => timeoutController.signal,
    });
    const timedOut = timeoutClient.listApiKeys();
    timeoutController.abort(new Error('simulated timeout'));
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    expect(timeoutCalls).toHaveLength(1);

    const cancellationController = new AbortController();
    const cancellationCalls: FetchCall[] = [];
    const cancellationClient = new LocalAdminClient(testConfig(), {
      fetchImplementation: hangingFetch(cancellationCalls),
      createTimeoutSignal: () => new AbortController().signal,
    });
    const cancelled = cancellationClient.listApiKeys(cancellationController.signal);
    cancellationController.abort(new Error('simulated caller cancellation'));
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancellationCalls).toHaveLength(1);
  });

  it('types transport failures and formats IPv6 loopback URLs correctly', async () => {
    const unreachableClient = new LocalAdminClient(testConfig(), {
      fetchImplementation: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(unreachableClient.usage()).rejects.toMatchObject({ code: 'unreachable' });

    const { calls, fetchImplementation } = queuedFetch([
      jsonResponse(health),
      jsonResponse({ tokenCounts: 'estimated', keys: [] }),
    ]);
    const ipv6Client = new LocalAdminClient(testConfig({ host: '::1', port: 4321 }), {
      fetchImplementation,
    });
    await expect(ipv6Client.usage()).resolves.toEqual({ tokenCounts: 'estimated', keys: [] });
    expect(calls[0]?.url).toBe('http://[::1]:4321/healthz');
    expect(calls[1]?.url).toBe('http://[::1]:4321/admin/usage');
  });

  it('rejects invalid labels locally before any request is made', async () => {
    const calls: FetchCall[] = [];
    const client = new LocalAdminClient(testConfig(), {
      fetchImplementation: hangingFetch(calls),
    });
    await expect(client.createApiKey('bad\u001blabel')).rejects.toMatchObject({
      code: 'request_failed',
    });
    expect(calls).toHaveLength(0);
  });
});
