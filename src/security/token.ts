import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { assertSafePrivateFile } from './paths.js';
import { hardenPrivateDirectoryPermissions, readPrivateTextFile } from './private-files.js';

const TOKEN_BYTES = 32;
const MAX_TOKEN_FILE_BYTES = 1_024;
const SAFE_TOKEN = /^[\x21-\x7e]{24,512}$/;

function storageUnavailable(): AppError {
  return new AppError('storage_unavailable', 'The local API token could not be stored safely.');
}

function parseStoredToken(contents: string): string | undefined {
  const token = contents.endsWith('\r\n')
    ? contents.slice(0, -2)
    : contents.endsWith('\n')
      ? contents.slice(0, -1)
      : contents;
  return SAFE_TOKEN.test(token) ? token : undefined;
}

export async function loadOrCreateToken(dataDir: string, configured?: string): Promise<string> {
  if (configured !== undefined) {
    if (!SAFE_TOKEN.test(configured))
      throw new Error('TAB2API_API_TOKEN must contain 24-512 visible ASCII characters.');
    return configured;
  }
  const tokenFile = path.join(dataDir, 'api-token');
  await assertSafePrivateFile(dataDir, tokenFile);
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw storageUnavailable();
  }
  await hardenPrivateDirectoryPermissions(dataDir);
  await assertSafePrivateFile(dataDir, tokenFile);
  const existingFile = await readPrivateTextFile(dataDir, tokenFile, MAX_TOKEN_FILE_BYTES);
  if (existingFile !== undefined) {
    const existing = parseStoredToken(existingFile);
    if (existing !== undefined) return existing;
    throw new AppError('invalid_request', 'The local API token file is invalid.');
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    const handle = await open(tokenFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafePrivateFile(dataDir, tokenFile);
    await chmod(tokenFile, 0o600);
    return token;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const winnerFile = await readPrivateTextFile(dataDir, tokenFile, MAX_TOKEN_FILE_BYTES);
      const winner = winnerFile === undefined ? undefined : parseStoredToken(winnerFile);
      if (winner !== undefined) return winner;
      throw new AppError('invalid_request', 'The local API token file is invalid.');
    }
    if (error instanceof AppError) throw error;
    throw storageUnavailable();
  }
}

export function secureTokenEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function parseBearer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1];
}
