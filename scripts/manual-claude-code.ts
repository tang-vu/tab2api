#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { ANTHROPIC_API_MODEL } from '../src/api/anthropic.js';

const LOOPBACK_ORIGIN = 'http://127.0.0.1:3210';
const CLIENT_KEY_PATTERN = /^tab2api_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/u;
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
const CHILD_TIMEOUT_MS = 240_000;

function boundedAppend(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CHILD_OUTPUT_BYTES) return current;
  const remaining = MAX_CHILD_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString('utf8');
}

async function verifyLoopbackIdentity(): Promise<void> {
  const response = await fetch(`${LOOPBACK_ORIGIN}/healthz`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The loopback health probe returned invalid JSON.');
  }
  const identity = z
    .object({ status: z.literal('ok'), service: z.literal('tab2api') })
    .strict()
    .safeParse(body);
  if (!identity.success) throw new Error('The loopback health probe was not tab2api.');
  if (response.status !== 200)
    throw new Error('The loopback health probe did not return HTTP 200.');
}

async function verifyCredential(token: string): Promise<void> {
  const response = await fetch(`${LOOPBACK_ORIGIN}/api/hello`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error('The temporary client key was not accepted.');
}

function runClaude(
  command: string,
  token: string,
  configDirectory: string,
  sentinelPath: string,
): Promise<string> {
  const normalizedSentinelPath = sentinelPath.replaceAll('\\', '/');
  const excludedEnvironment = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]);
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!excludedEnvironment.has(name) && value !== undefined) childEnvironment[name] = value;
  }
  Object.assign(childEnvironment, {
    ANTHROPIC_BASE_URL: LOOPBACK_ORIGIN,
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: configDirectory,
    DISABLE_AUTOUPDATER: '1',
  });
  const argumentsList = [
    '--safe-mode',
    '--no-chrome',
    '--no-session-persistence',
    '--tools',
    'Read',
    '--allowedTools',
    `Read(${normalizedSentinelPath})`,
    '--permission-mode',
    'dontAsk',
    '--model',
    ANTHROPIC_API_MODEL,
    '--output-format',
    'json',
    '-p',
    `Use the Read tool exactly once on ${normalizedSentinelPath}. That file contains an unpredictable one-line nonce. Do not guess or provide a final answer before the tool result is available. After the tool result, reply with exactly the nonce and nothing else.`,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: configDirectory,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_CHILD_OUTPUT_BYTES + 1, stderrBytes + chunk.byteLength);
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Claude Code exceeded its bounded live-test timeout.')));
    }, CHILD_TIMEOUT_MS);
    child.once('error', () => {
      finish(() => reject(new Error('Claude Code could not be started.')));
    });
    child.once('exit', (code) => {
      finish(() => {
        if (
          stderrBytes > MAX_CHILD_OUTPUT_BYTES ||
          Buffer.byteLength(stdout) > MAX_CHILD_OUTPUT_BYTES
        ) {
          reject(new Error('Claude Code exceeded the bounded output capture.'));
        } else if (code !== 0) {
          reject(new Error(`Claude Code exited with code ${String(code)}.`));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}

async function main(): Promise<void> {
  if (process.env.TAB2API_MANUAL_E2E !== '1') {
    throw new Error('Set TAB2API_MANUAL_E2E=1 to authorize the live ChatGPT UI test.');
  }
  if (process.env.ANTHROPIC_BASE_URL !== LOOPBACK_ORIGIN) {
    throw new Error(`ANTHROPIC_BASE_URL must be exactly ${LOOPBACK_ORIGIN}.`);
  }
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (token === undefined || !CLIENT_KEY_PATTERN.test(token)) {
    throw new Error('A one-time revocable tab2api client key is required.');
  }
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'tab2api-claude-live-'));
  try {
    const expectedResult = `tab2api-live-read-${randomUUID()}`;
    const sentinelPath = path.join(configDirectory, 'read-sentinel.txt');
    await writeFile(sentinelPath, expectedResult, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await verifyLoopbackIdentity();
    await verifyCredential(token);
    const configuredCommand = process.env.TAB2API_CLAUDE_COMMAND?.trim();
    const command =
      configuredCommand === undefined || configuredCommand.length === 0
        ? process.platform === 'win32'
          ? 'claude.exe'
          : 'claude'
        : configuredCommand;
    const stdout = await runClaude(command, token, configDirectory, sentinelPath);
    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(stdout);
    } catch {
      throw new Error('Claude Code returned invalid JSON.');
    }
    const parsedResult = z
      .object({
        is_error: z.boolean(),
        result: z.string(),
        num_turns: z.number().int(),
      })
      .loose()
      .safeParse(parsedOutput);
    if (!parsedResult.success) {
      throw new Error('Claude Code returned an unexpected result envelope.');
    }
    const result = parsedResult.data;
    if (result.is_error) {
      throw new Error(`Claude Code reported an error after ${String(result.num_turns)} turns.`);
    }
    if (result.num_turns < 2 || result.num_turns > 8) {
      throw new Error(
        `Claude Code completed ${String(result.num_turns)} turns instead of the expected bounded tool loop.`,
      );
    }
    if (result.result !== expectedResult) {
      throw new Error(
        `Claude Code completed ${String(result.num_turns)} turns but the final result did not match.`,
      );
    }
    process.stdout.write(
      `Claude Code live smoke PASS: ${String(result.num_turns)} turns and one allowlisted Read result.\n`,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unexpected error';
  process.stderr.write(`Claude Code live smoke failed: ${message}\n`);
  process.exitCode = 1;
});
