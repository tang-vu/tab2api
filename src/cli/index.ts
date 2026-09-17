#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { LocalAdminError } from '../api/local-admin-client.js';
import { LocalGenerationError } from '../api/local-generation-client.js';
import { loadConfig } from '../config/index.js';
import { commandChat, commandHelp, configuredCommands, standaloneCommands } from './commands.js';

const COMMAND_ALIASES: Record<string, string> = {
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
};

async function readStdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: readonly string[]): Promise<void> {
  const raw = argv[0] ?? 'start';
  const command = COMMAND_ALIASES[raw] ?? raw;
  const args = argv.slice(1);

  const standalone = standaloneCommands[command];
  if (standalone !== undefined) {
    await standalone(args);
    return;
  }
  const configured = configuredCommands[command];
  if (configured !== undefined) {
    const config = await loadConfig();
    if (command === 'chat') {
      await commandChat(config, args, await readStdinText());
      return;
    }
    await configured(config, args);
    return;
  }
  commandHelp();
  throw new Error(`Unknown command ${raw}.`);
}

function invokedAsEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const typed = error instanceof LocalAdminError || error instanceof LocalGenerationError;
    const prefix = typed ? `tab2api (${error.code})` : 'tab2api';
    process.stderr.write(
      `${prefix}: ${error instanceof Error ? error.message : 'Unexpected failure'}\n`,
    );
    process.exitCode = 1;
  }
}
