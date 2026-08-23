import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateToken } from '../src/security/token.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tab2api-token-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local administrator token storage', () => {
  it('returns an explicit token without touching storage', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'missing-data');
    const configured = 'configured-test-token-that-is-long-enough';
    await expect(loadOrCreateToken(data, configured)).resolves.toBe(configured);
    await expect(lstat(data)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converges concurrent first loads on one exclusive token file', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const tokens = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateToken(data)));

    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]?.length).toBeGreaterThanOrEqual(24);
    expect((await readFile(path.join(data, 'api-token'), 'utf8')).trim()).toBe(tokens[0]);
    if (process.platform !== 'win32') {
      expect((await stat(data)).mode & 0o077).toBe(0);
      expect((await stat(path.join(data, 'api-token'))).mode & 0o077).toBe(0);
    }
  });

  it('fails closed on an existing malformed token file', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    await mkdir(data);
    await writeFile(path.join(data, 'api-token'), 'too-short\n', { mode: 0o600 });

    await expect(loadOrCreateToken(data)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('bounds the existing token file before accepting its contents', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    await mkdir(data);
    await writeFile(path.join(data, 'api-token'), 'x'.repeat(1_025), { mode: 0o600 });

    await expect(loadOrCreateToken(data)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
