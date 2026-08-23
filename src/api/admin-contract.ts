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

export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;
export type CreatedApiKeyResponse = z.infer<typeof createdApiKeyResponseSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
