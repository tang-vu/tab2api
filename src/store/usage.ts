import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ApiPrincipal } from '../security/api-keys.js';

const endpointUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  successful: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  totalLatencyMs: z.number().nonnegative(),
});
const keyUsageSchema = endpointUsageSchema.extend({
  keyId: z.string(),
  label: z.string(),
  lastUsedAt: z.iso.datetime(),
  endpoints: z.record(z.string(), endpointUsageSchema),
});
const usageFileSchema = z.object({
  version: z.literal(1),
  keys: z.record(z.string(), keyUsageSchema),
});

export type EndpointUsage = z.infer<typeof endpointUsageSchema>;
export type KeyUsage = z.infer<typeof keyUsageSchema>;
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
  target.totalLatencyMs += Math.max(0, delta.latencyMs);
}

export class UsageStore {
  private readonly entries = new Map<string, KeyUsage>();
  private writeChain = Promise.resolve();

  private constructor(
    private readonly filePath: string | undefined,
    entries: Record<string, KeyUsage>,
  ) {
    for (const [id, usage] of Object.entries(entries)) this.entries.set(id, usage);
  }

  static memory(): UsageStore {
    return new UsageStore(undefined, {});
  }

  static async load(dataDir: string): Promise<UsageStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dataDir, 'usage.json');
    try {
      const parsed = usageFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
      await chmod(filePath, 0o600).catch(() => undefined);
      return new UsageStore(filePath, parsed.keys);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return new UsageStore(filePath, {});
      throw new Error('The usage statistics file is invalid or unreadable.', { cause: error });
    }
  }

  async record(principal: ApiPrincipal, delta: UsageDelta): Promise<void> {
    let usage = this.entries.get(principal.id);
    if (usage === undefined) {
      usage = {
        ...emptyUsage(),
        keyId: principal.id,
        label: principal.label,
        lastUsedAt: new Date().toISOString(),
        endpoints: {},
      };
      this.entries.set(principal.id, usage);
    }
    usage.label = principal.label;
    usage.lastUsedAt = new Date().toISOString();
    add(usage, delta);
    const endpoint = (usage.endpoints[delta.endpoint] ??= emptyUsage());
    add(endpoint, delta);
    await this.persist();
  }

  snapshot(): { tokenCounts: 'estimated'; keys: KeyUsage[] } {
    return {
      tokenCounts: 'estimated',
      keys: structuredClone([...this.entries.values()]),
    };
  }

  async reset(): Promise<void> {
    this.entries.clear();
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async persist(): Promise<void> {
    if (this.filePath === undefined) return;
    const snapshot = JSON.stringify(
      { version: 1, keys: Object.fromEntries(this.entries) },
      null,
      2,
    );
    const target = this.filePath;
    const temporary = `${target}.${process.pid}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600).catch(() => undefined);
    });
    await this.writeChain;
  }
}
