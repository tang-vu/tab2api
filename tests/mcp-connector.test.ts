import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api/server.js';
import { createLogger } from '../src/observability/logger.js';
import { McpBroker } from '../src/mcp/broker.js';
import type { CallbackFetch } from '../src/mcp/callback.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

const auth = { authorization: 'Bearer test-only-token-that-is-long-enough' };
const CONNECTOR_KEY = 'test-only-connector-token-long-enough';
const MCP_URL = `/mcp/${CONNECTOR_KEY}`;

const createdTurnSchema = z.object({
  id: z.string(),
  turn_token: z.string(),
  expiresAt: z.string(),
  tools: z.number(),
});

const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })).min(1),
    isError: z.boolean().optional(),
  }),
});

const toolErrorSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })).min(1),
    isError: z.literal(true),
  }),
});

const rpcErrorSchema = z.object({ error: z.object({ code: z.number() }) });
const turnListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      state: z.enum(['issued', 'bound']),
      label: z.string().optional(),
      tools: z.number(),
      expiresAt: z.string(),
    }),
  ),
});

function rpc(method: string, params?: unknown, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

function callbackServer(result: unknown = { result: 'callback text' }): CallbackFetch & {
  calls: { url: string; body: Record<string, unknown>; auth?: string }[];
} {
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const fetcher: CallbackFetch & { calls: typeof calls } = async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      body: z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')),
      ...(headers?.authorization === undefined ? {} : { auth: headers.authorization }),
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetcher.calls = calls;
  return fetcher;
}

const toolDeclaration = {
  name: 'fs.read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

async function registerTurn(app: ReturnType<typeof buildServer>, overrides = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/mcp/turns',
    headers: auth,
    payload: {
      label: 'test turn',
      tools: [toolDeclaration],
      callback_url: 'http://127.0.0.1:8765/tool',
      ...overrides,
    },
  });
  const parsed = createdTurnSchema.safeParse(response.json());
  return { response, turn: parsed.success ? parsed.data : undefined };
}

function server(provider = new FakeProvider(), broker?: McpBroker) {
  return buildServer({
    config: testConfig(),
    provider,
    logger: createLogger('silent'),
    ...(broker === undefined ? {} : { broker }),
  });
}

describe('MCP connector endpoint', () => {
  it('answers initialize, ping, and tools/list over the connector URL', async () => {
    const app = server();
    try {
      const init = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('initialize', { protocolVersion: '2024-11-05' }),
      });
      expect(init.statusCode).toBe(200);
      expect(init.json()).toMatchObject({
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'tab2api-connector' },
          capabilities: { tools: {} },
        },
      });

      const ping = await app.inject({ method: 'POST', url: MCP_URL, payload: rpc('ping') });
      expect(ping.json()).toMatchObject({ id: 1, result: {} });

      const list = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/list'),
      });
      const tools = z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(list.json())
        .result.tools.map((tool) => tool.name);
      expect(tools).toEqual(['describe_turn_tools', 'call_turn_tool']);
    } finally {
      await app.close();
    }
  });

  it('rejects wrong keys, malformed frames, and stream transports', async () => {
    const app = server();
    try {
      const wrongKey = await app.inject({
        method: 'POST',
        url: '/mcp/wrong-key-that-does-not-match',
        payload: rpc('initialize'),
      });
      expect(wrongKey.statusCode).toBe(401);

      const malformed = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: { jsonrpc: '2.0', id: 7 },
      });
      expect(rpcErrorSchema.parse(malformed.json()).error.code).toBe(-32600);

      const unknown = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('resources/list'),
      });
      expect(rpcErrorSchema.parse(unknown.json()).error.code).toBe(-32601);

      const batch = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: Array.from({ length: 9 }, (_, index) => rpc('ping', undefined, index)),
      });
      expect(batch.statusCode).toBe(400);

      const notification = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(notification.statusCode).toBe(202);

      expect((await app.inject({ method: 'GET', url: MCP_URL })).statusCode).toBe(405);
      expect((await app.inject({ method: 'DELETE', url: MCP_URL })).statusCode).toBe(405);
    } finally {
      await app.close();
    }
  });

  it('describes and invokes tools only while a turn is bound', async () => {
    const fetcher = callbackServer({ result: 'file contents' });
    const broker = new McpBroker({ fetchImplementation: fetcher });
    const provider = new FakeProvider('held', 150);
    const app = server(provider, broker);
    try {
      const { turn } = await registerTurn(app);
      if (turn === undefined) throw new Error('turn registration failed');
      const body = turn;
      expect(body.turn_token).toMatch(/^t2m_/);

      // Before binding the token describes nothing and calls nothing.
      const early = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'describe_turn_tools',
          arguments: { turn_token: body.turn_token },
        }),
      });
      expect(toolErrorSchema.parse(early.json()).result.isError).toBe(true);
      expect(fetcher.calls).toHaveLength(0);

      const generation = app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth,
        payload: {
          model: 'chatgpt-web',
          messages: [{ role: 'user', content: 'read a file' }],
          mcp_turn_token: body.turn_token,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      const described = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'describe_turn_tools',
          arguments: { turn_token: body.turn_token },
        }),
      });
      const toolsText = z
        .object({ tools: z.array(z.object({ name: z.string() })) })
        .parse(
          JSON.parse(toolResultSchema.parse(described.json()).result.content[0]?.text ?? '{}'),
        );
      expect(toolsText.tools.map((tool) => tool.name)).toEqual(['fs.read']);

      const called = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'call_turn_tool',
          arguments: {
            turn_token: body.turn_token,
            name: 'fs.read',
            arguments: { path: 'README.md' },
          },
        }),
      });
      expect(toolResultSchema.parse(called.json()).result.content[0]?.text).toBe('file contents');
      expect(fetcher.calls).toHaveLength(1);
      expect(fetcher.calls[0]?.body).toMatchObject({
        turn_id: body.id,
        tool: 'fs.read',
        arguments: { path: 'README.md' },
      });

      const done = await generation;
      expect(done.statusCode).toBe(200);
      expect(provider.prompts[0]).toContain('<tab2api-connector>');
      expect(provider.prompts[0]).toContain(body.turn_token);

      // The capability dies with the turn: replaying it afterwards fails closed.
      const replay = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'describe_turn_tools',
          arguments: { turn_token: body.turn_token },
        }),
      });
      const replayed = toolErrorSchema.parse(replay.json()).result;
      expect(replayed.content[0]?.text).toContain('invalid, expired, or revoked');
    } finally {
      await app.close();
    }
  });

  it('returns tool errors as isError results so the model sees the reason', async () => {
    const fetcher = callbackServer({ error: 'tool exploded' });
    const broker = new McpBroker({ fetchImplementation: fetcher });
    const app = server(new FakeProvider('ok', 100), broker);
    try {
      const { turn } = await registerTurn(app);
      if (turn === undefined) throw new Error('turn registration failed');
      const body = turn;
      const generation = app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth,
        payload: {
          model: 'chatgpt-web',
          messages: [{ role: 'user', content: 'run it' }],
          mcp_turn_token: body.turn_token,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const called = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'call_turn_tool',
          arguments: { turn_token: body.turn_token, name: 'fs.read', arguments: { path: 'x' } },
        }),
      });
      const result = toolErrorSchema.parse(called.json()).result;
      expect(result.content[0]?.text).toContain('tool exploded');
      await generation;

      const badToken = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {
          name: 'call_turn_tool',
          arguments: { turn_token: 't2m_' + 'a'.repeat(43), name: 'x', arguments: {} },
        }),
      });
      expect(toolErrorSchema.parse(badToken.json()).result.isError).toBe(true);

      const missingParams = await app.inject({
        method: 'POST',
        url: MCP_URL,
        payload: rpc('tools/call', {}),
      });
      expect(rpcErrorSchema.parse(missingParams.json()).error.code).toBe(-32602);
    } finally {
      await app.close();
    }
  });
});

describe('MCP turn administration', () => {
  it('requires the admin key and validates declarations', async () => {
    const app = server();
    try {
      expect((await app.inject({ method: 'GET', url: '/admin/mcp/turns' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/admin/mcp/turns',
            payload: { tools: [], callback_url: 'http://127.0.0.1:8765/x' },
          })
        ).statusCode,
      ).toBe(401);

      const badUrl = await registerTurn(app, { callback_url: 'https://example.com/hook' });
      expect(badUrl.response.statusCode).toBe(400);
      const badSchema = await registerTurn(app, {
        tools: [{ name: 'x', input_schema: { $ref: '#/defs/a' } }],
      });
      expect(badSchema.response.statusCode).toBe(400);

      const { response, turn } = await registerTurn(app);
      expect(response.statusCode).toBe(200);
      if (turn === undefined) throw new Error('turn registration failed');
      const body = turn;
      expect(body.tools).toBe(1);
      expect(body.turn_token).toMatch(/^t2m_/);

      const list = await app.inject({ method: 'GET', url: '/admin/mcp/turns', headers: auth });
      expect(turnListSchema.parse(list.json()).data).toEqual([
        expect.objectContaining({ id: body.id, state: 'issued', label: 'test turn' }),
      ]);

      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/admin/mcp/turns/nothex',
            headers: auth,
          })
        ).statusCode,
      ).toBe(400);
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/admin/mcp/turns/${body.id}`,
        headers: auth,
      });
      expect(revoked.json()).toMatchObject({ status: 'revoked', id: body.id });
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/admin/mcp/turns/${body.id}`,
            headers: auth,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid, replayed, and malformed mcp_turn_token on generation', async () => {
    const provider = new FakeProvider();
    const app = server(provider);
    try {
      const chat = (token?: unknown) =>
        app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: auth,
          payload: {
            model: 'chatgpt-web',
            messages: [{ role: 'user', content: 'hi' }],
            ...(token === undefined ? {} : { mcp_turn_token: token }),
          },
        });

      expect((await chat('not-a-token')).statusCode).toBe(400);
      expect((await chat('t2m_' + 'z'.repeat(43))).statusCode).toBe(400);

      const { turn } = await registerTurn(app);
      if (turn === undefined) throw new Error('turn registration failed');
      const body = turn;
      expect((await chat(body.turn_token)).statusCode).toBe(200);
      expect((await chat(body.turn_token)).statusCode).toBe(400);
      expect(provider.prompts).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('blocks registration while draining and clears idle turns', async () => {
    const app = server();
    try {
      const { turn } = await registerTurn(app);
      if (turn === undefined) throw new Error('turn registration failed');
      const body = turn;
      const drain = await app.inject({ method: 'POST', url: '/admin/drain', headers: auth });
      expect(drain.statusCode).toBe(200);
      const during = await registerTurn(app);
      expect(during.response.statusCode).toBe(503);
      const list = await app.inject({ method: 'GET', url: '/admin/mcp/turns', headers: auth });
      expect(turnListSchema.parse(list.json()).data).toHaveLength(0);
      expect(body.id).toBeDefined();
      await app.inject({ method: 'POST', url: '/admin/resume', headers: auth });
      expect((await registerTurn(app)).response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
