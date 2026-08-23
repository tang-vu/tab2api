import { describe, expect, it } from 'vitest';
import {
  verifyPackageManifest,
  verifyVersionMetadata,
  type ReleaseMetadata,
} from '../scripts/verify-release-package.js';

const version = '0.2.0';
const packageFiles = [
  'dist',
  'scripts/windows',
  'README.md',
  'README_VI.md',
  'CHANGELOG.md',
  'NOTICE.md',
  'LICENSE',
  '.env.example',
];
const rootFiles = [
  '.env.example',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'README_VI.md',
  'package.json',
];

function metadata(overrides: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    packageVersion: version,
    lockVersion: version,
    lockRootVersion: version,
    cargoVersion: version,
    tauriVersion: version,
    packageFiles,
    changelog: [
      `## [${version}] - 2026-08-23`,
      `[Unreleased]: https://github.com/tang-vu/tab2api/compare/v${version}...HEAD`,
    ].join('\n'),
    ...overrides,
  };
}

interface TestPackFile {
  path: string;
  size: number;
  mode: number;
}

interface TestPackRecord {
  id: string;
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  shasum: string;
  integrity: string;
  filename: string;
  files: TestPackFile[];
  entryCount: number;
  bundled: string[];
}

function manifest(extraPaths: readonly string[] = []): TestPackRecord[] {
  const paths = [
    ...rootFiles,
    'dist/index.js',
    'dist/cli/index.js',
    'dist/sidecar/index.js',
    ...extraPaths,
  ];
  const files = paths.map((packagePath) => ({ path: packagePath, size: 1, mode: 420 }));
  return [
    {
      id: `tab2api@${version}`,
      name: 'tab2api',
      version,
      size: 100,
      unpackedSize: files.length,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      filename: `tab2api-${version}.tgz`,
      files,
      entryCount: files.length,
      bundled: [],
    },
  ];
}

function record(pack: TestPackRecord[]): TestPackRecord {
  const value = pack[0];
  if (value === undefined) throw new Error('Test package fixture is empty.');
  return value;
}

describe('release package verification', () => {
  it('requires synchronized versions, exact tags, boundaries, and changelog links', () => {
    expect(verifyVersionMetadata(metadata(), `v${version}`)).toBe(version);
    expect(() => verifyVersionMetadata(metadata({ cargoVersion: '0.1.0' }), `v${version}`)).toThrow(
      /versions must match/u,
    );
    expect(() => verifyVersionMetadata(metadata(), 'v0.2.1')).toThrow(/tag must be/u);
    expect(() => verifyVersionMetadata(metadata({ packageFiles: ['.'] }))).toThrow(
      /reviewed release allowlist/u,
    );
    expect(() =>
      verifyVersionMetadata(metadata({ changelog: `## [${version}] - 2026-08-23` })),
    ).toThrow(/Unreleased comparison/u);
  });

  it('accepts a bounded allowlisted npm package manifest', () => {
    expect(verifyPackageManifest(manifest(), version)).toEqual({
      filename: `tab2api-${version}.tgz`,
      entryCount: 10,
      unpackedSize: 10,
    });
  });

  it('fails closed on runtime, secret, binary, and traversal entries', () => {
    expect(() => verifyPackageManifest(manifest(['dist/.tab2api/token.js']), version)).toThrow(
      /forbidden runtime or secret data/u,
    );
    expect(() => verifyPackageManifest(manifest(['dist/native.node']), version)).toThrow(
      /forbidden artifact or secret extension/u,
    );
    expect(() => verifyPackageManifest(manifest(['../profile.json']), version)).toThrow(
      /normalized relative path/u,
    );
  });

  it('fails closed on unreviewed, duplicate, and missing build entries', () => {
    expect(() => verifyPackageManifest(manifest(['scripts/postinstall.js']), version)).toThrow(
      /outside the reviewed allowlist/u,
    );
    expect(() => verifyPackageManifest(manifest(['dist/index.js']), version)).toThrow(
      /duplicated/u,
    );

    const missing = manifest();
    const missingRecord = record(missing);
    missingRecord.files = missingRecord.files.filter(
      ({ path: packagePath }) => packagePath !== 'dist/index.js',
    );
    missingRecord.entryCount = missingRecord.files.length;
    missingRecord.unpackedSize = missingRecord.files.length;
    expect(() => verifyPackageManifest(missing, version)).toThrow(/missing required build entry/u);
  });

  it('bounds counts and sizes and requires internal consistency', () => {
    const inconsistent = manifest();
    record(inconsistent).unpackedSize += 1;
    expect(() => verifyPackageManifest(inconsistent, version)).toThrow(/unpacked size/u);

    const oversized = manifest();
    record(oversized).size = 5 * 1024 * 1024 + 1;
    expect(() => verifyPackageManifest(oversized, version)).toThrow(/outside its allowed bound/u);
  });
});
