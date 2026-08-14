import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN_BYTES = 32;

export async function loadOrCreateToken(dataDir: string, configured?: string): Promise<string> {
  if (configured !== undefined) {
    if (configured.length < 24)
      throw new Error('TAB2API_API_TOKEN must contain at least 24 characters.');
    return configured;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dataDir, 'api-token');
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    if (existing.length >= 24) {
      await chmod(tokenFile, 0o600).catch(() => undefined);
      return existing;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const winner = (await readFile(tokenFile, 'utf8')).trim();
      if (winner.length >= 24) return winner;
    }
    throw error;
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
