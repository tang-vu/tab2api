import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens, UsageStore } from '../src/store/usage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('usage statistics', () => {
  it('labels token counts as estimates and aggregates by key and endpoint', async () => {
    const store = UsageStore.memory();
    await store.record(
      { id: 'client-1', label: 'Laptop', role: 'client' },
      {
        endpoint: '/v1/responses',
        successful: true,
        latencyMs: 25,
        inputText: 'hello',
        outputText: 'world',
        inputBytes: 20,
        outputBytes: 30,
      },
    );
    const snapshot = store.snapshot();
    expect(snapshot.tokenCounts).toBe('estimated');
    expect(snapshot.keys[0]).toMatchObject({
      requests: 1,
      successful: 1,
      failed: 0,
      inputBytes: 20,
      outputBytes: 30,
    });
    expect(snapshot.keys[0]?.endpoints['/v1/responses']?.requests).toBe(1);
    expect(estimateTokens('hello')).toBeGreaterThan(0);
  });

  it('persists counters without prompt or response content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    const store = await UsageStore.load(directory);
    await store.record(
      { id: 'client-2', label: 'Phone', role: 'client' },
      {
        endpoint: '/v1/chat/completions',
        successful: true,
        latencyMs: 10,
        inputText: 'private input content',
        outputText: 'private output content',
      },
    );
    await store.flush();
    const persisted = await readFile(path.join(directory, 'usage.json'), 'utf8');
    expect(persisted).not.toContain('private input content');
    expect(persisted).not.toContain('private output content');
    expect(persisted).toContain('estimatedInputTokens');
  });
});
