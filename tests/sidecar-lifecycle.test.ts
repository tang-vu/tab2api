import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, vi } from 'vitest';
import {
  SidecarCommandDecoder,
  SidecarLifecycle,
  SidecarReporter,
  type SidecarEvent,
} from '../src/sidecar/lifecycle.js';

function captureReporter(): { events: SidecarEvent[]; reporter: SidecarReporter } {
  const events: SidecarEvent[] = [];
  return {
    events,
    reporter: new SidecarReporter({
      write(chunk) {
        events.push(JSON.parse(chunk) as SidecarEvent);
        return true;
      },
    }),
  };
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback test port.'));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

describe('desktop sidecar lifecycle', () => {
  it('reports a versioned machine-readable lifecycle and closes once', async () => {
    const { events, reporter } = captureReporter();
    const stop = vi.fn(async () => undefined);
    const lifecycle = new SidecarLifecycle(
      { start: async () => ({ host: '127.0.0.1', port: 3210 }), stop },
      reporter,
    );

    await lifecycle.start();
    lifecycle.reportStatus();
    await Promise.all([lifecycle.shutdown('parent_request'), lifecycle.shutdown('SIGTERM')]);

    expect(events.map(({ event }) => event)).toEqual([
      'starting',
      'listening',
      'status',
      'stopping',
      'stopped',
    ]);
    expect(events[1]).toMatchObject({ protocol: 1, host: '127.0.0.1', port: 3210 });
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('reports a sanitized startup failure without including the thrown secret', async () => {
    const { events, reporter } = captureReporter();
    const lifecycle = new SidecarLifecycle(
      {
        start: async () => {
          throw new Error('Bearer super-secret-value');
        },
        stop: async () => undefined,
      },
      reporter,
    );

    await expect(lifecycle.start()).rejects.toThrow('super-secret-value');
    expect(events.at(-1)).toMatchObject({ event: 'fatal', code: 'startup_failed' });
    expect(JSON.stringify(events)).not.toContain('super-secret-value');
  });

  it('waits for an in-flight start before closing after parent disconnect', async () => {
    const { events, reporter } = captureReporter();
    let finishStart: ((address: { host: '127.0.0.1'; port: number }) => void) | undefined;
    const start = new Promise<{ host: '127.0.0.1'; port: number }>((resolve) => {
      finishStart = resolve;
    });
    const stop = vi.fn(async () => undefined);
    const lifecycle = new SidecarLifecycle({ start: () => start, stop }, reporter);

    const starting = lifecycle.start();
    const stopping = lifecycle.shutdown('parent_stream_closed');
    expect(stop).not.toHaveBeenCalled();
    finishStart?.({ host: '127.0.0.1', port: 3210 });
    await Promise.all([starting, stopping]);

    expect(events.map(({ event }) => event)).toEqual([
      'starting',
      'listening',
      'stopping',
      'stopped',
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('decodes fragmented commands and bounds untrusted parent input', () => {
    const commands: string[] = [];
    const errors: string[] = [];
    const decoder = new SidecarCommandDecoder(
      ({ command }) => commands.push(command),
      (error) => errors.push(error),
      64,
    );

    decoder.push('{"command":"sta');
    decoder.push('tus"}\n{"command":"shutdown"}\n');
    decoder.push('{"command":"unknown"}\n');
    decoder.push('x'.repeat(65));

    expect(commands).toEqual(['status', 'shutdown']);
    expect(errors).toEqual(['invalid_command', 'command_too_large']);
  });

  it('exits after startup failure even while the parent pipe remains open', async () => {
    const cwd = path.resolve(import.meta.dirname, '..');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/sidecar/index.ts', '--parent-pipe'],
      {
        cwd,
        env: { ...process.env, TAB2API_BROWSER_BACKEND: 'unsupported' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Sidecar hung after startup failure.'));
      }, 5_000);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(1);
    const events = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SidecarEvent);
    expect(events.map(({ event }) => event)).toEqual(['starting', 'fatal']);
    expect(stdout).not.toContain('unsupported');
  });

  it('starts the real local server and exits after a parent shutdown command', async () => {
    const cwd = path.resolve(import.meta.dirname, '..');
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-sidecar-'));
    const port = await freeLoopbackPort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/sidecar/index.ts', '--parent-pipe'],
      {
        cwd,
        env: {
          ...process.env,
          TAB2API_BROWSER_BACKEND: 'playwright',
          TAB2API_DATA_DIR: dataDirectory,
          TAB2API_PROFILE_DIR: path.join(dataDirectory, 'browser-profile'),
          TAB2API_HOST: '127.0.0.1',
          TAB2API_PORT: String(port),
          TAB2API_LOG_LEVEL: 'silent',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      const lines = createInterface({ input: child.stdout });
      let listening = false;
      for await (const line of lines) {
        const event = JSON.parse(line) as SidecarEvent;
        if (event.event === 'listening') {
          listening = true;
          break;
        }
      }
      expect(listening).toBe(true);
      child.stdin.write('{"command":"shutdown"}\n');

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Real sidecar shutdown timed out.')),
          5_000,
        );
        child.once('error', reject);
        child.once('exit', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(exitCode).toBe(0);
    } finally {
      if (!child.killed) child.kill();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
