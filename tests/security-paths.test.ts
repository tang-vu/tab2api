import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { assertSafePrivateFile, assertSafeRuntimePaths } from '../src/security/paths.js';
import { loadOrCreateToken } from '../src/security/token.js';

const roots: string[] = [];
const configuredToken = 'security-path-test-token-that-is-long-enough';

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tab2api-paths-'));
  roots.push(root);
  return root;
}

async function linkDirectory(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonical runtime storage paths', () => {
  it.runIf(process.platform === 'win32')('rejects a Windows network share', async () => {
    await expect(
      assertSafeRuntimePaths(
        '\\\\server\\share\\tab2api',
        '\\\\server\\share\\tab2api\\browser-profile',
        '\\\\server\\share\\tab2api\\debug-artifacts',
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('accepts missing dedicated directories without creating them', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    await expect(
      assertSafeRuntimePaths(
        data,
        path.join(data, 'browser-profile'),
        path.join(data, 'debug-artifacts'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a profile equal to the data directory', async () => {
    const root = await temporaryRoot();
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: configuredToken,
          TAB2API_DATA_DIR: 'runtime',
          TAB2API_PROFILE_DIR: 'runtime',
        },
        root,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a linked data root even when its target is otherwise dedicated', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'actual-data');
    const linkedData = path.join(root, 'linked-data');
    await mkdir(target);
    await linkDirectory(target, linkedData);
    await expect(
      assertSafeRuntimePaths(
        linkedData,
        path.join(linkedData, 'browser-profile'),
        path.join(linkedData, 'debug-artifacts'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a profile junction into a default browser profile', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const personal = path.join(root, 'Google', 'Chrome', 'User Data');
    await mkdir(data);
    await mkdir(personal, { recursive: true });
    await linkDirectory(personal, path.join(data, 'browser-profile'));
    await expect(
      assertSafeRuntimePaths(
        data,
        path.join(data, 'browser-profile'),
        path.join(data, 'debug-artifacts'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a missing profile below an intermediate junction that escapes data', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const outside = path.join(root, 'outside');
    await mkdir(data);
    await mkdir(outside);
    await linkDirectory(outside, path.join(data, 'escape'));
    await expect(
      assertSafeRuntimePaths(
        data,
        path.join(data, 'escape', 'browser-profile'),
        path.join(data, 'debug-artifacts'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects browser and artifact directories that overlap', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const artifacts = path.join(data, 'debug-artifacts');
    await expect(
      assertSafeRuntimePaths(data, path.join(artifacts, 'browser-profile'), artifacts),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects dedicated-looking data nested below a system browser profile', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, '.config', 'chromium', 'tab2api-data');
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: configuredToken,
          TAB2API_DATA_DIR: data,
          TAB2API_PROFILE_DIR: path.join(data, 'browser-profile'),
        },
        root,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('accepts an ordinary private file directly inside data', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const file = path.join(data, 'usage.json');
    await mkdir(data);
    await writeFile(file, '{}', { mode: 0o600 });
    await expect(assertSafePrivateFile(data, file)).resolves.toBeUndefined();
  });

  it('rejects a private-file symlink before token loading', async ({ skip }) => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const outside = path.join(root, 'outside-token');
    const tokenFile = path.join(data, 'api-token');
    await mkdir(data);
    await writeFile(outside, 'outside-token-that-must-not-be-used', { mode: 0o600 });
    try {
      await symlink(outside, tokenFile, 'file');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        skip('This Windows host does not permit unprivileged file symlinks.');
        return;
      }
      throw error;
    }
    await expect(loadOrCreateToken(data)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a private-file hard link outside the dedicated data root', async () => {
    const root = await temporaryRoot();
    const data = path.join(root, 'runtime');
    const outside = path.join(root, 'outside-token');
    const tokenFile = path.join(data, 'api-token');
    await mkdir(data);
    await writeFile(outside, 'outside-token-that-must-not-be-used', { mode: 0o600 });
    await link(outside, tokenFile);

    await expect(loadOrCreateToken(data)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
