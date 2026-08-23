import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';

const defaultBrowserProfileSegments: readonly (readonly string[])[] = [
  ['google', 'chrome', 'user data'],
  ['microsoft', 'edge', 'user data'],
  ['chromium', 'user data'],
  ['library', 'application support', 'google', 'chrome'],
  ['library', 'application support', 'chromium'],
  ['library', 'application support', 'microsoft edge'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'microsoft-edge'],
];

function invalidStoragePath(): AppError {
  return new AppError(
    'invalid_request',
    'Runtime storage must use ordinary local directories strictly inside the dedicated data directory.',
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function lstatIfExists(candidate: string): Promise<Stats | undefined> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw invalidStoragePath();
  }
}

async function assertOrdinaryDirectory(candidate: string): Promise<void> {
  const metadata = await lstatIfExists(candidate);
  if (metadata !== undefined && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
    throw invalidStoragePath();
  }
}

async function projectedRealPath(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!isMissing(error)) throw invalidStoragePath();
      const parent = path.dirname(cursor);
      if (parent === cursor) throw invalidStoragePath();
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSamePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function containsSegmentSequence(
  segments: readonly string[],
  sequence: readonly string[],
): boolean {
  if (sequence.length > segments.length) return false;
  for (let start = 0; start <= segments.length - sequence.length; start += 1) {
    if (sequence.every((segment, offset) => segments[start + offset] === segment)) return true;
  }
  return false;
}

function assertDedicatedBrowserProfile(candidate: string): void {
  const segments = path
    .normalize(candidate)
    .split(path.sep)
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  if (
    defaultBrowserProfileSegments.some((sequence) => containsSegmentSequence(segments, sequence))
  ) {
    throw new AppError(
      'invalid_request',
      'Refusing to use a default Chrome/Chromium/Edge profile. Configure a dedicated empty directory.',
    );
  }
}

export function assertLoopbackHost(host: string): '127.0.0.1' | '::1' {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new AppError(
      'invalid_request',
      'TAB2API_HOST must be exactly 127.0.0.1 or ::1; public binding is prohibited.',
    );
  }
  return host;
}

export function assertLoopbackCdpEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('invalid_request', 'Browser CDP endpoint must be a valid HTTP URL.');
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port === '' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new AppError(
      'invalid_request',
      'Browser CDP endpoint must be exactly http://127.0.0.1:<port> or http://[::1]:<port>.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function isRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

function assertLocalPath(candidate: string): void {
  if (process.platform === 'win32' && path.resolve(candidate).startsWith('\\\\')) {
    throw invalidStoragePath();
  }
}

export function resolveSafeDataPaths(
  cwd: string,
  dataValue: string,
  profileValue: string,
): { dataDir: string; profileDir: string } {
  const dataDir = path.resolve(cwd, dataValue);
  const profileDir = path.resolve(cwd, profileValue);
  assertLocalPath(dataDir);
  assertLocalPath(profileDir);
  const relative = path.relative(dataDir, profileDir);
  if (
    isRoot(dataDir) ||
    isRoot(profileDir) ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AppError(
      'invalid_request',
      'Browser profile must be a non-root path inside TAB2API_DATA_DIR.',
    );
  }
  assertDedicatedBrowserProfile(profileDir);
  return { dataDir, profileDir };
}

export async function assertSafeRuntimePaths(
  dataDir: string,
  profileDir: string,
  artifactDir: string,
): Promise<void> {
  assertLocalPath(dataDir);
  assertLocalPath(profileDir);
  assertLocalPath(artifactDir);
  await Promise.all([
    assertOrdinaryDirectory(dataDir),
    assertOrdinaryDirectory(profileDir),
    assertOrdinaryDirectory(artifactDir),
  ]);
  const [actualData, actualProfile, actualArtifacts] = await Promise.all([
    projectedRealPath(dataDir),
    projectedRealPath(profileDir),
    projectedRealPath(artifactDir),
  ]);
  if (
    isRoot(actualData) ||
    !isStrictChild(actualData, actualProfile) ||
    !isStrictChild(actualData, actualArtifacts) ||
    isSamePath(actualProfile, actualArtifacts) ||
    isStrictChild(actualProfile, actualArtifacts) ||
    isStrictChild(actualArtifacts, actualProfile)
  ) {
    throw invalidStoragePath();
  }
  assertDedicatedBrowserProfile(actualProfile);
}

export async function assertSafeDataChildDirectory(
  dataDir: string,
  childDirectory: string,
): Promise<void> {
  assertLocalPath(dataDir);
  assertLocalPath(childDirectory);
  await Promise.all([assertOrdinaryDirectory(dataDir), assertOrdinaryDirectory(childDirectory)]);
  const [actualData, actualChild] = await Promise.all([
    projectedRealPath(dataDir),
    projectedRealPath(childDirectory),
  ]);
  if (isRoot(actualData) || !isStrictChild(actualData, actualChild)) throw invalidStoragePath();
}

export async function assertSafePrivateFile(dataDir: string, filePath: string): Promise<void> {
  assertLocalPath(dataDir);
  assertLocalPath(filePath);
  const resolvedData = path.resolve(dataDir);
  const resolvedFile = path.resolve(filePath);
  if (!isSamePath(path.dirname(resolvedFile), resolvedData)) throw invalidStoragePath();
  await assertOrdinaryDirectory(resolvedData);
  const metadata = await lstatIfExists(resolvedFile);
  if (
    metadata !== undefined &&
    (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1)
  ) {
    throw invalidStoragePath();
  }
  const [actualData, actualFile] = await Promise.all([
    projectedRealPath(resolvedData),
    projectedRealPath(resolvedFile),
  ]);
  if (
    isRoot(actualData) ||
    !isStrictChild(actualData, actualFile) ||
    !isSamePath(path.dirname(actualFile), actualData)
  ) {
    throw invalidStoragePath();
  }
}
