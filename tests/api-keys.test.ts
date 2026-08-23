import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { ApiKeyStore } from '../src/security/api-keys.js';
import { atomicWritePrivateFile, type PrivateFileWriter } from '../src/security/private-files.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('API key registry', () => {
  it('persists only key digests and keeps the legacy token as administrator', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-keys-'));
    temporaryDirectories.push(directory);
    const admin = 'test-admin-token-that-is-long-enough';
    const store = await ApiKeyStore.load(directory, admin);
    const created = await store.create('Remote laptop');
    expect(store.authenticate(admin)?.role).toBe('admin');
    expect(store.authenticate(created.token)).toMatchObject({
      id: created.id,
      label: 'Remote laptop',
      role: 'client',
    });
    const persisted = await readFile(path.join(directory, 'api-keys.json'), 'utf8');
    expect(persisted).not.toContain(created.token);
    expect(persisted).not.toContain(admin);
    const reloaded = await ApiKeyStore.load(directory, admin);
    expect(reloaded.authenticate(created.token)?.id).toBe(created.id);
  });

  it('rejects control characters in human-facing key labels', async () => {
    const store = ApiKeyStore.memory('test-admin-token-that-is-long-enough');
    await expect(store.create('trusted\u001b[2Jdevice')).rejects.toThrow(/visible characters/);
    expect(store.list()).toHaveLength(1);
  });

  it('rolls back a failed create and permits the next durable retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-keys-'));
    temporaryDirectories.push(directory);
    let writes = 0;
    const writer: PrivateFileWriter = async (...arguments_) => {
      writes += 1;
      if (writes === 1) throw new AppError('storage_unavailable', 'simulated failure');
      await atomicWritePrivateFile(...arguments_);
    };
    const admin = 'test-admin-token-that-is-long-enough';
    const store = await ApiKeyStore.load(directory, admin, writer);

    await expect(store.create('First attempt')).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(store.list()).toHaveLength(1);

    const created = await store.create('Second attempt');
    expect(store.authenticate(created.token)?.id).toBe(created.id);
    expect((await ApiKeyStore.load(directory, admin)).authenticate(created.token)?.id).toBe(
      created.id,
    );
  });

  it('keeps a key active when revocation cannot be persisted', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-keys-'));
    temporaryDirectories.push(directory);
    let writes = 0;
    const writer: PrivateFileWriter = async (...arguments_) => {
      writes += 1;
      if (writes === 2) throw new AppError('storage_unavailable', 'simulated failure');
      await atomicWritePrivateFile(...arguments_);
    };
    const store = await ApiKeyStore.load(directory, 'test-admin-token-that-is-long-enough', writer);
    const created = await store.create('Laptop');

    await expect(store.revoke(created.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(store.authenticate(created.token)?.id).toBe(created.id);
    expect(store.list().find(({ id }) => id === created.id)?.revokedAt).toBeUndefined();
    await expect(store.revoke(created.id)).resolves.toBe(true);
    expect(store.authenticate(created.token)).toBeUndefined();
  });

  it('prunes the oldest revoked record instead of exhausting lifetime key rotation', async () => {
    const store = ApiKeyStore.memory('test-admin-token-that-is-long-enough');
    const revokedIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const created = await store.create(`Device ${index}`);
      revokedIds.push(created.id);
      await store.revoke(created.id);
    }
    const replacement = await store.create('Replacement device');
    const retainedIds = new Set(store.list().map(({ id }) => id));

    expect(store.list()).toHaveLength(101);
    expect(revokedIds.filter((id) => !retainedIds.has(id))).toHaveLength(1);
    expect(store.authenticate(replacement.token)?.id).toBe(replacement.id);
  });

  it('rejects duplicate identifiers in a persisted registry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-keys-'));
    temporaryDirectories.push(directory);
    const duplicate = {
      id: '0123456789abcdef',
      label: 'Duplicate',
      role: 'client',
      digest: 'a'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z',
    };
    await writeFile(
      path.join(directory, 'api-keys.json'),
      JSON.stringify({ version: 1, keys: [duplicate, duplicate] }),
      { mode: 0o600 },
    );

    await expect(
      ApiKeyStore.load(directory, 'test-admin-token-that-is-long-enough'),
    ).rejects.toThrow(/invalid or unreadable/);
  });

  it('bounds queued durable key mutations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-keys-'));
    temporaryDirectories.push(directory);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer: PrivateFileWriter = async () => gate;
    const store = await ApiKeyStore.load(directory, 'test-admin-token-that-is-long-enough', writer);
    const pending = Array.from({ length: 16 }, (_, index) => store.create(`Queued ${index}`));

    await expect(store.create('One too many')).rejects.toMatchObject({ code: 'queue_full' });
    release?.();
    await expect(Promise.all(pending)).resolves.toHaveLength(16);
  });
});
