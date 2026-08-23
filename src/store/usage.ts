import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { ApiPrincipal } from '../security/api-keys.js';
import { assertSafePrivateFile } from '../security/paths.js';
import {
  atomicWritePrivateFile,
  hardenPrivateDirectoryPermissions,
  readPrivateTextFile,
  type PrivateFileWriter,
} from '../security/private-files.js';

const MAX_USAGE_FILE_BYTES = 2_097_152;
const MAX_USAGE_KEYS = 101;
const MAX_USAGE_ENDPOINTS = 64;
const MAX_PENDING_USAGE_MUTATIONS = 128;
const LATENCY_TOTAL_EPSILON_MS = 0.001;
const boundedCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageKeyId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const usageEndpoint = z
  .string()
  .min(1)
  .max(160)
  .regex(/^\/[A-Za-z0-9._~:/-]+$/);
const usageLabel = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u);

export const endpointUsageSchema = z
  .object({
    requests: boundedCounter,
    successful: boundedCounter,
    failed: boundedCounter,
    estimatedInputTokens: boundedCounter,
    estimatedOutputTokens: boundedCounter,
    inputBytes: boundedCounter,
    outputBytes: boundedCounter,
    totalLatencyMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(({ requests, successful, failed }) => requests === successful + failed, {
    message: 'Usage success and failure counters must equal total requests.',
  });
export const keyUsageSchema = endpointUsageSchema
  .safeExtend({
    keyId: usageKeyId,
    label: usageLabel,
    lastUsedAt: z.iso.datetime(),
    endpoints: z
      .record(usageEndpoint, endpointUsageSchema)
      .refine((endpoints) => Object.keys(endpoints).length <= MAX_USAGE_ENDPOINTS, {
        message: 'Too many usage endpoints.',
      }),
  })
  .refine((usage) => {
    const totals = Object.values(usage.endpoints).reduce(
      (sum, endpoint) => ({
        requests: sum.requests + endpoint.requests,
        successful: sum.successful + endpoint.successful,
        failed: sum.failed + endpoint.failed,
        estimatedInputTokens: sum.estimatedInputTokens + endpoint.estimatedInputTokens,
        estimatedOutputTokens: sum.estimatedOutputTokens + endpoint.estimatedOutputTokens,
        inputBytes: sum.inputBytes + endpoint.inputBytes,
        outputBytes: sum.outputBytes + endpoint.outputBytes,
        totalLatencyMs: sum.totalLatencyMs + endpoint.totalLatencyMs,
      }),
      emptyUsage(),
    );
    return (
      totals.requests === usage.requests &&
      totals.successful === usage.successful &&
      totals.failed === usage.failed &&
      totals.estimatedInputTokens === usage.estimatedInputTokens &&
      totals.estimatedOutputTokens === usage.estimatedOutputTokens &&
      totals.inputBytes === usage.inputBytes &&
      totals.outputBytes === usage.outputBytes &&
      Math.abs(totals.totalLatencyMs - usage.totalLatencyMs) <= LATENCY_TOTAL_EPSILON_MS
    );
  }, 'Per-key usage counters must equal the endpoint totals.');
const usageFileSchema = z
  .object({
    version: z.literal(1),
    keys: z
      .record(usageKeyId, keyUsageSchema)
      .refine((keys) => Object.keys(keys).length <= MAX_USAGE_KEYS, {
        message: 'Too many usage keys.',
      }),
  })
  .refine(({ keys }) => Object.entries(keys).every(([id, usage]) => id === usage.keyId), {
    message: 'Usage record keys must match their embedded key identifiers.',
  });

export type EndpointUsage = z.infer<typeof endpointUsageSchema>;
export type KeyUsage = z.infer<typeof keyUsageSchema>;
export const usageSnapshotSchema = z.object({
  tokenCounts: z.literal('estimated'),
  keys: z.array(keyUsageSchema).max(MAX_USAGE_KEYS),
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export interface UsageDelta {
  endpoint: string;
  successful: boolean;
  latencyMs: number;
  inputText?: string;
  outputText?: string;
  inputBytes?: number;
  outputBytes?: number;
}

function emptyUsage(): EndpointUsage {
  return {
    requests: 0,
    successful: 0,
    failed: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    inputBytes: 0,
    outputBytes: 0,
    totalLatencyMs: 0,
  };
}

// ChatGPT Web exposes no authoritative usage. This is deliberately labelled an estimate.
export function estimateTokens(text: string | undefined): number {
  if (text === undefined || text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function add(target: EndpointUsage, delta: UsageDelta): void {
  target.requests += 1;
  target.successful += delta.successful ? 1 : 0;
  target.failed += delta.successful ? 0 : 1;
  target.estimatedInputTokens += estimateTokens(delta.inputText);
  target.estimatedOutputTokens += estimateTokens(delta.outputText);
  target.inputBytes += delta.inputBytes ?? 0;
  target.outputBytes += delta.outputBytes ?? 0;
  target.totalLatencyMs += Math.max(0, Math.round(delta.latencyMs));
}

export class UsageStore {
  private entries = new Map<string, KeyUsage>();
  private mutationTail = Promise.resolve();
  private pendingMutations = 0;

  private constructor(
    private readonly dataDir: string | undefined,
    private readonly filePath: string | undefined,
    entries: Record<string, KeyUsage>,
    private readonly writer: PrivateFileWriter,
  ) {
    for (const [id, usage] of Object.entries(entries)) this.entries.set(id, usage);
  }

  static memory(): UsageStore {
    return new UsageStore(undefined, undefined, {}, atomicWritePrivateFile);
  }

  static async load(
    dataDir: string,
    writer: PrivateFileWriter = atomicWritePrivateFile,
  ): Promise<UsageStore> {
    const filePath = path.join(dataDir, 'usage.json');
    await assertSafePrivateFile(dataDir, filePath);
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
    } catch {
      throw new AppError('storage_unavailable', 'The usage statistics store is unavailable.');
    }
    await hardenPrivateDirectoryPermissions(dataDir);
    await assertSafePrivateFile(dataDir, filePath);
    const contents = await readPrivateTextFile(dataDir, filePath, MAX_USAGE_FILE_BYTES);
    if (contents === undefined) return new UsageStore(dataDir, filePath, {}, writer);
    try {
      const parsed = usageFileSchema.parse(JSON.parse(contents));
      return new UsageStore(dataDir, filePath, parsed.keys, writer);
    } catch (error) {
      throw new Error('The usage statistics file is invalid or unreadable.', { cause: error });
    }
  }

  async record(principal: ApiPrincipal, delta: UsageDelta): Promise<void> {
    const endpointName = usageEndpoint.parse(delta.endpoint);
    const principalId = usageKeyId.parse(principal.id);
    const principalLabel = usageLabel.parse(principal.label);
    await this.enqueue(async () => {
      const candidate = new Map(
        [...this.entries].map(([id, usage]) => [id, structuredClone(usage)] as const),
      );
      let usage = candidate.get(principalId);
      if (usage === undefined) {
        if (candidate.size >= MAX_USAGE_KEYS) {
          const oldestClient = [...candidate.values()]
            .filter(({ keyId }) => keyId !== 'local-admin')
            .sort(
              (left, right) =>
                left.lastUsedAt.localeCompare(right.lastUsedAt) ||
                left.keyId.localeCompare(right.keyId),
            )[0];
          if (oldestClient === undefined) {
            throw new AppError('queue_full', 'The bounded usage registry is full.');
          }
          candidate.delete(oldestClient.keyId);
        }
        usage = {
          ...emptyUsage(),
          keyId: principalId,
          label: principalLabel,
          lastUsedAt: new Date().toISOString(),
          endpoints: {},
        };
        candidate.set(principalId, usage);
      }
      usage.label = principalLabel;
      usage.lastUsedAt = new Date().toISOString();
      add(usage, delta);
      const endpoint = (usage.endpoints[endpointName] ??= emptyUsage());
      add(endpoint, delta);
      await this.persist(candidate);
      this.entries = candidate;
    });
  }

  snapshot(): UsageSnapshot {
    return {
      tokenCounts: 'estimated',
      keys: structuredClone([...this.entries.values()]),
    };
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      const candidate = new Map<string, KeyUsage>();
      await this.persist(candidate);
      this.entries = candidate;
    });
  }

  async flush(): Promise<void> {
    await this.mutationTail;
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.pendingMutations >= MAX_PENDING_USAGE_MUTATIONS) {
      return Promise.reject(
        new AppError('queue_full', 'The private usage mutation queue is full.'),
      );
    }
    this.pendingMutations += 1;
    const result = this.mutationTail.then(mutation);
    // Failed persistence is observable to that request while later mutations can still retry.
    this.mutationTail = result.then(
      () => {
        this.pendingMutations -= 1;
      },
      () => {
        this.pendingMutations -= 1;
      },
    );
    return result;
  }

  private async persist(entries: ReadonlyMap<string, KeyUsage>): Promise<void> {
    const payload = usageFileSchema.parse({ version: 1, keys: Object.fromEntries(entries) });
    if (this.dataDir === undefined || this.filePath === undefined) return;
    const snapshot = JSON.stringify(payload, null, 2);
    await this.writer(this.dataDir, this.filePath, `${snapshot}\n`);
  }
}
