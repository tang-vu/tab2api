import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';

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

export class SystemSpeechSynthesizer implements SpeechSynthesizer {
  constructor(private readonly config: AppConfig) {}

  async synthesize(request: SpeechRequest): Promise<Buffer> {
    const root = path.join(this.config.dataDir, 'audio');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(root, 'speech-'));
    const input = path.join(temporary, 'input.txt');
    const output = path.join(temporary, 'output.wav');
    await writeFile(input, request.text, { encoding: 'utf8', mode: 0o600 });
    try {
      await this.runPlatformSynthesizer(input, output, request.speed, request.signal);
      return await readFile(output);
    } catch {
      if (request.signal.aborted)
        throw new AppError('cancelled', 'Speech synthesis was cancelled.');
      throw new AppError(
        'audio_unavailable',
        'The local operating-system speech engine is unavailable.',
        'On Windows, enable System.Speech; on macOS use `say`; on Linux install `espeak`.',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
        windowsHide: true,
      });
      return;
    }
    await runFile(process.platform === 'darwin' ? 'say' : 'espeak', ['--version']);
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
