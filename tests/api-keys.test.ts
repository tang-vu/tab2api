import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyStore } from '../src/security/api-keys.js';

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
});
