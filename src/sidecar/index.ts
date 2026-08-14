#!/usr/bin/env node
import process from 'node:process';
import {
  SidecarCommandDecoder,
  SidecarLifecycle,
  SidecarReporter,
  type SidecarStopReason,
} from './lifecycle.js';
import { PackagedSidecarOperations } from './runtime.js';

const argumentsSet = new Set(process.argv.slice(2));
const knownArguments = new Set(['--parent-pipe']);
if ([...argumentsSet].some((argument) => !knownArguments.has(argument))) {
  process.stderr.write('tab2api-sidecar: unsupported argument\n');
  process.exitCode = 2;
} else {
  const reporter = new SidecarReporter(process.stdout);
  const lifecycle = new SidecarLifecycle(new PackagedSidecarOperations(), reporter);
  let exiting = false;

  const releaseParentPipe = (): void => {
    if (argumentsSet.has('--parent-pipe')) process.stdin.pause();
  };

  const shutdown = async (reason: SidecarStopReason): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      await lifecycle.shutdown(reason);
    } catch {
      process.exitCode = 1;
    } finally {
      releaseParentPipe();
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (argumentsSet.has('--parent-pipe')) {
    const decoder = new SidecarCommandDecoder(
      (message) => {
        if (message.command === 'status') lifecycle.reportStatus();
        else void shutdown('parent_request');
      },
      (code) => lifecycle.reportProtocolError(code),
    );
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => decoder.push(chunk));
    process.stdin.once('end', () => void shutdown('parent_stream_closed'));
  }

  try {
    await lifecycle.start();
  } catch {
    process.stderr.write('tab2api-sidecar: startup failed; inspect redacted logs for details\n');
    process.exitCode = 1;
    releaseParentPipe();
  }
}
