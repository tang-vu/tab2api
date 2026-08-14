import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const MAX_KEYS = 100;
const keyRecordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  label: z.string().min(1).max(80),
  role: z.literal('client'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
});
const keyFileSchema = z.object({
  version: z.literal(1),
  keys: z.array(keyRecordSchema).max(MAX_KEYS),
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
  private readonly records = new Map<string, KeyRecord>();
  private writeChain = Promise.resolve();

  private constructor(
    private readonly filePath: string | undefined,
    private readonly adminTokenDigest: Buffer,
    records: readonly KeyRecord[],
  ) {
    for (const record of records) this.records.set(record.id, record);
  }

  static memory(adminToken: string): ApiKeyStore {
    return new ApiKeyStore(undefined, digest(adminToken), []);
  }

  static async load(dataDir: string, adminToken: string): Promise<ApiKeyStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dataDir, 'api-keys.json');
    try {
      const parsed = keyFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
      await chmod(filePath, 0o600).catch(() => undefined);
      return new ApiKeyStore(filePath, digest(adminToken), parsed.keys);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return new ApiKeyStore(filePath, digest(adminToken), []);
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
    if (normalized.length < 1 || normalized.length > 80)
      throw new Error('API key label must contain 1-80 characters.');
    if (this.records.size >= MAX_KEYS) throw new Error(`At most ${MAX_KEYS} API keys are allowed.`);
    const id = randomBytes(8).toString('hex');
    const token = `tab2api_${id}_${randomBytes(32).toString('base64url')}`;
    const record: KeyRecord = {
      id,
      label: normalized,
      role: 'client',
      digest: digest(token).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.records.set(id, record);
    await this.persist();
    return { id, label: record.label, role: record.role, createdAt: record.createdAt, token };
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
    const record = this.records.get(id);
    if (record === undefined || record.revokedAt !== undefined) return false;
    record.revokedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async persist(): Promise<void> {
    if (this.filePath === undefined) return;
    const snapshot = JSON.stringify({ version: 1, keys: [...this.records.values()] }, null, 2);
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
