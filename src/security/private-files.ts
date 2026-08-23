import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { assertSafePrivateFile } from './paths.js';

export type PrivateFileWriter = (
  dataDir: string,
  filePath: string,
  contents: string,
) => Promise<void>;

function storageUnavailable(): AppError {
  return new AppError(
    'storage_unavailable',
    'Private runtime storage is unavailable.',
    'Check the dedicated data directory and retry. No in-memory mutation was committed.',
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function hardenPrivateDirectoryPermissions(directory: string): Promise<void> {
  try {
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new AppError(
        'invalid_request',
        'Private runtime storage is not an ordinary directory.',
      );
    }
    await chmod(directory, 0o700);
    const after = await lstat(directory);
    if (after.isSymbolicLink() || !after.isDirectory()) {
      throw new AppError(
        'invalid_request',
        'Private runtime storage is not an ordinary directory.',
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageUnavailable();
  }
}

export async function readPrivateBufferFile(
  dataDir: string,
  filePath: string,
  maximumBytes: number,
): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw storageUnavailable();
  await assertSafePrivateFile(dataDir, filePath);
  try {
    const handle = await open(filePath, 'r');
    let contents: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
        throw new AppError('invalid_request', 'A private runtime file exceeds its safe bounds.');
      }
      const bounded = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < bounded.length) {
        const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximumBytes) {
        throw new AppError('invalid_request', 'A private runtime file exceeds its safe bounds.');
      }
      contents = bounded.subarray(0, offset);
    } finally {
      await handle.close();
    }
    await assertSafePrivateFile(dataDir, filePath);
    await chmod(filePath, 0o600);
    return contents;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof AppError) throw error;
    throw storageUnavailable();
  }
}

export async function readPrivateTextFile(
  dataDir: string,
  filePath: string,
  maximumBytes: number,
): Promise<string | undefined> {
  return (await readPrivateBufferFile(dataDir, filePath, maximumBytes))?.toString('utf8');
}

export const atomicWritePrivateFile: PrivateFileWriter = async (dataDir, filePath, contents) => {
  const temporary = path.join(
    dataDir,
    `.tab2api-${process.pid}-${randomUUID().replaceAll('-', '')}.tmp`,
  );
  let temporaryExists = false;
  try {
    await assertSafePrivateFile(dataDir, filePath);
    await assertSafePrivateFile(dataDir, temporary);
    const handle = await open(temporary, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(contents, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafePrivateFile(dataDir, temporary);
    await chmod(temporary, 0o600);
    await assertSafePrivateFile(dataDir, filePath);
    await rename(temporary, filePath);
    temporaryExists = false;
  } catch {
    if (temporaryExists) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) throw storageUnavailable();
      }
    }
    throw storageUnavailable();
  }
};
