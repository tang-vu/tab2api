import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  McpServer,
  serveMcpStdio,
  type McpBackend,
} from '../src/mcp/server.js';
import type { ChatOptions } from '../src/api/local-generation-client.js';

function fakeBackend(overrides: Partial<McpBackend> = {}): McpBackend & {
  chatCalls: ChatOptions[];
} {
  const chatCalls: ChatOptions[] = [];
  return {
    chatCalls,
    chat: async (options) => {
      chatCalls.push(options);
      return 'provider answer';
    },
    countTokens: async () => 42,
    sessionState: async () => ({ state: 'ready' }),
    drainStatus: async () => ({ draining: false, pending: 0, active: 0 }),
    ...overrides,
  };
}

describe('MCP stdio server', () => {
  it('answers initialize with server identity and negotiated protocol', async () => {
    const server = new McpServer(fakeBackend());
    const known = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(known).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'tab2api' },
        capabilities: { tools: {} },
      },
    });
    const unknown = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2999-01-01' },
    });
    expect(unknown).toMatchObject({
      id: 2,
      result: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
  });

  it('lists the chat, count_tokens, and status tools with strict schemas', async () => {
    const server = new McpServer(fakeBackend());
    const response = (await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })) as { result: { tools: Array<{ name: string; inputSchema: object }> } };
    const names = response.result.tools.map(({ name }) => name);
    expect(names).toEqual(['chat', 'count_tokens', 'status']);
    for (const tool of response.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('maps tools/call chat arguments onto the generation client', async () => {
    const backend = fakeBackend();
    const server = new McpServer(backend);
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/call',
      params: {
        name: 'chat',
        arguments: {
          prompt: 'hello',
          temporary: true,
          reasoning_effort: 'high',
          conversation_id: 'conv-1',
        },
      },
    });
    expect(response).toMatchObject({
      id: 'a',
      result: { content: [{ type: 'text', text: 'provider answer' }] },
    });
    expect(backend.chatCalls).toEqual([
      {
        prompt: 'hello',
        temporary: true,
        reasoningEffort: 'high',
        conversationId: 'conv-1',
        projectId: undefined,
      },
    ]);
  });

  it('rejects malformed tool arguments with a params error', async () => {
    const server = new McpServer(fakeBackend());
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'chat', arguments: { prompt: '' } },
    });
    expect(response).toMatchObject({ id: 4, error: { code: -32_602 } });
  });

  it('rejects unknown tools and unknown methods distinctly', async () => {
    const server = new McpServer(fakeBackend());
    await expect(
      server.handle({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      }),
    ).resolves.toMatchObject({ id: 5, error: { code: -32_602 } });
    await expect(
      server.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' }),
    ).resolves.toMatchObject({ id: 6, error: { code: -32_601 } });
  });

  it('surfaces backend failures as isError results, not protocol errors', async () => {
    const backend = fakeBackend({
      chat: async () => {
        throw new Error('service unreachable');
      },
    });
    const server = new McpServer(backend);
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'chat', arguments: { prompt: 'hi' } },
    });
    expect(response).toMatchObject({
      id: 7,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Error: service unreachable' }],
      },
    });
  });

  it('reports estimated token counts and merged status', async () => {
    const server = new McpServer(fakeBackend());
    const tokens = await server.handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'count_tokens', arguments: { prompt: 'abc' } },
    });
    expect(tokens).toMatchObject({
      result: { content: [{ text: '{"input_tokens":42,"token_count_mode":"estimated"}' }] },
    });
    const status = (await server.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(status.result.content[0]?.text ?? '{}') as {
      session: string;
      queue: { draining: boolean };
    };
    expect(payload).toEqual({
      session: 'ready',
      queue: { draining: false, pending: 0, active: 0 },
    });
  });

  it('answers ping and ignores notifications and malformed requests', async () => {
    const server = new McpServer(fakeBackend());
    await expect(server.handle({ jsonrpc: '2.0', id: 10, method: 'ping' })).resolves.toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: {},
    });
    await expect(
      server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).resolves.toBeNull();
    await expect(server.handle({ jsonrpc: '2.0', method: 'tools/list' })).resolves.toBeNull();
    await expect(server.handle({ jsonrpc: '1.0', method: 'ping' })).resolves.toBeNull();
    await expect(server.handle({ jsonrpc: '2.0', id: 11, method: 42 })).resolves.toMatchObject({
      id: 11,
      error: { code: -32_600 },
    });
  });

  it('serves newline-delimited JSON-RPC and survives parse errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    output.on('data', (chunk: Buffer) =>
      received.push(...chunk.toString('utf8').split('\n').filter(Boolean)),
    );

    const serving = serveMcpStdio(input, output, fakeBackend());
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end();

    await serving;
    const responses = received.map((line) => JSON.parse(line) as { id: unknown });
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ id: 1, result: {} });
    expect(responses[1]).toMatchObject({ id: null, error: { code: -32_700 } });
  });
});
