#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_FILES = 512;
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const PACKAGE_FILE_ALLOWLIST = [
  'dist',
  'scripts/windows',
  'README.md',
  'README_VI.md',
  'CHANGELOG.md',
  'NOTICE.md',
  'LICENSE',
  '.env.example',
] as const;

const ROOT_FILES = new Set([
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'README_VI.md',
  'package.json',
]);

const WINDOWS_SCRIPTS = new Set([
  'scripts/windows/install-autostart.ps1',
  'scripts/windows/install-cloudflare-autostart.ps1',
  'scripts/windows/prepare-desktop-bundle.ps1',
  'scripts/windows/remove-autostart.ps1',
  'scripts/windows/remove-cloudflare-autostart.ps1',
  'scripts/windows/run-autostart.ps1',
  'scripts/windows/smoke-desktop-bundle.ps1',
  'scripts/windows/smoke-desktop-installer.ps1',
  'scripts/windows/status-autostart.ps1',
  'scripts/windows/status-cloudflare-autostart.ps1',
]);

const REQUIRED_BUILD_FILES = new Set([
  'dist/index.js',
  'dist/cli/index.js',
  'dist/sidecar/index.js',
]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ReleaseMetadata {
  packageVersion: string;
  lockVersion: string;
  lockRootVersion: string;
  cargoVersion: string;
  tauriVersion: string;
  packageFiles: readonly string[];
  changelog: string;
}

export interface PackageManifestSummary {
  filename: string;
  entryCount: number;
  unpackedSize: number;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stringValue(record: JsonObject, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
}

function stringArrayValue(record: JsonObject, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label}.${key} must be an array of strings.`);
  }
  return value;
}

function safeIntegerValue(
  record: JsonObject,
  key: string,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label}.${key} is outside its allowed bound.`);
  }
  return value;
}

function parseJson(contents: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(contents);
    return parsed;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function cargoPackageVersion(contents: string): string {
  let insidePackage = false;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^\[[^\]]+\]$/u.test(line)) {
      if (insidePackage) break;
      insidePackage = line === '[package]';
      continue;
    }
    if (!insidePackage) continue;
    const match = /^version\s*=\s*"([^"]+)"$/u.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error('desktop/Cargo.toml has no package version.');
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return (
    sortedActual.length === sortedExpected.length &&
    sortedActual.every((value, index) => value === sortedExpected[index])
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function verifyVersionMetadata(metadata: ReleaseMetadata, expectedTag?: string): string {
  const versions = [
    metadata.packageVersion,
    metadata.lockVersion,
    metadata.lockRootVersion,
    metadata.cargoVersion,
    metadata.tauriVersion,
  ];
  const version = versions[0];
  if (version === undefined || !SEMVER.test(version)) {
    throw new Error('package.json version must be a canonical semantic version.');
  }
  if (!versions.every((candidate) => candidate === version)) {
    throw new Error('npm, Cargo, and Tauri versions must match exactly.');
  }
  if (expectedTag !== undefined && expectedTag !== `v${version}`) {
    throw new Error(`Release tag must be v${version}.`);
  }
  if (!sameMembers(metadata.packageFiles, PACKAGE_FILE_ALLOWLIST)) {
    throw new Error('package.json files must match the reviewed release allowlist.');
  }
  const escapedVersion = escapeRegExp(version);
  if (
    !new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu').test(
      metadata.changelog,
    )
  ) {
    throw new Error(`CHANGELOG.md has no dated ${version} release section.`);
  }
  const expectedUnreleased = `[Unreleased]: https://github.com/tang-vu/tab2api/compare/v${version}...HEAD`;
  if (!metadata.changelog.split(/\r?\n/u).includes(expectedUnreleased)) {
    throw new Error('CHANGELOG.md Unreleased comparison does not start at the package version.');
  }
  return version;
}

function assertSafePackagePath(packagePath: string): void {
  if (
    packagePath.includes('\\') ||
    packagePath.includes('\0') ||
    path.posix.isAbsolute(packagePath) ||
    path.posix.normalize(packagePath) !== packagePath ||
    packagePath === '.' ||
    packagePath.startsWith('../')
  ) {
    throw new Error(`Package entry is not a normalized relative path: ${packagePath}`);
  }
  const lower = packagePath.toLowerCase();
  const segments = lower.split('/');
  const forbiddenSegments = new Set([
    '.env',
    '.tab2api',
    'browser-profile',
    'debug-artifacts',
    'node_modules',
    'runtime',
  ]);
  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    throw new Error(`Package entry targets forbidden runtime or secret data: ${packagePath}`);
  }
  if (/\.(?:exe|dll|node|log|png|har|trace|zip|tgz|pem|key|pfx|p12|sqlite|db)$/iu.test(lower)) {
    throw new Error(`Package entry has a forbidden artifact or secret extension: ${packagePath}`);
  }
}

function allowedPackagePath(packagePath: string): boolean {
  if (ROOT_FILES.has(packagePath) || WINDOWS_SCRIPTS.has(packagePath)) return true;
  return /^dist\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+(?:\.d\.ts|\.js(?:\.map)?)$/u.test(packagePath);
}

export function verifyPackageManifest(
  packResult: unknown,
  version: string,
): PackageManifestSummary {
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error('npm pack must report exactly one package.');
  }
  const result = objectValue(packResult[0], 'npm pack result');
  if (stringValue(result, 'name', 'npm pack result') !== 'tab2api') {
    throw new Error('npm pack reported an unexpected package name.');
  }
  if (stringValue(result, 'version', 'npm pack result') !== version) {
    throw new Error('npm pack version does not match release metadata.');
  }
  if (stringValue(result, 'id', 'npm pack result') !== `tab2api@${version}`) {
    throw new Error('npm pack identifier does not match release metadata.');
  }
  const expectedFilename = `tab2api-${version}.tgz`;
  if (stringValue(result, 'filename', 'npm pack result') !== expectedFilename) {
    throw new Error(`npm pack filename must be ${expectedFilename}.`);
  }
  if (!/^[a-f0-9]{40}$/u.test(stringValue(result, 'shasum', 'npm pack result'))) {
    throw new Error('npm pack shasum is invalid.');
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/u.test(stringValue(result, 'integrity', 'npm pack result'))) {
    throw new Error('npm pack integrity is invalid.');
  }
  safeIntegerValue(result, 'size', 'npm pack result', MAX_PACKAGE_BYTES);
  const unpackedSize = safeIntegerValue(
    result,
    'unpackedSize',
    'npm pack result',
    MAX_UNPACKED_BYTES,
  );
  const rawFiles = result.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_PACKAGE_FILES) {
    throw new Error('npm pack file count is outside its allowed bound.');
  }
  if (
    safeIntegerValue(result, 'entryCount', 'npm pack result', MAX_PACKAGE_FILES) !== rawFiles.length
  ) {
    throw new Error('npm pack entry count does not match its file list.');
  }
  if (!Array.isArray(result.bundled) || result.bundled.length !== 0) {
    throw new Error('The release package must not bundle dependency trees.');
  }

  const seen = new Set<string>();
  let summedSize = 0;
  for (const [index, rawFile] of rawFiles.entries()) {
    const file = objectValue(rawFile, `npm pack file ${index}`);
    const packagePath = stringValue(file, 'path', `npm pack file ${index}`);
    assertSafePackagePath(packagePath);
    if (!allowedPackagePath(packagePath)) {
      throw new Error(`Package entry is outside the reviewed allowlist: ${packagePath}`);
    }
    if (seen.has(packagePath)) throw new Error(`Package entry is duplicated: ${packagePath}`);
    seen.add(packagePath);
    summedSize += safeIntegerValue(file, 'size', `npm pack file ${index}`, MAX_SINGLE_FILE_BYTES);
  }
  if (summedSize !== unpackedSize) {
    throw new Error('npm pack unpacked size does not match the reviewed file list.');
  }
  for (const required of ROOT_FILES) {
    if (!seen.has(required)) throw new Error(`Package is missing required file ${required}.`);
  }
  for (const required of REQUIRED_BUILD_FILES) {
    if (!seen.has(required))
      throw new Error(`Package is missing required build entry ${required}.`);
  }
  return { filename: expectedFilename, entryCount: rawFiles.length, unpackedSize };
}

export async function readReleaseMetadata(rootDirectory: string): Promise<ReleaseMetadata> {
  let contents: [string, string, string, string, string];
  try {
    contents = await Promise.all([
      readFile(path.join(rootDirectory, 'package.json'), 'utf8'),
      readFile(path.join(rootDirectory, 'package-lock.json'), 'utf8'),
      readFile(path.join(rootDirectory, 'desktop', 'Cargo.toml'), 'utf8'),
      readFile(path.join(rootDirectory, 'desktop', 'tauri.conf.json'), 'utf8'),
      readFile(path.join(rootDirectory, 'CHANGELOG.md'), 'utf8'),
    ]);
  } catch {
    throw new Error('Could not read the reviewed release metadata files.');
  }
  const [packageJsonContents, lockContents, cargoContents, tauriContents, changelog] = contents;
  const packageJson = objectValue(parseJson(packageJsonContents, 'package.json'), 'package.json');
  const lock = objectValue(parseJson(lockContents, 'package-lock.json'), 'package-lock.json');
  const lockPackages = objectValue(lock.packages, 'package-lock.json.packages');
  const lockRoot = objectValue(lockPackages[''], 'package-lock.json.packages root');
  const tauri = objectValue(
    parseJson(tauriContents, 'desktop/tauri.conf.json'),
    'desktop/tauri.conf.json',
  );
  return {
    packageVersion: stringValue(packageJson, 'version', 'package.json'),
    lockVersion: stringValue(lock, 'version', 'package-lock.json'),
    lockRootVersion: stringValue(lockRoot, 'version', 'package-lock.json.packages root'),
    cargoVersion: cargoPackageVersion(cargoContents),
    tauriVersion: stringValue(tauri, 'version', 'desktop/tauri.conf.json'),
    packageFiles: stringArrayValue(packageJson, 'files', 'package.json'),
    changelog,
  };
}

interface ParsedArguments {
  tag: string | undefined;
  packJsonPath: string | undefined;
}

function parseArguments(argumentsList: readonly string[]): ParsedArguments {
  let tag: string | undefined;
  let packJsonPath: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === '--tag' && value !== undefined && tag === undefined) {
      tag = value;
      index += 1;
      continue;
    }
    if (argument === '--pack-json' && value !== undefined && packJsonPath === undefined) {
      packJsonPath = value;
      index += 1;
      continue;
    }
    throw new Error('Use only --tag <vX.Y.Z> and optional --pack-json <path>.');
  }
  return { tag, packJsonPath };
}

async function main(): Promise<void> {
  const argumentsParsed = parseArguments(process.argv.slice(2));
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const metadata = await readReleaseMetadata(rootDirectory);
  const version = verifyVersionMetadata(metadata, argumentsParsed.tag);
  process.stdout.write(`Release metadata PASS: tab2api ${version}.\n`);
  if (argumentsParsed.packJsonPath !== undefined) {
    let packContents: string;
    try {
      packContents = await readFile(path.resolve(argumentsParsed.packJsonPath), 'utf8');
    } catch {
      throw new Error('Could not read the npm pack result.');
    }
    const summary = verifyPackageManifest(parseJson(packContents, 'npm pack result'), version);
    process.stdout.write(
      `Package manifest PASS: ${summary.filename}, ${summary.entryCount} files, ${summary.unpackedSize} bytes.\n`,
    );
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Release verification failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`,
    );
    process.exitCode = 1;
  });
}
