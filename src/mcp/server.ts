import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DrainStatusResponse, SessionStateResponse } from '../api/admin-contract.js';
import type { ChatOptions } from '../api/local-generation-client.js';

/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * `tab2api mcp` exposes the running loopback service as MCP tools so MCP hosts (Claude Code,
 * Cursor, Claude Desktop, ...) can call ChatGPT through the same queue, budgets, drain
 * lifecycle, and bearer authentication as every other API caller. The process only speaks
 * JSON-RPC on stdout; nothing else may be written there.
 *
 * Scope is deliberately tools-only: no resources, prompts, or streaming notifications.
 */

const packageVersion = z
  .looseObject({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version;

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export interface McpBackend {
  chat(options: ChatOptions): Promise<string>;
  countTokens(prompt: string): Promise<number>;
  sessionState(): Promise<SessionStateResponse>;
  drainStatus(): Promise<DrainStatusResponse>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const chatArgumentsSchema = z
  .object({
    prompt: z.string().min(1).max(4_000_000),
    temporary: z.boolean().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    conversation_id: z.string().min(1).max(128).optional(),
    project_id: z.string().min(1).max(128).optional(),
  })
  .strict();

const countTokensArgumentsSchema = z.object({ prompt: z.string().min(1).max(4_000_000) }).strict();

const toolCallParamsSchema = z
  .object({
    name: z.string(),
    arguments: z.unknown().optional(),
  })
  .strict();

const TOOL_DEFINITIONS = [
  {
    name: 'chat',
    description:
      'Send a prompt to the authenticated ChatGPT Web session through tab2api and return the answer text. Honors the single-writer queue and prompt token ceiling.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user-visible prompt text.' },
        temporary: {
          type: 'boolean',
          description:
            'Run the turn in a Temporary Chat that is not saved to chat history. Incompatible with conversation_id and project_id.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          description:
            'Composer effort level. Fails when the account picker does not offer the option; never changes the model.',
        },
        conversation_id: {
          type: 'string',
          description: 'Continue an existing saved ChatGPT conversation.',
        },
        project_id: {
          type: 'string',
          description: 'Send the prompt inside a ChatGPT project (g-p-... identifier).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'count_tokens',
    description:
      'Estimate the o200k token cost of a prompt as the running tab2api service would charge it, including no hidden reserves. Use before sending very large prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt text to measure.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      'Report the tab2api session state (ready/login_required/...) and queue drain status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function toolText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Handles one decoded JSON-RPC message. Returns the response object to write, or null for
 * notifications and malformed messages that carry no id to answer.
 */
export class McpServer {
  constructor(private readonly backend: McpBackend) {}

  async handle(message: JsonRpcRequest): Promise<object | null> {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Requests must be syntactically valid; malformed notifications cannot be answered.
      const id = message.id === undefined ? null : message.id;
      return id === null ? null : jsonRpcError(id, -32_600, 'Invalid JSON-RPC request.');
    }
    // JSON-RPC notifications carry no id and are never answered.
    if (message.id === undefined) return null;
    const { id, method, params } = message as JsonRpcRequest & {
      id: string | number;
      method: string;
    };

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocolVersion(params),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'tab2api', version: packageVersion },
            instructions:
              'Use the chat tool to send prompts to ChatGPT through the local tab2api bridge. The service must already be running (tab2api start) and logged in (tab2api login).',
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
      case 'tools/call':
        return this.callTool(id, params);
      default:
        return jsonRpcError(id, -32_601, `Method not found: ${method}`);
    }
  }

  private async callTool(id: string | number | null, params: unknown): Promise<object> {
    const parsed = toolCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      return jsonRpcError(id, -32_602, 'tools/call requires a tool name.');
    }
    const { name, arguments: args } = parsed.data;
    try {
      switch (name) {
        case 'chat': {
          const parsedArgs = chatArgumentsSchema.safeParse(args ?? {});
          if (!parsedArgs.success) {
            return jsonRpcError(
              id,
              -32_602,
              `Invalid chat arguments: ${parsedArgs.error.issues
                .map((issue) => issue.path.join('.') || 'arguments')
                .join(', ')}`,
            );
          }
          const { prompt, temporary, reasoning_effort, conversation_id, project_id } =
            parsedArgs.data;
          const text = await this.backend.chat({
            prompt,
            temporary,
            reasoningEffort: reasoning_effort,
            conversationId: conversation_id,
            projectId: project_id,
          });
          return { jsonrpc: '2.0', id, result: toolText(text) };
        }
        case 'count_tokens': {
          const parsedArgs = countTokensArgumentsSchema.safeParse(args ?? {});
          if (!parsedArgs.success) {
            return jsonRpcError(id, -32_602, 'count_tokens requires a prompt string.');
          }
          const tokens = await this.backend.countTokens(parsedArgs.data.prompt);
          return {
            jsonrpc: '2.0',
            id,
            result: toolText(
              JSON.stringify({ input_tokens: tokens, token_count_mode: 'estimated' }),
            ),
          };
        }
        case 'status': {
          const [session, drain] = await Promise.all([
            this.backend.sessionState(),
            this.backend.drainStatus(),
          ]);
          return {
            jsonrpc: '2.0',
            id,
            result: toolText(JSON.stringify({ session: session.state, queue: drain })),
          };
        }
        default:
          return jsonRpcError(id, -32_602, `Unknown tool: ${name}`);
      }
    } catch (error) {
      // Tool execution failures are protocol-successful results flagged as errors so the
      // host can surface the message without tearing down the session.
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : 'Unexpected failure';
      return { jsonrpc: '2.0', id, result: { ...toolText(message), isError: true } };
    }
  }
}

function negotiateProtocolVersion(params: unknown): string {
  const requested =
    typeof params === 'object' &&
    params !== null &&
    'protocolVersion' in params &&
    typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined;
  return requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/**
 * Serves newline-delimited JSON-RPC: one message per line in, zero or one response line out.
 * Anything unparsable is answered with a protocol-level parse error rather than crashing the
 * host's stdio channel.
 */
export async function serveMcpStdio(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  backend: McpBackend,
): Promise<void> {
  const server = new McpServer(backend);
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeLine(output, jsonRpcError(null, -32_700, 'Parse error: expected JSON.'));
      continue;
    }
    const response = await server.handle(message);
    if (response !== null) writeLine(output, response);
  }
}

function writeLine(output: NodeJS.WritableStream, payload: object): void {
  output.write(`${JSON.stringify(payload)}\n`);
}
