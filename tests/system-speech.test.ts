import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemSpeechSynthesizer } from '../src/audio/system-speech.js';
import { AppError } from '../src/errors.js';
import { testConfig } from './helpers.js';

const roots: string[] = [];

async function temporaryData(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tab2api-speech-'));
  roots.push(root);
  return root;
}

function waveBytes(payloadBytes = 0): Buffer {
  const audio = Buffer.alloc(44 + payloadBytes);
  audio.write('RIFF', 0, 'ascii');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVE', 8, 'ascii');
  audio.write('fmt ', 12, 'ascii');
  audio.write('data', 36, 'ascii');
  audio.writeUInt32LE(payloadBytes, 40);
  return audio;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('system speech private-file lifecycle', () => {
  it('returns bounded WAV data and removes prompt/audio temporaries', async () => {
    const dataDir = await temporaryData();
    const run = vi.fn(async (_input: string, output: string) => {
      await writeFile(output, waveBytes(8));
    });
    const synthesizer = new SystemSpeechSynthesizer(
      testConfig({ dataDir, mediaLimitBytes: 1_024 }),
      run,
    );

    await expect(
      synthesizer.synthesize({
        text: 'private test prompt',
        speed: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(waveBytes(8));
    expect(run).toHaveBeenCalledOnce();
    expect(await readdir(path.join(dataDir, 'audio'))).toEqual([]);
  });

  it('cleans temporary prompt data after a synthesizer failure', async () => {
    const dataDir = await temporaryData();
    const synthesizer = new SystemSpeechSynthesizer(testConfig({ dataDir }), async () => {
      throw new Error('simulated engine failure');
    });

    await expect(
      synthesizer.synthesize({
        text: 'must be removed',
        speed: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'audio_unavailable' });
    expect(await readdir(path.join(dataDir, 'audio'))).toEqual([]);
  });

  it('does not create temporary files for an already-cancelled request', async () => {
    const dataDir = await temporaryData();
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => undefined);
    const synthesizer = new SystemSpeechSynthesizer(testConfig({ dataDir }), run);

    await expect(
      synthesizer.synthesize({ text: 'cancelled', speed: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
    await expect(readdir(path.join(dataDir, 'audio'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a timeout reason and cleans the temporary files', async () => {
    const dataDir = await temporaryData();
    const controller = new AbortController();
    const synthesizer = new SystemSpeechSynthesizer(testConfig({ dataDir }), async () =>
      controller.abort(new AppError('timeout', 'test timeout')),
    );

    await expect(
      synthesizer.synthesize({ text: 'timed out', speed: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(await readdir(path.join(dataDir, 'audio'))).toEqual([]);
  });

  it('rejects oversized audio before reading it into an unbounded buffer', async () => {
    const dataDir = await temporaryData();
    const synthesizer = new SystemSpeechSynthesizer(
      testConfig({ dataDir, mediaLimitBytes: 43 }),
      async (_input, output) => writeFile(output, waveBytes()),
    );

    await expect(
      synthesizer.synthesize({ text: 'bounded', speed: 1, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await readdir(path.join(dataDir, 'audio'))).toEqual([]);
  });
});
