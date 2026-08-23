import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { atomicWritePrivateFile, type PrivateFileWriter } from '../src/security/private-files.js';
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

  it('normalizes fractional runtime latency before durable aggregation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    const store = await UsageStore.load(directory);
    const principal = { id: 'client-latency', label: 'Latency client', role: 'client' as const };
    await store.record(principal, {
      endpoint: '/v1/responses',
      successful: true,
      latencyMs: 12.6,
    });
    await store.record(principal, {
      endpoint: '/v1/chat/completions',
      successful: true,
      latencyMs: 3.2,
    });

    expect(store.snapshot().keys[0]?.totalLatencyMs).toBe(16);
    expect((await UsageStore.load(directory)).snapshot().keys[0]?.totalLatencyMs).toBe(16);
  });

  it('prunes the least-recently-used client statistics after bounded key rotation', async () => {
    const store = UsageStore.memory();
    for (let index = 0; index < 102; index += 1) {
      await store.record(
        { id: `client-${index}`, label: `Client ${index}`, role: 'client' },
        { endpoint: '/v1/responses', successful: true, latencyMs: 1 },
      );
    }

    const ids = new Set(store.snapshot().keys.map(({ keyId }) => keyId));
    expect(ids.size).toBe(101);
    expect(ids.has('client-0')).toBe(false);
    expect(ids.has('client-101')).toBe(true);
  });

  it('rejects unsafe endpoint keys before touching an endpoint object', async () => {
    const store = UsageStore.memory();
    await expect(
      store.record(
        { id: 'client-safe', label: 'Safe client', role: 'client' },
        { endpoint: '__proto__', successful: true, latencyMs: 1 },
      ),
    ).rejects.toThrow();
    expect(store.snapshot().keys).toHaveLength(0);
  });

  it('rolls back failed persistence and recovers the mutation queue', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    let writes = 0;
    const writer: PrivateFileWriter = async (...arguments_) => {
      writes += 1;
      if (writes === 1) throw new AppError('storage_unavailable', 'simulated failure');
      await atomicWritePrivateFile(...arguments_);
    };
    const store = await UsageStore.load(directory, writer);
    const principal = { id: 'client-3', label: 'Tablet', role: 'client' as const };
    const delta = { endpoint: '/v1/responses', successful: true, latencyMs: 4 };

    await expect(store.record(principal, delta)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(store.snapshot().keys).toHaveLength(0);
    await store.record(principal, delta);
    expect(store.snapshot().keys[0]?.requests).toBe(1);
    expect((await UsageStore.load(directory)).snapshot().keys[0]?.requests).toBe(1);
  });

  it('serializes concurrent durable increments without losing counters', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    const store = await UsageStore.load(directory);
    const principal = { id: 'client-4', label: 'Desktop', role: 'client' as const };
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.record(principal, {
          endpoint: '/v1/chat/completions',
          successful: index % 3 !== 0,
          latencyMs: index,
        }),
      ),
    );

    expect(store.snapshot().keys[0]).toMatchObject({ requests: 12, successful: 8, failed: 4 });
    expect((await UsageStore.load(directory)).snapshot().keys[0]?.requests).toBe(12);
  });

  it('rejects persisted totals that disagree with their endpoint counters', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    const store = await UsageStore.load(directory);
    await store.record(
      { id: 'client-5', label: 'Browser', role: 'client' },
      { endpoint: '/v1/responses', successful: true, latencyMs: 1 },
    );
    const filePath = path.join(directory, 'usage.json');
    const inconsistent = (await readFile(filePath, 'utf8')).replace(
      '"requests": 1',
      '"requests": 2',
    );
    await writeFile(filePath, inconsistent, { mode: 0o600 });

    await expect(UsageStore.load(directory)).rejects.toThrow(/invalid or unreadable/);
  });

  it('bounds queued durable usage mutations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-usage-'));
    temporaryDirectories.push(directory);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer: PrivateFileWriter = async () => gate;
    const store = await UsageStore.load(directory, writer);
    const principal = { id: 'client-6', label: 'Queued client', role: 'client' as const };
    const pending = Array.from({ length: 128 }, () =>
      store.record(principal, {
        endpoint: '/v1/responses',
        successful: true,
        latencyMs: 1,
      }),
    );

    await expect(
      store.record(principal, {
        endpoint: '/v1/responses',
        successful: true,
        latencyMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'queue_full' });
    release?.();
    await Promise.all(pending);
    expect(store.snapshot().keys[0]?.requests).toBe(128);
  });
});
