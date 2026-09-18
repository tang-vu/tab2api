import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api/server.js';
import {
  commandChat,
  commandDrain,
  commandKeys,
  commandMcp,
  commandResume,
  commandStatus,
  commandUsage,
} from '../src/cli/commands.js';
import { main } from '../src/cli/index.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';
import type { AppConfig } from '../src/config/index.js';

function captureStdout(): { lines: string[]; text: () => string } {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, text: () => lines.join('') };
}

async function withServer(
  run: (config: AppConfig, provider: FakeProvider) => Promise<void>,
): Promise<void> {
  const provider = new FakeProvider();
  const app = buildServer({ config: testConfig(), provider, logger: createLogger('silent') });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = testConfig({ port: Number(new URL(address).port) });
  try {
    await run(config, provider);
  } finally {
    await app.close();
  }
}

describe('tab2api CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints help for `help`, `--help`, and unknown commands', async () => {
    const capture = captureStdout();
    await main(['help']);
    const help = capture.text();
    expect(help).toContain('Usage: tab2api');
    for (const name of ['start', 'status', 'chat', 'mcp', 'drain', 'resume', 'keys']) {
      expect(help).toContain(name);
    }
    capture.lines.length = 0;
    await main(['--help']);
    expect(capture.text()).toContain('Usage: tab2api');
    capture.lines.length = 0;
    await expect(main(['not-a-command'])).rejects.toThrow(/Unknown command/);
    expect(capture.text()).toContain('Usage: tab2api');
  });

  it('prints the package version for `version` and `--version`', async () => {
    const capture = captureStdout();
    await main(['version']);
    await main(['--version']);
    const lines = capture.lines.join('').trim().split('\n');
    for (const line of lines) expect(line).toMatch(/^tab2api \d+\.\d+\.\d+/);
  });

  it('runs a one-shot chat through the queue and prints the answer', async () => {
    await withServer(async (config, provider) => {
      const capture = captureStdout();
      await commandChat(config, ['hello', 'world']);
      expect(provider.prompts).toHaveLength(1);
      expect(provider.prompts[0]).toContain('hello world');
      expect(capture.text()).toBe('Fake browser response\n');
    });
  });

  it('forwards chat flags and reads the prompt from stdin text', async () => {
    await withServer(async (config, provider) => {
      captureStdout();
      await commandChat(config, ['--temporary', '--effort', 'high', 'ping']);
      expect(provider.temporaryFlags).toEqual([true]);
      expect(provider.efforts).toEqual(['high']);

      await commandChat(config, [], 'a piped prompt\n');
      expect(provider.prompts[1]).toContain('a piped prompt');
    });
  });

  it('rejects malformed chat invocations before any request', async () => {
    await withServer(async (config, provider) => {
      captureStdout();
      await expect(commandChat(config, ['--bogus', 'x'])).rejects.toThrow(/Unknown chat flag/);
      await expect(commandChat(config, ['--effort', 'wild', 'x'])).rejects.toThrow(
        /--effort must be one of/,
      );
      await expect(commandChat(config, [])).rejects.toThrow(/prompt/);
      expect(provider.prompts).toHaveLength(0);
    });
  });

  it('reports an unreachable service instead of a stack trace', async () => {
    const provider = new FakeProvider();
    const app = buildServer({ config: testConfig(), provider, logger: createLogger('silent') });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const closedPort = Number(new URL(address).port);
    await app.close();
    captureStdout();
    await expect(commandChat(testConfig({ port: closedPort }), ['hi'])).rejects.toMatchObject({
      code: 'unreachable',
    });
  });

  it('reports session and queue state, then drains and resumes intake', async () => {
    await withServer(async (config) => {
      const capture = captureStdout();
      await commandStatus(config);
      expect(capture.text()).toContain('Session: ready');
      expect(capture.text()).toContain('draining=false');

      capture.lines.length = 0;
      await commandDrain(config);
      expect(capture.text()).toContain('Intake closed');
      await commandStatus(config);
      expect(capture.text()).toContain('draining=true');

      capture.lines.length = 0;
      await commandResume(config);
      expect(capture.text()).toContain('Intake reopened');
      await commandStatus(config);
      expect(capture.text()).toContain('draining=false');
    });
  });

  it('prints machine-readable status with --json', async () => {
    await withServer(async (config) => {
      const capture = captureStdout();
      await commandStatus(config, ['--json']);
      const body = z
        .object({
          service: z.object({ reachable: z.literal(true), url: z.string() }),
          session: z.object({ state: z.string() }),
          queue: z.object({ pending: z.number(), active: z.number(), draining: z.boolean() }),
        })
        .parse(JSON.parse(capture.text()));
      expect(body.session.state).toBe('ready');
      expect(body.queue.draining).toBe(false);
      expect(capture.lines).toHaveLength(1);
    });
  });

  it('reports an unreachable service as json and sets a failing exit code', async () => {
    const app = buildServer({
      config: testConfig(),
      provider: new FakeProvider(),
      logger: createLogger('silent'),
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const closedPort = Number(new URL(address).port);
    await app.close();
    const capture = captureStdout();
    const previousExitCode = process.exitCode;
    try {
      await commandStatus(testConfig({ port: closedPort }), ['--json']);
      const body = z
        .object({ service: z.object({ reachable: z.literal(false), error: z.string() }) })
        .parse(JSON.parse(capture.text()));
      expect(body.service.error).toBe('unreachable');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('manages client keys through the admin client', async () => {
    await withServer(async (config) => {
      const capture = captureStdout();
      await commandKeys(config, ['list']);
      expect(capture.text()).toContain('local-admin');

      capture.lines.length = 0;
      await commandKeys(config, ['create', 'my', 'laptop']);
      expect(capture.text()).toContain('my laptop');
      const tokenLine = capture.lines.find((line) => line.startsWith('tab2api_'));
      expect(tokenLine).toBeDefined();
      const keyId = tokenLine?.split('_')[1];
      expect(keyId).toBeDefined();

      capture.lines.length = 0;
      await commandKeys(config, ['revoke', keyId ?? '']);
      expect(capture.text()).toContain(`Revoked API key ${keyId}`);

      await expect(commandKeys(config, ['bogus'])).rejects.toThrow(/keys list/);
      await expect(commandKeys(config, ['revoke'])).rejects.toThrow(/Key ID/);
    });
  });

  it('serves MCP tool calls over injected stdio streams', async () => {
    await withServer(async (config) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const frames: string[] = [];
      output.on('data', (chunk: Buffer) =>
        frames.push(...chunk.toString('utf8').split('\n').filter(Boolean)),
      );

      const serving = commandMcp(config, input, output);
      input.write(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
      );
      input.write(
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chat","arguments":{"prompt":"mcp ping"}}}\n',
      );
      input.write(
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"status","arguments":{}}}\n',
      );
      input.end();
      await serving;

      const responses = frames.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(responses[0]).toMatchObject({
        id: 1,
        result: { serverInfo: { name: 'tab2api' } },
      });
      expect(responses[1]).toMatchObject({
        id: 2,
        result: { content: [{ type: 'text', text: 'Fake browser response' }] },
      });
      const statusText = (responses[2] as { result: { content: Array<{ text: string }> } }).result
        .content[0]?.text;
      expect(JSON.parse(statusText ?? '{}')).toMatchObject({ session: 'ready' });
    });
  });

  it('resets usage statistics through the admin client', async () => {
    await withServer(async (config) => {
      const capture = captureStdout();
      await commandUsage(config, ['reset']);
      expect(capture.text()).toContain('Usage statistics reset.');
      capture.lines.length = 0;
      await commandUsage(config, []);
      expect(capture.text()).toContain('"tokenCounts": "estimated"');
    });
  });
});
