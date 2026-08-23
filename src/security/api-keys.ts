import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertSafePrivateFile } from './paths.js';
import {
  atomicWritePrivateFile,
  hardenPrivateDirectoryPermissions,
  readPrivateTextFile,
  type PrivateFileWriter,
} from './private-files.js';

const MAX_KEYS = 100;
const MAX_KEY_FILE_BYTES = 524_288;
const MAX_PENDING_KEY_MUTATIONS = 16;
export const apiKeyIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const apiKeyLabelSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u);
export const clientApiTokenSchema = z.string().regex(/^tab2api_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
const keyRecordSchema = z.object({
  id: apiKeyIdSchema,
  label: apiKeyLabelSchema,
  role: z.literal('client'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
});
const keyFileSchema = z
  .object({
    version: z.literal(1),
    keys: z.array(keyRecordSchema).max(MAX_KEYS),
  })
  .refine(({ keys }) => new Set(keys.map(({ id }) => id)).size === keys.length, {
    message: 'API key identifiers must be unique.',
  });

type KeyRecord = z.infer<typeof keyRecordSchema>;
export interface ApiPrincipal {
  id: string;
  label: string;
  role: 'admin' | 'client';
}
export interface ApiKeySummary extends ApiPrincipal {
  createdAt: string;
  revokedAt?: string;
}
export interface CreatedApiKey extends ApiKeySummary {
  token: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function equalDigest(actual: Buffer, expectedHex: string): boolean {
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

export class ApiKeyStore {
  private records = new Map<string, KeyRecord>();
  private mutationTail = Promise.resolve();
  private pendingMutations = 0;

  private constructor(
    private readonly dataDir: string | undefined,
    private readonly filePath: string | undefined,
    private readonly adminTokenDigest: Buffer,
    records: readonly KeyRecord[],
    private readonly writer: PrivateFileWriter,
  ) {
    for (const record of records) this.records.set(record.id, record);
  }

  static memory(adminToken: string): ApiKeyStore {
    return new ApiKeyStore(undefined, undefined, digest(adminToken), [], atomicWritePrivateFile);
  }

  static async load(
    dataDir: string,
    adminToken: string,
    writer: PrivateFileWriter = atomicWritePrivateFile,
  ): Promise<ApiKeyStore> {
    const filePath = path.join(dataDir, 'api-keys.json');
    await assertSafePrivateFile(dataDir, filePath);
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
    } catch {
      throw new AppError('storage_unavailable', 'The API key registry is unavailable.');
    }
    await hardenPrivateDirectoryPermissions(dataDir);
    await assertSafePrivateFile(dataDir, filePath);
    const contents = await readPrivateTextFile(dataDir, filePath, MAX_KEY_FILE_BYTES);
    if (contents === undefined)
      return new ApiKeyStore(dataDir, filePath, digest(adminToken), [], writer);
    try {
      const parsed = keyFileSchema.parse(JSON.parse(contents));
      return new ApiKeyStore(dataDir, filePath, digest(adminToken), parsed.keys, writer);
    } catch (error) {
      throw new Error('The API key registry is invalid or unreadable.', { cause: error });
    }
  }

  authenticate(token: string): ApiPrincipal | undefined {
    const presented = digest(token);
    if (timingSafeEqual(presented, this.adminTokenDigest))
      return { id: 'local-admin', label: 'Local administrator', role: 'admin' };
    for (const record of this.records.values()) {
      if (record.revokedAt === undefined && equalDigest(presented, record.digest))
        return { id: record.id, label: record.label, role: record.role };
    }
    return undefined;
  }

  async create(label: string): Promise<CreatedApiKey> {
    const normalized = label.trim();
    if (!apiKeyLabelSchema.safeParse(normalized).success)
      throw new Error('API key label must contain 1-80 visible characters.');
    return this.enqueue(async () => {
      const candidate = new Map(this.records);
      if (candidate.size >= MAX_KEYS) {
        const oldestRevoked = [...candidate.values()]
          .filter((record) => record.revokedAt !== undefined)
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )[0];
        if (oldestRevoked === undefined)
          throw new Error(`At most ${MAX_KEYS} active API keys are allowed.`);
        candidate.delete(oldestRevoked.id);
      }
      const id = randomBytes(8).toString('hex');
      if (candidate.has(id)) throw new Error('Could not allocate a unique API key identifier.');
      const token = `tab2api_${id}_${randomBytes(32).toString('base64url')}`;
      const record: KeyRecord = {
        id,
        label: normalized,
        role: 'client',
        digest: digest(token).toString('hex'),
        createdAt: new Date().toISOString(),
      };
      candidate.set(id, record);
      await this.persist(candidate);
      this.records = candidate;
      return { id, label: record.label, role: record.role, createdAt: record.createdAt, token };
    });
  }

  list(): ApiKeySummary[] {
    return [
      {
        id: 'local-admin',
        label: 'Local administrator',
        role: 'admin',
        createdAt: 'runtime',
      },
      ...Array.from(this.records.values(), (record) => ({
        id: record.id,
        label: record.label,
        role: record.role,
        createdAt: record.createdAt,
        ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      })),
    ];
  }

  async revoke(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const record = this.records.get(id);
      if (record === undefined || record.revokedAt !== undefined) return false;
      const candidate = new Map(this.records);
      candidate.set(id, { ...record, revokedAt: new Date().toISOString() });
      await this.persist(candidate);
      this.records = candidate;
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.mutationTail;
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.pendingMutations >= MAX_PENDING_KEY_MUTATIONS) {
      return Promise.reject(
        new AppError('queue_full', 'The private API-key mutation queue is full.'),
      );
    }
    this.pendingMutations += 1;
    const result = this.mutationTail.then(mutation);
    // A failed durable mutation is returned to its caller but must not poison later retries.
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

  private async persist(records: ReadonlyMap<string, KeyRecord>): Promise<void> {
    const payload = keyFileSchema.parse({ version: 1, keys: [...records.values()] });
    if (this.dataDir === undefined || this.filePath === undefined) return;
    const snapshot = JSON.stringify(payload, null, 2);
    await this.writer(this.dataDir, this.filePath, `${snapshot}\n`);
  }
}
