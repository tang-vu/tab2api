import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import { assertSafeDataChildDirectory } from '../security/paths.js';
import {
  atomicWritePrivateFile,
  hardenPrivateDirectoryPermissions,
  readPrivateBufferFile,
} from '../security/private-files.js';

const runFile = promisify(execFile);

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface SpeechRequest {
  text: string;
  speed: number;
  signal: AbortSignal;
}

export interface SpeechSynthesizer {
  synthesize(request: SpeechRequest): Promise<Buffer>;
  check(): Promise<void>;
}

type PlatformSynthesizer = (
  input: string,
  output: string,
  speed: number,
  signal: AbortSignal,
) => Promise<void>;

type SpeechOutcome =
  { readonly ok: true; readonly audio: Buffer } | { readonly ok: false; readonly error: AppError };

function speechAbortError(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError && signal.reason.code === 'timeout'
    ? new AppError('timeout', 'Speech synthesis timed out.')
    : new AppError('cancelled', 'Speech synthesis was cancelled.');
}

function isWave(audio: Buffer): boolean {
  return (
    audio.length >= 12 &&
    audio.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    audio.subarray(8, 12).equals(Buffer.from('WAVE'))
  );
}

export class SystemSpeechSynthesizer implements SpeechSynthesizer {
  constructor(
    private readonly config: AppConfig,
    private readonly platformSynthesizer?: PlatformSynthesizer,
  ) {}

  async synthesize(request: SpeechRequest): Promise<Buffer> {
    if (request.signal.aborted) throw speechAbortError(request.signal);
    const root = path.join(this.config.dataDir, 'audio');
    let temporary: string;
    try {
      await assertSafeDataChildDirectory(this.config.dataDir, root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await hardenPrivateDirectoryPermissions(this.config.dataDir);
      await hardenPrivateDirectoryPermissions(root);
      await assertSafeDataChildDirectory(this.config.dataDir, root);
      temporary = await mkdtemp(path.join(root, 'speech-'));
    } catch (error) {
      if (request.signal.aborted) throw speechAbortError(request.signal);
      if (error instanceof AppError) throw error;
      throw new AppError(
        'storage_unavailable',
        'The speech workspace could not be created safely.',
      );
    }
    const input = path.join(temporary, 'input.txt');
    const output = path.join(temporary, 'output.wav');
    let outcome: SpeechOutcome;
    try {
      await assertSafeDataChildDirectory(root, temporary);
      await hardenPrivateDirectoryPermissions(temporary);
      await atomicWritePrivateFile(temporary, input, request.text);
      await atomicWritePrivateFile(temporary, output, '');
      await (this.platformSynthesizer ?? this.runPlatformSynthesizer.bind(this))(
        input,
        output,
        request.speed,
        request.signal,
      );
      if (request.signal.aborted) throw speechAbortError(request.signal);
      const audio = await readPrivateBufferFile(temporary, output, this.config.mediaLimitBytes);
      if (audio === undefined || !isWave(audio)) {
        throw new AppError('audio_unavailable', 'The speech engine returned invalid WAV audio.');
      }
      outcome = { ok: true, audio };
    } catch (error) {
      outcome = {
        ok: false,
        error: request.signal.aborted
          ? speechAbortError(request.signal)
          : error instanceof AppError
            ? error
            : new AppError(
                'audio_unavailable',
                'The local operating-system speech engine is unavailable.',
                'On Windows, enable System.Speech; on macOS use `say`; on Linux install `espeak`.',
              ),
      };
    }
    try {
      await assertSafeDataChildDirectory(root, temporary);
      await rm(temporary, { recursive: true, force: true });
    } catch {
      throw new AppError(
        'storage_unavailable',
        'Temporary speech data could not be removed safely.',
      );
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.audio;
  }

  async check(): Promise<void> {
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop';",
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        '$s.Dispose();',
      ].join(' ');
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 10_000,
        windowsHide: true,
      });
      return;
    }
    await runFile(process.platform === 'darwin' ? 'say' : 'espeak', ['--version'], {
      timeout: 10_000,
    });
  }

  private async runPlatformSynthesizer(
    input: string,
    output: string,
    speed: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (process.platform === 'win32') {
      const rate = Math.max(-10, Math.min(10, Math.round(Math.log2(speed) * 5)));
      const script = [
        "$ErrorActionPreference = 'Stop';",
        `$inputPath = ${powerShellLiteral(input)};`,
        `$outputPath = ${powerShellLiteral(output)};`,
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        `$s.Rate = ${rate};`,
        '$s.SetOutputToWaveFile($outputPath);',
        '$s.Speak([IO.File]::ReadAllText($inputPath));',
        '$s.Dispose();',
      ].join(' ');
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        signal,
        windowsHide: true,
      });
      return;
    }
    if (process.platform === 'darwin') {
      await runFile(
        'say',
        ['-f', input, '-o', output, '--file-format=WAVE', `--rate=${Math.round(175 * speed)}`],
        { signal },
      );
      return;
    }
    await runFile('espeak', ['-f', input, '-w', output, '-s', String(Math.round(175 * speed))], {
      signal,
    });
  }
}
