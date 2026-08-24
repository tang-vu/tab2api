import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve('scripts/manual-claude-code.ts');

describe('manual Claude Code live smoke safety contract', () => {
  it('requires explicit opt-in, exact loopback routing, and a revocable client key', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain("process.env.TAB2API_MANUAL_E2E !== '1'");
    expect(source).toContain("const LOOPBACK_ORIGIN = 'http://127.0.0.1:3210'");
    expect(source).toContain('CLIENT_KEY_PATTERN');
    expect(source).toContain('`${LOOPBACK_ORIGIN}/healthz`');
    expect(source).toContain('`${LOOPBACK_ORIGIN}/api/hello`');
    expect(source).toContain("redirect: 'error'");
    expect(source).toContain('response.status !== 204');
  });

  it('isolates Claude, permits only Read, and bounds time, output, and cleanup', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain("'--safe-mode'");
    expect(source).toContain("'--no-session-persistence'");
    expect(source).toContain("'--allowedTools'");
    expect(source).toContain('`Read(${normalizedSentinelPath})`');
    expect(source).toContain("'--permission-mode'");
    expect(source).toContain("'dontAsk'");
    expect(source).toContain('cwd: configDirectory');
    expect(source).toContain('CLAUDE_CONFIG_DIR: configDirectory');
    expect(source).toContain('`tab2api-live-read-${randomUUID()}`');
    expect(source).toContain('writeFile(sentinelPath, expectedResult');
    expect(source).toContain('CHILD_TIMEOUT_MS = 240_000');
    expect(source).toContain('MAX_CHILD_OUTPUT_BYTES = 256 * 1024');
    expect(source).toContain('rm(configDirectory, { recursive: true, force: true })');
    expect(source).not.toContain('process.stdout.write(stdout)');
    expect(source).not.toContain('process.stderr.write(stderr)');
  });
});
