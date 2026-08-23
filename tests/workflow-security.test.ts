import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectActionReferences,
  isImmutableActionReference,
  readWorkflowSources,
  verifyWorkflowActionPins,
  type WorkflowSource,
} from '../scripts/verify-workflow-pins.js';

const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);

function workflow(contents: string): WorkflowSource {
  return { fileName: 'test.yml', contents };
}

describe('workflow action pinning', () => {
  it('accepts immutable remote, repository-local, and container references', () => {
    const source = workflow(
      [
        `      - uses: actions/checkout@${commit} # v7.0.1`,
        `        uses: owner/repository/subpath@${commit} # v1.2.3`,
        '      - uses: ./.github/actions/local-check',
        `      - uses: docker://registry.example/image@sha256:${digest}`,
      ].join('\n'),
    );
    expect(collectActionReferences(source).map(({ reference }) => reference)).toHaveLength(4);
    expect(verifyWorkflowActionPins([source])).toBe(4);
  });

  it('rejects mutable tags, branches, unpinned containers, and unsafe local paths', () => {
    for (const reference of [
      'actions/checkout@v7',
      'owner/repository@main',
      'docker://registry.example/image:latest',
      `docker:///image@sha256:${digest}`,
      `docker://registry.example//image@sha256:${digest}`,
      './../outside',
      './actions/../outside',
    ]) {
      expect(isImmutableActionReference(reference)).toBe(false);
      expect(() => verifyWorkflowActionPins([workflow(`- uses: ${reference}`)])).toThrow(
        /mutable or invalid/u,
      );
    }
  });

  it('rejects malformed or empty workflow collections', () => {
    expect(() => collectActionReferences(workflow('- uses:'))).toThrow(/malformed uses/u);
    expect(() => verifyWorkflowActionPins([])).toThrow(/file count/u);
    expect(() => verifyWorkflowActionPins([workflow('name: no-actions')])).toThrow(
      /No GitHub Actions references/u,
    );
  });

  it('requires an exact human-readable version beside each remote commit pin', () => {
    expect(() =>
      verifyWorkflowActionPins([workflow(`- uses: actions/checkout@${commit}`)]),
    ).toThrow(/annotate.*exact version/u);
    expect(() =>
      verifyWorkflowActionPins([workflow(`- uses: actions/checkout@${commit} # mutable-main`)]),
    ).toThrow(/annotate.*exact version/u);
  });

  it('keeps every tracked repository workflow pinned', async () => {
    const rootDirectory = path.resolve(import.meta.dirname, '..');
    const sources = await readWorkflowSources(rootDirectory);
    expect(sources.map(({ fileName }) => fileName)).toContain('source-package.yml');
    expect(verifyWorkflowActionPins(sources)).toBeGreaterThan(0);
  });
});
