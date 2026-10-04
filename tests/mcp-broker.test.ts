import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/errors.js';
import { BrokerError, McpBroker } from '../src/mcp/broker.js';
import {
  assertLoopbackCallbackUrl,
  dispatchToolCallback,
  ToolCallbackError,
  type CallbackFetch,
} from '../src/mcp/callback.js';
import {
  assertSupportedToolSchema,
  MAX_ARGUMENT_BYTES,
  MAX_SCHEMA_DEPTH,
  validateToolArguments,
} from '../src/mcp/schema.js';

const lookupSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
} as const;

function registration(overrides: Record<string, unknown> = {}) {
  return {
    principalId: 'local-admin',
    tools: [{ name: 'lookup', description: 'Look a value up', inputSchema: lookupSchema }],
    callbackUrl: 'http://127.0.0.1:8765/tool',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(
  result: unknown = { result: 'tool output' },
): CallbackFetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: CallbackFetch & {
    calls: { url: string; init: RequestInit | undefined }[];
  } = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      init,
    });
    return jsonResponse(result);
  };
  fetcher.calls = calls;
  return fetcher;
}

async function boundToken(broker: McpBroker): Promise<string> {
  const turn = broker.register(registration());
  broker.bind(turn.turnToken);
  return turn.turnToken;
}

describe('McpBroker turn lifecycle', () => {
  it('issues a t2m_ token with a hex turn id and lists metadata only', async () => {
    const broker = new McpBroker({ fetchImplementation: recordingFetch() });
    const turn = broker.register(registration({ label: 'demo turn' }));
    expect(turn.id).toMatch(/^[a-f0-9]{16}$/);
    expect(turn.turnToken).toMatch(/^t2m_[A-Za-z0-9_-]{43}$/);
    expect(turn.tools).toBe(1);
    const [listed] = broker.list();
    expect(listed).toMatchObject({ id: turn.id, label: 'demo turn', state: 'issued', tools: 1 });
    expect(JSON.stringify(listed)).not.toContain(turn.turnToken);
    broker.close();
  });

  it('binds once, describes declared tools, dispatches to the loopback callback', async () => {
    const fetch = recordingFetch({ result: 'the answer' });
    const broker = new McpBroker({ fetchImplementation: fetch });
    const token = await boundToken(broker);
    const described = broker.describe(token);
    expect(described).toEqual([
      { name: 'lookup', description: 'Look a value up', inputSchema: lookupSchema },
    ]);
    const text = await broker.invoke(token, 'lookup', { q: 'cats' });
    expect(text).toBe('the answer');
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    if (call === undefined) throw new Error('expected a recorded call');
    expect(call.url).toBe('http://127.0.0.1:8765/tool');
    const sentBody = z
      .object({
        turn_id: z.string().regex(/^[a-f0-9]{16}$/),
        call_id: z.string().regex(/^call_[a-f0-9]{32}$/),
        tool: z.literal('lookup'),
        arguments: z.object({ q: z.literal('cats') }),
      })
      .parse(JSON.parse(typeof call.init?.body === 'string' ? call.init.body : '{}'));
    expect(sentBody.tool).toBe('lookup');
    broker.close();
  });

  it('passes the registered callback bearer token, never the admin key', async () => {
    const fetch = recordingFetch();
    const broker = new McpBroker({ fetchImplementation: fetch });
    const turn = broker.register(registration({ callbackToken: 'cb-secret' }));
    broker.bind(turn.turnToken);
    await broker.invoke(turn.turnToken, 'lookup', { q: 'x' });
    expect(fetch.calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer cb-secret',
    });
    broker.close();
  });

  it('rejects describe and invoke before the token is bound', async () => {
    const broker = new McpBroker();
    const turn = broker.register(registration());
    expect(() => broker.describe(turn.turnToken)).toThrow(BrokerError);
    await expect(broker.invoke(turn.turnToken, 'lookup', { q: 'x' })).rejects.toMatchObject({
      kind: 'not_bound',
    });
    broker.close();
  });

  it('fails closed on invalid, rebound, released, and revoked tokens', async () => {
    const broker = new McpBroker();
    await expect(broker.invoke('t2m_' + 'x'.repeat(43), 'lookup', {})).rejects.toMatchObject({
      kind: 'invalid_token',
    });
    const turn = broker.register(registration());
    broker.bind(turn.turnToken);
    expect(() => broker.bind(turn.turnToken)).toThrow(AppError);
    broker.release(turn.turnToken);
    await expect(broker.invoke(turn.turnToken, 'lookup', { q: 'x' })).rejects.toMatchObject({
      kind: 'invalid_token',
    });

    const second = broker.register(registration());
    broker.bind(second.turnToken);
    expect(broker.revoke(second.id)).toBe(true);
    await expect(broker.invoke(second.turnToken, 'lookup', { q: 'x' })).rejects.toMatchObject({
      kind: 'invalid_token',
    });
    expect(broker.revoke(second.id)).toBe(false);
    expect(broker.revoke('not-an-id')).toBe(false);
    broker.close();
  });

  it('rejects undeclared tools and schema-violating arguments without dispatching', async () => {
    const fetch = recordingFetch();
    const broker = new McpBroker({ fetchImplementation: fetch });
    const token = await boundToken(broker);
    await expect(broker.invoke(token, 'shell', {})).rejects.toMatchObject({
      kind: 'unknown_tool',
    });
    await expect(broker.invoke(token, 'lookup', { q: 5 })).rejects.toMatchObject({
      kind: 'invalid_arguments',
    });
    await expect(broker.invoke(token, 'lookup', { q: 'x', extra: true })).rejects.toMatchObject({
      kind: 'invalid_arguments',
    });
    expect(fetch.calls).toHaveLength(0);
    broker.close();
  });

  it('enforces the turn cap and drain semantics', async () => {
    const broker = new McpBroker({ maxTurns: 2 });
    broker.register(registration());
    broker.register(registration());
    expect(() => broker.register(registration())).toThrow(
      expect.objectContaining({ code: 'queue_full' }),
    );

    const bound = broker.list().find((turn) => turn.state === 'issued');
    expect(bound).toBeDefined();
    broker.beginDrain();
    expect(() => broker.register(registration())).toThrow(
      expect.objectContaining({ code: 'draining' }),
    );
    expect(broker.list()).toHaveLength(0);
    broker.endDrain();
    broker.register(registration());
    expect(broker.list()).toHaveLength(1);
    broker.close();
  });

  it('keeps bound turns through a drain but revokes idle ones', async () => {
    const broker = new McpBroker();
    const idle = broker.register(registration());
    const bound = broker.register(registration());
    broker.bind(bound.turnToken);
    broker.beginDrain();
    const remaining = broker.list().map((turn) => turn.id);
    expect(remaining).toEqual([bound.id]);
    await expect(broker.invoke(idle.turnToken, 'lookup', { q: 'x' })).rejects.toMatchObject({
      kind: 'invalid_token',
    });
    broker.close();
  });

  it('expires turns at their TTL', async () => {
    vi.useFakeTimers();
    try {
      const broker = new McpBroker({ maxTurnTtlMs: 60_000, sweepIntervalMs: 1_000 });
      const turn = broker.register(registration({ ttlMs: 60_000 }));
      broker.bind(turn.turnToken);
      vi.setSystemTime(Date.now() + 61_000);
      await expect(broker.invoke(turn.turnToken, 'lookup', { q: 'x' })).rejects.toMatchObject({
        kind: 'invalid_token',
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid declarations at registration', () => {
    const broker = new McpBroker();
    expect(() =>
      broker.register(registration({ tools: [{ name: 'bad name!', inputSchema: lookupSchema }] })),
    ).toThrow(AppError);
    expect(() =>
      broker.register(
        registration({
          tools: [
            { name: 'dup', inputSchema: lookupSchema },
            { name: 'dup', inputSchema: lookupSchema },
          ],
        }),
      ),
    ).toThrow(AppError);
    expect(() =>
      broker.register(registration({ tools: [{ name: 'x', inputSchema: { $ref: '#/other' } }] })),
    ).toThrow(AppError);
    expect(() =>
      broker.register(registration({ callbackUrl: 'https://169.254.169.254/latest' })),
    ).toThrow(AppError);
    expect(() => broker.register(registration({ ttlMs: 1_000 }))).toThrow(AppError);
    broker.close();
  });
});

describe('loopback callback URL policy', () => {
  it('accepts only unauthenticated loopback http URLs on unprivileged ports', () => {
    expect(assertLoopbackCallbackUrl('http://127.0.0.1:8765/path')).toContain('127.0.0.1');
    expect(assertLoopbackCallbackUrl('http://[::1]:9999/x')).toContain('::1');
    for (const bad of [
      'https://127.0.0.1:8765/',
      'http://127.0.0.1/',
      'http://127.0.0.1:80/',
      'http://user:pass@127.0.0.1:8765/',
      'http://127.0.0.1:8765/#frag',
      'http://localhost:8765/',
      'http://10.0.0.5:9000/',
      `http://127.0.0.1:8765/${'a'.repeat(512)}`,
      'not a url',
    ]) {
      expect(() => assertLoopbackCallbackUrl(bad)).toThrow(AppError);
    }
  });
});

describe('tool callback dispatch', () => {
  const payload = { turn_id: 'a'.repeat(16), call_id: 'call_x', tool: 't', arguments: {} };

  it('returns {result} and maps {error} to a rejection', async () => {
    const controller = new AbortController();
    const ok = await dispatchToolCallback({
      url: 'http://127.0.0.1:8765/tool',
      bearerToken: undefined,
      payload,
      signal: controller.signal,
      fetchImplementation: async () => jsonResponse({ result: 'done' }),
    });
    expect(ok).toBe('done');
    await expect(
      dispatchToolCallback({
        url: 'http://127.0.0.1:8765/tool',
        bearerToken: undefined,
        payload,
        signal: controller.signal,
        fetchImplementation: async () => jsonResponse({ error: 'tool refused' }),
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('rejects non-OK, non-JSON, and oversized callback responses', async () => {
    const controller = new AbortController();
    const base = {
      url: 'http://127.0.0.1:8765/tool',
      bearerToken: undefined,
      payload,
      signal: controller.signal,
    };
    await expect(
      dispatchToolCallback({ ...base, fetchImplementation: async () => jsonResponse({}, 500) }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      dispatchToolCallback({
        ...base,
        fetchImplementation: async () => new Response('not json', { status: 200 }),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(
      dispatchToolCallback({
        ...base,
        fetchImplementation: async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(300_000) },
          }),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('maps timeout vs cancellation from the abort reason', async () => {
    const timeoutSignal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      dispatchToolCallback({
        url: 'http://127.0.0.1:8765/tool',
        bearerToken: undefined,
        payload,
        signal: timeoutSignal,
        fetchImplementation: async () => {
          throw timeoutSignal.reason;
        },
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    const cancelled = AbortSignal.abort(new AppError('cancelled', 'turn ended'));
    await expect(
      dispatchToolCallback({
        url: 'http://127.0.0.1:8765/tool',
        bearerToken: undefined,
        payload,
        signal: cancelled,
        fetchImplementation: async () => {
          throw cancelled.reason;
        },
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(
      dispatchToolCallback({
        url: 'http://127.0.0.1:8765/tool',
        bearerToken: undefined,
        payload,
        signal: new AbortController().signal,
        fetchImplementation: async () => {
          throw new Error('socket refused');
        },
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(new ToolCallbackError('rejected', 'x').name).toBe('ToolCallbackError');
  });
});

describe('declared tool schema subset', () => {
  it('rejects unsupported JSON Schema keywords instead of ignoring them', () => {
    for (const schema of [
      { $ref: '#/x' },
      { type: 'object', properties: { a: { oneOf: [] } } },
      { type: 'string', pattern: '^a' },
      { type: 'string', format: 'email' },
      { type: 'object', patternProperties: { '^x': {} } },
      'not-an-object',
    ]) {
      expect(() => assertSupportedToolSchema(schema, 'tool')).toThrow(AppError);
    }
  });

  it('bounds schema size and depth', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < MAX_SCHEMA_DEPTH + 2; i += 1) {
      deep = { type: 'object', properties: { a: deep } };
    }
    expect(() => assertSupportedToolSchema(deep, 'tool')).toThrow(AppError);
  });

  it('validates arguments against the declared schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 5 },
        mode: { enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(
      validateToolArguments(schema, { name: 'a', count: 2, mode: 'fast', tags: ['x'] }),
    ).toEqual([]);
    expect(validateToolArguments(schema, 'nope')).not.toEqual([]);
    expect(validateToolArguments(schema, { count: 1 })).not.toEqual([]);
    expect(validateToolArguments(schema, { name: 'a', count: 9 })).not.toEqual([]);
    expect(validateToolArguments(schema, { name: 'a', mode: 'turbo' })).not.toEqual([]);
    expect(validateToolArguments(schema, { name: 'a', tags: ['1', '2', '3', '4'] })).not.toEqual(
      [],
    );
    expect(validateToolArguments(schema, { name: 'a', unknown: 1 })).not.toEqual([]);
    expect(validateToolArguments(schema, JSON.parse('{"name":"a","__proto__":{}}'))).not.toEqual(
      [],
    );
    expect(validateToolArguments(schema, { name: 'a'.repeat(MAX_ARGUMENT_BYTES) })).not.toEqual([]);
  });
});
