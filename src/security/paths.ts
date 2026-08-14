import path from 'node:path';
import { AppError } from '../errors.js';

const browserProfileFragments = [
  path.join('Google', 'Chrome', 'User Data'),
  path.join('Chromium', 'User Data'),
  path.join('Microsoft', 'Edge', 'User Data'),
];

export function assertLoopbackHost(host: string): '127.0.0.1' | '::1' {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new AppError(
      'invalid_request',
      'TAB2API_HOST must be exactly 127.0.0.1 or ::1; public binding is prohibited.',
    );
  }
  return host;
}

export function assertLoopbackHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('invalid_request', 'GPM Login base URL must be a valid HTTP URL.');
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '[::1]')
  ) {
    throw new AppError('invalid_request', 'GPM Login base URL must use HTTP on loopback only.');
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function isRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

export function resolveSafeDataPaths(
  cwd: string,
  dataValue: string,
  profileValue: string,
): { dataDir: string; profileDir: string } {
  const dataDir = path.resolve(cwd, dataValue);
  const profileDir = path.resolve(cwd, profileValue);
  const relative = path.relative(dataDir, profileDir);
  if (
    isRoot(dataDir) ||
    isRoot(profileDir) ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new AppError(
      'invalid_request',
      'Browser profile must be a non-root path inside TAB2API_DATA_DIR.',
    );
  }
  const normalized = profileDir.toLowerCase();
  if (browserProfileFragments.some((fragment) => normalized.includes(fragment.toLowerCase()))) {
    throw new AppError(
      'invalid_request',
      'Refusing to use a default Chrome/Chromium/Edge profile. Configure a dedicated empty directory.',
    );
  }
  return { dataDir, profileDir };
}
