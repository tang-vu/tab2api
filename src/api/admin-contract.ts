import { z } from 'zod';
import { apiKeyIdSchema, apiKeyLabelSchema, clientApiTokenSchema } from '../security/api-keys.js';
import { usageSnapshotSchema } from '../store/usage.js';

export const healthResponseSchema = z
  .object({ status: z.literal('ok'), service: z.literal('tab2api') })
  .strict();

const adminKeySummarySchema = z
  .object({
    id: z.literal('local-admin'),
    label: z.literal('Local administrator'),
    role: z.literal('admin'),
    createdAt: z.literal('runtime'),
  })
  .strict();

const clientKeySummarySchema = z
  .object({
    id: apiKeyIdSchema,
    label: apiKeyLabelSchema,
    role: z.literal('client'),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().optional(),
  })
  .strict();

export const apiKeyListResponseSchema = z
  .object({
    data: z
      .array(z.discriminatedUnion('role', [adminKeySummarySchema, clientKeySummarySchema]))
      .max(101),
  })
  .strict()
  .refine(
    ({ data }) =>
      data[0]?.role === 'admin' &&
      data.slice(1).every(({ role }) => role === 'client') &&
      new Set(data.map(({ id }) => id)).size === data.length,
    'API key metadata must contain one leading administrator and unique client records.',
  );

export const apiKeyCreateRequestSchema = z
  .object({
    label: z
      .string()
      .transform((label) => label.trim())
      .pipe(apiKeyLabelSchema),
  })
  .strict();

export const createdApiKeyResponseSchema = clientKeySummarySchema
  .omit({ revokedAt: true })
  .extend({ token: clientApiTokenSchema })
  .strict()
  .refine(
    ({ id, token }) => token.startsWith(`tab2api_${id}_`),
    'Created API key token must match its identifier.',
  );

export const apiKeyRevokeResponseSchema = z
  .object({ status: z.literal('revoked'), id: apiKeyIdSchema })
  .strict();

export const apiKeyParamsSchema = z.object({ id: apiKeyIdSchema }).strict();

export const usageResponseSchema = usageSnapshotSchema;

export const usageResetResponseSchema = z
  .object({ status: z.literal('reset'), tokenCounts: z.literal('estimated') })
  .strict();

export const sessionResetResponseSchema = z
  .object({
    status: z.literal('reset'),
    detail: z.literal('Browser process closed; dedicated profile data was preserved.'),
  })
  .strict();

export const drainStatusResponseSchema = z
  .object({
    draining: z.boolean(),
    pending: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    active: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const sessionStateResponseSchema = z
  .object({
    state: z.enum([
      'ready',
      'login_required',
      'security_challenge',
      'generation_in_progress',
      'rate_limited',
      'ui_changed',
      'browser_disconnected',
    ]),
  })
  .strict();

/**
 * MCP broker turn contracts. A turn registers a declared tool allowlist plus the loopback
 * callback that executes calls; the issued `turn_token` is the single-use capability the
 * model presents through the connector. Input schemas use the documented JSON Schema subset —
 * unsupported keywords are rejected rather than silently ignored.
 */
export const mcpTurnToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    description: z.string().min(1).max(4_096).optional(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const mcpTurnCreateRequestSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    tools: z.array(mcpTurnToolSchema).min(1).max(32),
    callback_url: z.string().min(1).max(512),
    callback_token: z.string().min(1).max(512).optional(),
    ttl_seconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export const mcpTurnSummarySchema = z
  .object({
    id: apiKeyIdSchema,
    label: z.string().min(1).max(80).optional(),
    state: z.enum(['issued', 'bound']),
    tools: z.number().int().min(1).max(32),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const mcpTurnListResponseSchema = z
  .object({ data: z.array(mcpTurnSummarySchema).max(256) })
  .strict();

export const mcpTurnCreateResponseSchema = z
  .object({
    id: apiKeyIdSchema,
    turn_token: z.string().regex(/^t2m_[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    tools: z.number().int().min(1).max(32),
  })
  .strict();

export const mcpTurnRevokeResponseSchema = z
  .object({ status: z.literal('revoked'), id: apiKeyIdSchema })
  .strict();

export const mcpTurnParamsSchema = z.object({ id: apiKeyIdSchema }).strict();

export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;
export type CreatedApiKeyResponse = z.infer<typeof createdApiKeyResponseSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export type DrainStatusResponse = z.infer<typeof drainStatusResponseSchema>;
export type SessionStateResponse = z.infer<typeof sessionStateResponseSchema>;
export type McpTurnCreateRequest = z.infer<typeof mcpTurnCreateRequestSchema>;
export type McpTurnCreateResponse = z.infer<typeof mcpTurnCreateResponseSchema>;
export type McpTurnListResponse = z.infer<typeof mcpTurnListResponseSchema>;
