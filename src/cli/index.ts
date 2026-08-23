#!/usr/bin/env node
import { access, mkdir, open, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { z } from 'zod';
import { ChatGptAdapter } from '../adapters/chatgpt/adapter.js';
import { buildServer } from '../api/server.js';
import { createBrowserController } from '../browser/factory.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import { createLogger } from '../observability/logger.js';
import { SystemSpeechSynthesizer } from '../audio/system-speech.js';
import { ApiKeyStore } from '../security/api-keys.js';
import { assertSafeDataChildDirectory } from '../security/paths.js';
import { hardenPrivateDirectoryPermissions } from '../security/private-files.js';
import { UsageStore } from '../store/usage.js';
import { FakeProvider } from '../testing/fake-provider.js';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function dependencies(config: AppConfig) {
  const logger = createLogger(config.logLevel);
  const browser = createBrowserController(config);
  const provider = new ChatGptAdapter(browser, config, logger);
  return { logger, provider };
}

async function start(): Promise<void> {
  const config = await loadConfig();
  const { logger, provider } = await dependencies(config);
  const [apiKeys, usage] = await Promise.all([
    ApiKeyStore.load(config.dataDir, config.apiToken),
    UsageStore.load(config.dataDir),
  ]);
  const app = buildServer({ config, provider, logger, apiKeys, usage });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise === undefined) {
      logger.info({ signal }, 'graceful shutdown');
      shutdownPromise = Promise.resolve().then(() => app.close());
    }
    return shutdownPromise;
  };
  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch(() => {
      process.exitCode = 1;
      logger.error({ signal }, 'graceful shutdown failed');
    });
  };
  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  await app.listen({ host: config.host, port: config.port });
  print(`tab2api listening on http://${config.host}:${config.port}`);
  print('Local API token: ready in private runtime storage (value not printed)');
}

async function login(): Promise<void> {
  const config = await loadConfig();
  const headed = { ...config, headless: false };
  const { provider } = await dependencies(headed);
  print(
    'Opening the dedicated tab2api browser profile. Log in to your own ChatGPT account manually.',
  );
  print(
    'tab2api never asks for or reads your email/password. Complete any security challenge yourself.',
  );
  try {
    await provider.waitForManualLogin((state) => print(`Session state: ${state}`));
    print('Login verified. The dedicated profile is ready.');
  } finally {
    await provider.close();
  }
}

async function checkPort(config: AppConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: config.host, port: config.port }, () => server.close(() => resolve()));
  });
}

async function doctor(): Promise<void> {
  const config = await loadConfig();
  const checks: Array<[string, () => Promise<string>]> = [
    [
      'Node.js',
      async () => {
        const major = Number(process.versions.node.split('.')[0]);
        if (major < 22) throw new Error('Node.js 22+ is required.');
        return process.version;
      },
    ],
    [
      'Chromium executable',
      async () => {
        await access(chromium.executablePath());
        return chromium.executablePath();
      },
    ],
    [
      'Data directory writable',
      async () => {
        await assertSafeDataChildDirectory(config.dataDir, config.profileDir);
        await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
        await hardenPrivateDirectoryPermissions(config.dataDir);
        await assertSafeDataChildDirectory(config.dataDir, config.profileDir);
        const probe = path.join(config.dataDir, `.doctor-${process.pid}`);
        const handle = await open(probe, 'wx', 0o600);
        await handle.close();
        await unlink(probe);
        return config.dataDir;
      },
    ],
    ['Port available', async () => (await checkPort(config), `${config.host}:${config.port}`)],
    [
      'Local API token',
      async () =>
        config.apiToken.length >= 24
          ? 'configured (redacted)'
          : Promise.reject(new Error('missing')),
    ],
    [
      'Local speech engine',
      async () => {
        await new SystemSpeechSynthesizer(config).check();
        return process.platform;
      },
    ],
  ];
  let failed = false;
  for (const [name, check] of checks) {
    try {
      print(`PASS ${name}: ${await check()}`);
    } catch (error) {
      failed = true;
      print(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  const { provider } = await dependencies(config);
  try {
    const state = await provider.health();
    print(`${state === 'ready' ? 'PASS' : 'FAIL'} Browser/session/selectors: ${state}`);
    if (state !== 'ready') failed = true;
  } finally {
    await provider.close();
  }
  if (failed) {
    print(
      'Doctor found issues. Install Chromium with `npx playwright install chromium` or run `npm run login`.',
    );
    process.exitCode = 1;
  }
}

async function smoke(): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger('silent');
  const provider = new FakeProvider('smoke-ok');
  const app = buildServer({ config, provider, logger });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${config.apiToken}` },
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'smoke' }] },
    });
    const smokeResponse = z
      .object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
      .parse(response.json());
    if (response.statusCode !== 200 || smokeResponse.choices[0]?.message.content !== 'smoke-ok') {
      throw new Error('Fake adapter smoke request failed.');
    }
    print('Smoke PASS: authenticated Chat Completions request completed through the FIFO queue.');
  } finally {
    await app.close();
  }
}

async function resetSession(): Promise<void> {
  const config = await loadConfig();
  let response: Response;
  try {
    response = await fetch(`http://${config.host}:${config.port}/admin/session/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Reset did not reach the local service within 10 seconds.');
  }
  if (!response.ok)
    throw new Error(`Reset failed with HTTP ${response.status}. Is the server running?`);
  print('Browser session process reset. Profile and manual login were preserved.');
}

async function keys(): Promise<void> {
  const config = await loadConfig();
  const store = await ApiKeyStore.load(config.dataDir, config.apiToken);
  const operation = process.argv[3] ?? 'list';
  if (operation === 'list') {
    for (const key of store.list())
      print(
        `${key.id}\t${key.role}\t${key.revokedAt === undefined ? 'active' : 'revoked'}\t${key.label}`,
      );
    return;
  }
  if (operation === 'create') {
    const label = process.argv.slice(4).join(' ').trim();
    const created = await store.create(label);
    print(`Created client API key ${created.id} (${created.label}).`);
    print('Copy this token now; only its SHA-256 digest is stored:');
    print(created.token);
    return;
  }
  if (operation === 'revoke') {
    const id = process.argv[4];
    if (id === undefined || !(await store.revoke(id)))
      throw new Error('Key ID is missing, unknown, or already revoked.');
    print(`Revoked API key ${id}.`);
    return;
  }
  throw new Error('Use `keys list`, `keys create <label>`, or `keys revoke <id>`.');
}

async function usage(): Promise<void> {
  const config = await loadConfig();
  const store = await UsageStore.load(config.dataDir);
  print(JSON.stringify(store.snapshot(), null, 2));
}

const command = process.argv[2] ?? 'start';
const commands: Record<string, () => Promise<void>> = {
  start,
  login,
  doctor,
  smoke,
  keys,
  usage,
  'reset-session': resetSession,
};

try {
  const run = commands[command];
  if (run === undefined)
    throw new Error(
      `Unknown command ${command}. Use start, login, doctor, smoke, keys, usage, or reset-session.`,
    );
  await run();
} catch (error) {
  process.stderr.write(
    `tab2api: ${error instanceof Error ? error.message : 'Unexpected failure'}\n`,
  );
  process.exitCode = 1;
}
