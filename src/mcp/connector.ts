import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import { AppError } from '../errors.js';
import { secureTokenEqual } from '../security/token.js';
import { BrokerError, type McpBroker } from './broker.js';

/**
 * HTTP side of the Model Context Protocol connector for ChatGPT Developer Mode.
 *
 * Unlike `tab2api mcp` (stdio, tools that call INTO the service), this endpoint is the reverse
 * direction the roadmap issue describes: ChatGPT's own connector client POSTs JSON-RPC to
 * `/mcp/<connector key>` — typically through the owner's dedicated tunnel — and the two fixed
 * broker tools resolve every call against a turn-scoped capability token:
 *
 *   - `describe_turn_tools`  { turn_token }                       → the turn's declared tools
 *   - `call_turn_tool`       { turn_token, name, arguments }      → validated dispatch to the
 *                                                                 turn's loopback callback
 *
 * The connector key in the URL is a separate generated secret (`.tab2api/mcp-connector-token`)
 * so the tab2api API keys never leave the loopback trust boundary. Turn tokens do the real
 * authorization inside each call; the key only keeps unsolicited internet traffic away from the
 * JSON-RPC surface. Responses are plain `application/json` — a legal Streamable HTTP choice for
 * a request/response-only server — and notifications answer 202 with no body.
 */

const packageVersion = z
  .looseObject({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version;

export const MCP_CONNECTOR_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const MAX_BATCH = 8;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const connectorKeyParamsSchema = z
  .object({ connectorKey: z.string().regex(/^[A-Za-z0-9_-]{24,512}$/) })
  .strict();

const toolCallParamsSchema = z
  .object({ name: z.string(), arguments: z.unknown().optional() })
  .strict();

const describeArgumentsSchema = z.object({ turn_token: z.string().min(1).max(128) }).strict();

const callArgumentsSchema = z
  .object({
    turn_token: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const CONNECTOR_TOOL_DEFINITIONS = [
  {
    name: 'describe_turn_tools',
    description:
      'List the tools declared for one bound turn. Pass the turn_token from the current conversation; the registry enforces it.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_token: {
          type: 'string',
          description: 'The turn-scoped capability token supplied in the prompt.',
        },
      },
      required: ['turn_token'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_turn_tool',
    description:
      "Execute one declared tool for the bound turn. Arguments must satisfy that tool's declared JSON schema; violations fail without executing anything.",
    inputSchema: {
      type: 'object',
      properties: {
        turn_token: {
          type: 'string',
          description: 'The turn-scoped capability token supplied in the prompt.',
        },
        name: { type: 'string', description: 'Exact declared tool name.' },
        arguments: {
          type: 'object',
          description: 'Arguments validated against the declared input schema.',
        },
      },
      required: ['turn_token', 'name', 'arguments'],
      additionalProperties: false,
    },
  },
] as const;

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function toolText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
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
    : MCP_CONNECTOR_PROTOCOL_VERSION;
}

export class ConnectorMcpHandler {
  constructor(private readonly broker: McpBroker) {}

  /** Handles one decoded JSON-RPC message; null means the message was a notification. */
  async handle(message: JsonRpcRequest): Promise<object | null> {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      const id = message.id === undefined ? null : message.id;
      return id === null ? null : jsonRpcError(id, -32_600, 'Invalid JSON-RPC request.');
    }
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
            serverInfo: { name: 'tab2api-connector', version: packageVersion },
            instructions:
              'Connector for turn-scoped tab2api tools. Call describe_turn_tools with the turn_token from the prompt to read the declared registry, then call_turn_tool to execute one declared tool.',
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: CONNECTOR_TOOL_DEFINITIONS } };
      case 'tools/call':
        return this.callTool(id, params);
      default:
        return jsonRpcError(id, -32_601, `Method not found: ${method}`);
    }
  }

  private async callTool(id: string | number, params: unknown): Promise<object> {
    const parsed = toolCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      return jsonRpcError(id, -32_602, 'tools/call requires a tool name.');
    }
    const { name, arguments: args } = parsed.data;
    try {
      switch (name) {
        case 'describe_turn_tools': {
          const parsedArgs = describeArgumentsSchema.safeParse(args ?? {});
          if (!parsedArgs.success) {
            return jsonRpcError(id, -32_602, 'describe_turn_tools requires a turn_token string.');
          }
          const tools = this.broker.describe(parsedArgs.data.turn_token);
          return { jsonrpc: '2.0', id, result: toolText(JSON.stringify({ tools })) };
        }
        case 'call_turn_tool': {
          const parsedArgs = callArgumentsSchema.safeParse(args ?? {});
          if (!parsedArgs.success) {
            return jsonRpcError(
              id,
              -32_602,
              'call_turn_tool requires turn_token, name, and an arguments object.',
            );
          }
          const text = await this.broker.invoke(
            parsedArgs.data.turn_token,
            parsedArgs.data.name,
            parsedArgs.data.arguments,
          );
          return { jsonrpc: '2.0', id, result: toolText(text) };
        }
        default:
          return jsonRpcError(id, -32_602, `Unknown tool: ${name}`);
      }
    } catch (error) {
      // Capability and dispatch failures are tool results so the model sees the reason and
      // can answer honestly instead of losing the JSON-RPC session.
      const message =
        error instanceof BrokerError || error instanceof AppError
          ? error.message
          : 'Unexpected tool failure.';
      return { jsonrpc: '2.0', id, result: { ...toolText(message), isError: true } };
    }
  }
}

/**
 * Routes `/mcp/:connectorKey`. The connector key is compared in constant time against the
 * generated secret; anything else gets the standard authentication error before any JSON-RPC
 * work happens. GET/DELETE answer 405 because this server never opens event streams.
 */
export function registerConnectorRoutes(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  broker: McpBroker,
  connectorToken: string,
): void {
  const handler = new ConnectorMcpHandler(broker);
  const checkKey = (value: unknown): void => {
    const params = connectorKeyParamsSchema.safeParse(value);
    if (!params.success || !secureTokenEqual(params.data.connectorKey, connectorToken)) {
      throw new AppError('authentication_error', 'A valid connector key is required.');
    }
  };

  app.post('/mcp/:connectorKey', async (request, reply) => {
    checkKey(request.params);
    const body: unknown = request.body;
    const messages = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
    if (messages.length === 0 || messages.length > MAX_BATCH) {
      throw new AppError(
        'invalid_request',
        `A JSON-RPC batch must contain 1-${MAX_BATCH} messages.`,
      );
    }
    const responses: object[] = [];
    for (const message of messages) {
      if (message === null || typeof message !== 'object') {
        responses.push(jsonRpcError(null, -32_600, 'Invalid JSON-RPC request.'));
        continue;
      }
      const response = await handler.handle(message);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) return reply.code(202).send();
    return reply
      .type('application/json')
      .header('cache-control', 'no-store')
      .send(Array.isArray(body) ? responses : responses[0]);
  });

  const rejectStream = async (request: FastifyRequest, reply: FastifyReply) => {
    checkKey(request.params);
    return reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32_601, message: 'This connector answers JSON-RPC POST only.' },
      id: null,
    });
  };
  app.get('/mcp/:connectorKey', rejectStream);
  app.delete('/mcp/:connectorKey', rejectStream);
}
