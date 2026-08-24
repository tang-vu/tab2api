#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import {
  ANTHROPIC_API_MODEL,
  ANTHROPIC_OUTPUT_CLOSE,
  ANTHROPIC_OUTPUT_OPEN,
} from '../src/api/anthropic.js';
import { buildServer } from '../src/api/server.js';
import type { AppConfig } from '../src/config/index.js';
import { createLogger } from '../src/observability/logger.js';
import type { GenerateRequest, GenerateResult } from '../src/provider.js';
import { FakeProvider } from '../src/testing/fake-provider.js';

const SMOKE_TOKEN = 'tab2api-claude-smoke-token-never-a-secret';
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
const CHILD_TIMEOUT_MS = 60_000;
const expectedResult = 'tab2api Claude Code tool loop ok';

class ClaudeCodeSmokeProvider extends FakeProvider {
  private generation = 0;

  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    const base = await super.generate(request);
    this.generation += 1;
    const content =
      this.generation === 1
        ? [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: path.resolve('package.json') },
            },
          ]
        : [{ type: 'text', text: expectedResult }];
    return {
      ...base,
      text: `${ANTHROPIC_OUTPUT_OPEN}${JSON.stringify({ content })}${ANTHROPIC_OUTPUT_CLOSE}`,
    };
  }
}

function smokeConfig(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3210,
    apiToken: SMOKE_TOKEN,
    dataDir,
    profileDir: path.join(dataDir, 'browser-profile'),
    artifactDir: path.join(dataDir, 'debug-artifacts'),
    headless: true,
    browserCdpEndpoint: undefined,
    concurrency: 1,
    queueCapacity: 4,
    requestTimeoutMs: 30_000,
    imageTimeoutMs: 30_000,
    bodyLimitBytes: 262_144,
    mediaLimitBytes: 10_485_760,
    debug: false,
    logLevel: 'silent',
  };
}

function boundedAppend(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CHILD_OUTPUT_BYTES) return current;
  const remaining = MAX_CHILD_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString('utf8');
}

function redacted(value: string): string {
  return value.replaceAll(SMOKE_TOKEN, '[redacted]');
}

async function runClaude(
  command: string,
  origin: string,
  configDirectory: string,
): Promise<string> {
  const argumentsList = [
    '--safe-mode',
    '--no-session-persistence',
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    '--model',
    ANTHROPIC_API_MODEL,
    '--output-format',
    'json',
    '-p',
    `Read package.json and then reply with exactly: ${expectedResult}`,
  ];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: origin,
        ANTHROPIC_AUTH_TOKEN: SMOKE_TOKEN,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CONFIG_DIR: configDirectory,
        DISABLE_AUTOUPDATER: '1',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude Code did not finish within ${CHILD_TIMEOUT_MS}ms.`));
    }, CHILD_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start Claude Code: ${error.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Claude Code exited with ${String(code)}. ${redacted(stderr).trim() || 'No stderr was returned.'}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function main(): Promise<void> {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-claude-smoke-'));
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-claude-config-'));
  const provider = new ClaudeCodeSmokeProvider();
  const app = buildServer({
    config: smokeConfig(runtimeDirectory),
    provider,
    logger: createLogger('silent'),
    anthropicHeartbeatMs: 100,
  });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const configuredCommand = process.env.TAB2API_CLAUDE_COMMAND?.trim();
    const command =
      configuredCommand === undefined || configuredCommand.length === 0
        ? process.platform === 'win32'
          ? 'claude.exe'
          : 'claude'
        : configuredCommand;
    const stdout = await runClaude(command, origin, configDirectory);
    const parsedOutput: unknown = JSON.parse(stdout);
    const result = z
      .object({ is_error: z.literal(false), result: z.string() })
      .loose()
      .parse(parsedOutput);
    if (result.result !== expectedResult) {
      throw new Error(`Claude Code returned an unexpected result: ${result.result}`);
    }
    if (provider.prompts.length !== 2 || !provider.prompts[1]?.includes('type="tool_result"')) {
      throw new Error('Claude Code did not complete the expected two-turn Read tool loop.');
    }
    process.stdout.write(
      'Claude Code compatibility smoke PASS: two API turns and one allowlisted Read tool result.\n',
    );
  } finally {
    await app.close();
    await Promise.allSettled([
      rm(runtimeDirectory, { recursive: true, force: true }),
      rm(configDirectory, { recursive: true, force: true }),
    ]);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unexpected error';
  process.stderr.write(`Claude Code compatibility smoke failed: ${redacted(message)}\n`);
  process.exitCode = 1;
});
