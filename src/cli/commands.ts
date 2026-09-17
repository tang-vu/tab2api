import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { z } from 'zod';
import { ChatGptAdapter } from '../adapters/chatgpt/adapter.js';
import { LocalAdminClient, LocalAdminError } from '../api/local-admin-client.js';
import { LocalGenerationClient } from '../api/local-generation-client.js';
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
import { serveMcpStdio, type McpBackend } from '../mcp/server.js';
import type { UiEffort } from '../provider.js';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function dependencies(config: AppConfig) {
  const logger = createLogger(config.logLevel);
  const browser = createBrowserController(config);
  const provider = new ChatGptAdapter(browser, config, logger);
  return { logger, provider };
}

export async function commandStart(): Promise<void> {
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

export async function commandLogin(): Promise<void> {
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

export async function commandDoctor(): Promise<void> {
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

export async function commandSmoke(): Promise<void> {
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

export async function commandResetSession(config: AppConfig): Promise<void> {
  await new LocalAdminClient(config).resetSession();
  print('Browser session process reset. Profile and manual login were preserved.');
}

export async function commandDrain(config: AppConfig): Promise<void> {
  const status = await new LocalAdminClient(config).drain();
  print(
    `Intake closed. ${status.pending} queued / ${status.active} active turn(s) will finish; ` +
      'new requests return draining (503). Resume with `tab2api resume`.',
  );
}

export async function commandResume(config: AppConfig): Promise<void> {
  const status = await new LocalAdminClient(config).resume();
  print(`Intake reopened. ${status.pending} queued / ${status.active} active turn(s).`);
}

export async function commandStatus(config: AppConfig): Promise<void> {
  const client = new LocalAdminClient(config);
  const [session, drain] = await Promise.all([client.sessionState(), client.drainStatus()]);
  print(`Service: reachable at http://${config.host}:${config.port}`);
  print(`Session: ${session.state}`);
  print(`Queue: pending=${drain.pending} active=${drain.active} draining=${drain.draining}`);
}

export async function commandKeys(config: AppConfig, args: readonly string[]): Promise<void> {
  const client = new LocalAdminClient(config);
  const operation = args[0] ?? 'list';
  if (operation === 'list') {
    const response = await client.listApiKeys();
    for (const key of response.data)
      print(
        `${key.id}\t${key.role}\t${key.role === 'client' && key.revokedAt !== undefined ? 'revoked' : 'active'}\t${key.label}`,
      );
    return;
  }
  if (operation === 'create') {
    const label = args.slice(1).join(' ').trim();
    const created = await client.createApiKey(label);
    print(`Created client API key ${created.id} (${created.label}).`);
    print('Copy this token now; only its SHA-256 digest is stored:');
    print(created.token);
    return;
  }
  if (operation === 'revoke') {
    const id = args[1];
    if (id === undefined) throw new Error('Key ID is missing.');
    await client.revokeApiKey(id);
    print(`Revoked API key ${id}.`);
    return;
  }
  throw new Error('Use `keys list`, `keys create <label>`, or `keys revoke <id>`.');
}

export async function commandUsage(config: AppConfig, args: readonly string[]): Promise<void> {
  const client = new LocalAdminClient(config);
  if (args[0] === 'reset') {
    await client.resetUsage();
    print('Usage statistics reset.');
    return;
  }
  const snapshot = await client.usage();
  print(JSON.stringify(snapshot, null, 2));
}

const chatFlagSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

interface ChatArgs {
  prompt: string;
  temporary?: boolean;
  reasoningEffort?: UiEffort;
  conversationId?: string;
  projectId?: string;
}

/**
 * Parses `chat` arguments: `--temporary`, `--effort <level>`, `--conversation <id>`,
 * `--project <id>`, and the remaining words joined as the prompt. When no words remain the
 * caller supplies piped stdin instead.
 */
function parseChatArgs(args: readonly string[], stdinText: string | undefined): ChatArgs {
  const words: string[] = [];
  const parsed: ChatArgs = { prompt: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--temporary') parsed.temporary = true;
    else if (arg === '--effort') {
      const value = args[++index];
      const effort = chatFlagSchema.safeParse(value);
      if (!effort.success) {
        throw new Error('--effort must be one of minimal, low, medium, high, xhigh.');
      }
      parsed.reasoningEffort = effort.data;
    } else if (arg === '--conversation') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--conversation requires a conversation id.');
      }
      parsed.conversationId = value;
    } else if (arg === '--project') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--project requires a project id.');
      }
      parsed.projectId = value;
    } else if (arg?.startsWith('--')) {
      throw new Error(`Unknown chat flag ${arg}.`);
    } else if (arg !== undefined) {
      words.push(arg);
    }
  }
  const prompt = words.length > 0 ? words.join(' ') : (stdinText ?? '').trim();
  if (prompt.length === 0) {
    throw new Error('Provide a prompt argument or pipe one on stdin.');
  }
  return { ...parsed, prompt };
}

export async function commandChat(
  config: AppConfig,
  args: readonly string[],
  stdinText?: string,
): Promise<void> {
  const parsed = parseChatArgs(args, stdinText);
  const client = new LocalGenerationClient(config, {
    timeoutMs: config.requestTimeoutMs + 10_000,
  });
  const text = await client.chat(parsed);
  print(text);
}

export async function commandMcp(
  config: AppConfig,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const generation = new LocalGenerationClient(config, {
    timeoutMs: config.requestTimeoutMs + 10_000,
  });
  const admin = new LocalAdminClient(config);
  const backend: McpBackend = {
    chat: (options) => generation.chat(options),
    countTokens: (prompt) => generation.countTokens(prompt),
    sessionState: () => admin.sessionState(),
    drainStatus: () => admin.drainStatus(),
  };
  // Only JSON-RPC frames may reach the protocol stream; diagnostics belong on stderr.
  if (output === process.stdout) {
    process.stderr.write('tab2api mcp: serving stdio (requires `tab2api start`)\n');
  }
  await serveMcpStdio(input, output, backend);
}

export async function commandVersion(): Promise<void> {
  const packageJson = z
    .looseObject({ version: z.string() })
    .parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')));
  print(`tab2api ${packageJson.version}`);
}

export function commandHelp(): void {
  print(`tab2api - loopback API bridge to an authenticated ChatGPT Web session

Usage: tab2api <command> [args]

Service lifecycle
  start               Start the loopback API server (default command)
  status              Show service reachability, session state, and queue state
  doctor              Run environment and session checks
  login               Open the dedicated browser profile for manual ChatGPT login
  reset-session       Restart the browser process (profile is preserved)
  drain               Stop accepting new turns; finish queued/active work
  resume              Reopen intake after a drain
  smoke               Self-test the API surface with a fake provider

Keys and usage
  keys list|create <label>|revoke <id>   Manage client API keys
  usage [reset]                          Print or reset per-key usage estimates

Generation
  chat [flags] <prompt>   Send one prompt through the queue and print the answer.
                          Reads the prompt from stdin when no argument is given.
      --temporary            Run in a Temporary Chat (not saved to history)
      --effort <level>       minimal|low|medium|high|xhigh composer effort
      --conversation <id>    Continue a saved conversation
      --project <id>         Send inside a ChatGPT project

Integrations
  mcp                 Serve the running service as an MCP server over stdio
                      (register with: claude mcp add tab2api -- tab2api mcp)

Other
  version             Print the installed version
  help                Show this help

Environment: see .env.example (TAB2API_HOST, TAB2API_PORT, TAB2API_TEMPORARY_CHAT, ...).`);
}

export type CommandHandler = (config: AppConfig, args: readonly string[]) => Promise<void>;

/** Commands that need a loaded config and take trailing args. */
export const configuredCommands: Record<string, CommandHandler> = {
  status: (config) => commandStatus(config),
  drain: (config) => commandDrain(config),
  resume: (config) => commandResume(config),
  chat: (config, args) => commandChat(config, args, undefined),
  keys: (config, args) => commandKeys(config, args),
  usage: (config, args) => commandUsage(config, args),
  'reset-session': (config) => commandResetSession(config),
  mcp: (config) => commandMcp(config),
};

/** Commands that manage their own config or need none. */
export const standaloneCommands: Record<string, (args: readonly string[]) => Promise<void>> = {
  start: () => commandStart(),
  login: () => commandLogin(),
  doctor: () => commandDoctor(),
  smoke: () => commandSmoke(),
  version: () => commandVersion(),
  help: async () => commandHelp(),
};

export { LocalAdminError };
