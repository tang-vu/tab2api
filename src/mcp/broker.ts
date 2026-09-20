import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import {
  assertLoopbackCallbackUrl,
  dispatchToolCallback,
  ToolCallbackError,
  type CallbackFetch,
} from './callback.js';
import { assertSupportedToolSchema, validateToolArguments } from './schema.js';

/**
 * Turn-scoped capability broker for the ChatGPT Developer Mode connector.
 *
 * A caller registers a *turn*: a declared tool allowlist (name, description, JSON schema) plus
 * the loopback webhook that executes declared calls. Registration issues a single-use
 * `t2m_` capability token. The token becomes *bound* when a generation request presents it
 * (`mcp_turn_token`), is revoked when that request finishes, and expires with the turn TTL —
 * a later request can neither replay nor widen it, which is the capability contract the
 * connector relies on. Drain blocks new registrations and revokes unbound turns; shutdown
 * aborts every pending call so no connector request can outlive the service.
 *
 * Only metadata (id, label, counts, timestamps) is ever listed; tokens and callback
 * coordinates are returned once at registration and never re-exposed.
 */

export const MCP_TURN_TOKEN_PATTERN = /^t2m_[A-Za-z0-9_-]{43}$/;
const MCP_TURN_ID_PATTERN = /^[a-f0-9]{16}$/;
export const MAX_TURN_TOOLS = 32;
export const MAX_TURN_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_TURN_TOOL_DESCRIPTION = 4_096;
export const MAX_TURN_LABEL = 80;
export const MAX_CALLBACK_TOKEN = 512;

export type TurnState = 'issued' | 'bound';

export interface BrokerToolDeclaration {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisterTurnInput {
  principalId: string;
  label?: string;
  tools: readonly BrokerToolDeclaration[];
  callbackUrl: string;
  callbackToken?: string;
  ttlMs?: number;
}

export interface CreatedTurn {
  id: string;
  turnToken: string;
  expiresAt: string;
  tools: number;
}

export interface TurnSummary {
  id: string;
  label?: string;
  state: TurnState;
  tools: number;
  createdAt: string;
  expiresAt: string;
}

export class BrokerError extends Error {
  constructor(
    readonly kind:
      | 'invalid_token'
      | 'not_bound'
      | 'unknown_tool'
      | 'invalid_arguments'
      | 'unavailable'
      | 'rejected'
      | 'timeout'
      | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

interface PendingCall {
  controller: AbortController;
  tool: string;
}

interface TurnRecord {
  id: string;
  token: string;
  principalId: string;
  label: string | undefined;
  tools: Map<string, { description: string | undefined; inputSchema: Record<string, unknown> }>;
  callbackUrl: string;
  callbackToken: string | undefined;
  createdAt: number;
  expiresAt: number;
  bound: boolean;
  pending: Map<string, PendingCall>;
}

export interface McpBrokerOptions {
  maxTurns?: number;
  maxTurnTtlMs?: number;
  toolTimeoutMs?: number;
  sweepIntervalMs?: number;
  fetchImplementation?: CallbackFetch;
}

export class McpBroker {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly maxTurns: number;
  private readonly maxTurnTtlMs: number;
  private readonly toolTimeoutMs: number;
  private readonly fetchImplementation: CallbackFetch | undefined;
  private readonly sweeper: NodeJS.Timeout;
  private draining = false;
  private closed = false;

  constructor(options: McpBrokerOptions = {}) {
    this.maxTurns = options.maxTurns ?? 32;
    this.maxTurnTtlMs = options.maxTurnTtlMs ?? 3_600_000;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    for (const [name, value] of [
      ['maxTurns', this.maxTurns],
      ['maxTurnTtlMs', this.maxTurnTtlMs],
      ['toolTimeoutMs', this.toolTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`McpBroker option ${name} must be a positive integer.`);
    }
    this.fetchImplementation = options.fetchImplementation;
    this.sweeper = setInterval(
      () => this.expireBefore(Date.now()),
      options.sweepIntervalMs ?? 15_000,
    );
    this.sweeper.unref();
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get size(): number {
    return this.turns.size;
  }

  register(input: RegisterTurnInput): CreatedTurn {
    if (this.closed) throw new AppError('cancelled', 'The service is shutting down.');
    if (this.draining)
      throw new AppError(
        'draining',
        'The service is draining for a lifecycle operation and is not accepting tool turns.',
      );
    this.expireBefore(Date.now());
    if (this.turns.size >= this.maxTurns) {
      throw new AppError('queue_full', 'The MCP turn registry is full; revoke idle turns first.');
    }
    if (input.tools.length < 1 || input.tools.length > MAX_TURN_TOOLS) {
      throw new AppError(
        'invalid_request',
        `A turn declares between 1 and ${MAX_TURN_TOOLS} tools.`,
      );
    }
    const tools = new Map<
      string,
      { description: string | undefined; inputSchema: Record<string, unknown> }
    >();
    for (const tool of input.tools) {
      if (!MAX_TURN_TOOL_NAME.test(tool.name)) {
        throw new AppError('invalid_request', `Tool name "${tool.name}" is invalid.`);
      }
      if (tools.has(tool.name)) {
        throw new AppError('invalid_request', `Tool "${tool.name}" is declared twice.`);
      }
      if (tool.description !== undefined && tool.description.length > MAX_TURN_TOOL_DESCRIPTION) {
        throw new AppError(
          'invalid_request',
          `Tool "${tool.name}" description exceeds ${MAX_TURN_TOOL_DESCRIPTION} characters.`,
        );
      }
      const inputSchema = assertSupportedToolSchema(tool.inputSchema, tool.name);
      tools.set(tool.name, { description: tool.description, inputSchema });
    }
    const callbackUrl = assertLoopbackCallbackUrl(input.callbackUrl);
    if (input.callbackToken !== undefined && input.callbackToken.length > MAX_CALLBACK_TOKEN) {
      throw new AppError('invalid_request', 'The tool callback token exceeds 512 characters.');
    }
    if (input.label !== undefined && input.label.length > MAX_TURN_LABEL) {
      throw new AppError('invalid_request', `The turn label exceeds ${MAX_TURN_LABEL} characters.`);
    }
    const ttlMs = input.ttlMs ?? this.maxTurnTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > this.maxTurnTtlMs) {
      throw new AppError(
        'invalid_request',
        `Turn ttl_seconds must map to between 60 seconds and ${this.maxTurnTtlMs} ms.`,
      );
    }
    const id = randomBytes(8).toString('hex');
    if (this.turns.has(id)) {
      throw new AppError('queue_full', 'Could not allocate a unique turn identifier.');
    }
    const record: TurnRecord = {
      id,
      token: `t2m_${randomBytes(32).toString('base64url')}`,
      principalId: input.principalId,
      label: input.label,
      tools,
      callbackUrl,
      callbackToken: input.callbackToken,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      bound: false,
      pending: new Map(),
    };
    this.turns.set(id, record);
    return {
      id,
      turnToken: record.token,
      expiresAt: new Date(record.expiresAt).toISOString(),
      tools: tools.size,
    };
  }

  /**
   * Single-use binding: the first live generation request presenting the token claims it.
   * Re-presenting a bound, expired, or unknown token fails closed, so a connector call can
   * never be authorized by a stale capability.
   */
  bind(token: string): void {
    const record = this.liveByToken(token);
    if (record === undefined) {
      throw new AppError('invalid_request', 'The MCP turn token is invalid or expired.');
    }
    if (record.bound) {
      throw new AppError(
        'invalid_request',
        'The MCP turn token is already bound to another request; register a new turn.',
      );
    }
    record.bound = true;
  }

  /** Ends the turn that a bound request authorized; pending calls are aborted. */
  release(token: string): void {
    const record = this.recordByToken(token);
    if (record === undefined) return;
    this.revokeRecord(record, 'The generation turn ended.');
  }

  async invoke(token: string, name: string, args: unknown): Promise<string> {
    const record = this.liveByToken(token);
    if (record === undefined) {
      throw new BrokerError('invalid_token', 'The turn token is invalid, expired, or revoked.');
    }
    if (!record.bound) {
      throw new BrokerError(
        'not_bound',
        'The turn token is registered but not bound to a running generation turn.',
      );
    }
    const tool = record.tools.get(name);
    if (tool === undefined) {
      throw new BrokerError('unknown_tool', `"${name}" is not declared for this turn.`);
    }
    const errors = validateToolArguments(tool.inputSchema, args);
    if (errors.length > 0) {
      throw new BrokerError(
        'invalid_arguments',
        `Arguments rejected by the declared schema: ${errors.join('; ')}`,
      );
    }
    const callId = `call_${randomUUID().replaceAll('-', '')}`;
    const controller = new AbortController();
    const remainingMs = Math.max(1, record.expiresAt - Date.now());
    const timeoutSignal = AbortSignal.timeout(Math.min(this.toolTimeoutMs, remainingMs));
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    const pending: PendingCall = { controller, tool: name };
    record.pending.set(callId, pending);
    try {
      return await dispatchToolCallback({
        url: record.callbackUrl,
        bearerToken: record.callbackToken,
        payload: {
          turn_id: record.id,
          call_id: callId,
          tool: name,
          arguments: args as Record<string, unknown>,
        },
        signal,
        ...(this.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: this.fetchImplementation }),
      });
    } catch (error) {
      if (error instanceof ToolCallbackError) {
        throw new BrokerError(
          error.kind === 'rejected'
            ? 'rejected'
            : error.kind === 'timeout'
              ? 'timeout'
              : error.kind === 'cancelled'
                ? 'cancelled'
                : 'unavailable',
          error.message,
        );
      }
      throw new BrokerError('unavailable', 'The tool callback failed unexpectedly.');
    } finally {
      record.pending.delete(callId);
    }
  }

  describe(token: string): { name: string; description?: string; inputSchema: unknown }[] {
    const record = this.liveByToken(token);
    if (record === undefined) {
      throw new BrokerError('invalid_token', 'The turn token is invalid, expired, or revoked.');
    }
    if (!record.bound) {
      throw new BrokerError(
        'not_bound',
        'The turn token is registered but not bound to a running generation turn.',
      );
    }
    return [...record.tools.entries()].map(([name, tool]) => ({
      name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    }));
  }

  list(): TurnSummary[] {
    return [...this.turns.values()].map((record) => ({
      id: record.id,
      ...(record.label === undefined ? {} : { label: record.label }),
      state: record.bound ? 'bound' : 'issued',
      tools: record.tools.size,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    }));
  }

  /** Revokes one turn by id (administrative); returns false when it does not exist. */
  revoke(id: string): boolean {
    if (!MCP_TURN_ID_PATTERN.test(id)) return false;
    const record = this.turns.get(id);
    if (record === undefined) return false;
    this.revokeRecord(record, 'The turn was revoked.');
    return true;
  }

  /** Stops new registrations and revokes turns that were never bound to a request. */
  beginDrain(): void {
    this.draining = true;
    for (const record of [...this.turns.values()]) {
      if (!record.bound) this.revokeRecord(record, 'The service is draining.');
    }
  }

  endDrain(): void {
    this.draining = false;
  }

  /** Shutdown: every pending call aborts and every token dies with the process. */
  close(): void {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const record of [...this.turns.values()]) {
      this.revokeRecord(record, 'The service is shutting down.');
    }
  }

  private recordByToken(token: string): TurnRecord | undefined {
    if (!MCP_TURN_TOKEN_PATTERN.test(token)) return undefined;
    for (const record of this.turns.values()) {
      if (record.token === token) return record;
    }
    return undefined;
  }

  private liveByToken(token: string): TurnRecord | undefined {
    const record = this.recordByToken(token);
    if (record === undefined) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.revokeRecord(record, 'The turn expired.');
      return undefined;
    }
    return record;
  }

  private revokeRecord(record: TurnRecord, reason: string): void {
    this.turns.delete(record.id);
    for (const pending of record.pending.values()) {
      pending.controller.abort(new AppError('cancelled', reason));
    }
    record.pending.clear();
  }

  private expireBefore(now: number): void {
    for (const record of [...this.turns.values()]) {
      if (record.expiresAt <= now) this.revokeRecord(record, 'The turn expired.');
    }
  }
}

export const mcpTurnTokenSchema = z.string().regex(MCP_TURN_TOKEN_PATTERN);
