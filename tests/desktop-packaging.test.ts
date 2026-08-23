import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const scripts = new URL('../scripts/windows/', import.meta.url);

describe('Windows desktop packaging contract', () => {
  it('builds a complete hashed inventory and production dependency SBOM', async () => {
    const prepare = await readFile(new URL('prepare-desktop-bundle.ps1', scripts), 'utf8');

    expect(prepare).toContain("Copy-Item -LiteralPath (Join-Path $repository 'NOTICE.md')");
    expect(prepare).toContain(
      "throw 'The selected Node.js runtime does not include its required LICENSE file.'",
    );
    expect(prepare).toContain('Service build failed with exit code');
    expect(prepare).toContain('Production dependency installation failed with exit code');
    expect(prepare).toMatch(/npm sbom --omit=dev --sbom-format cyclonedx/);
    expect(prepare).toContain("PSObject.Properties.Remove('devDependencies')");
    expect(prepare).toContain("Join-Path $stagingDirectory '.gitkeep'");
    expect(prepare).toContain("Join-Path $desktopDirectory 'target\\release\\sidecar'");
    expect(prepare).toContain('Remove-Item -LiteralPath $releaseSidecarDirectory -Recurse -Force');
    expect(prepare).toContain('must not contain Playwright headless-shell binaries');
    expect(prepare).toMatch(/Get-ChildItem[^\n]+-File -Recurse/);
    expect(prepare).toMatch(/Get-FileHash[^\n]+-Algorithm SHA256/);
    expect(prepare).toContain('format = 2');
    expect(prepare).toContain("sbom = 'sidecar-sbom.cdx.json'");
    expect(prepare).toContain('files = $inventory');
  });

  it('fails closed on bundle drift before running an offline fake-adapter smoke', async () => {
    const smoke = await readFile(new URL('smoke-desktop-bundle.ps1', scripts), 'utf8');

    expect(smoke).toMatch(/StartsWith\(\$bundlePrefix, \[StringComparison\]::OrdinalIgnoreCase\)/);
    expect(smoke).toContain('integrity manifest contains an invalid or duplicate path');
    expect(smoke).toContain('integrity check found an unexpected file size');
    expect(smoke).toContain('integrity check found an unexpected file hash');
    expect(smoke).toContain('contains files absent from its integrity manifest');
    expect(smoke).toContain("$start.Arguments = 'dist/cli/index.js smoke'");
    expect(smoke).toContain("$start.EnvironmentVariables['HTTPS_PROXY'] = 'http://127.0.0.1:9'");
    expect(smoke).not.toMatch(/chatgpt\.com/i);
  });

  it('bounds startup, fake smoke, and shutdown failure paths', async () => {
    const smoke = await readFile(new URL('smoke-desktop-bundle.ps1', scripts), 'utf8');

    expect(smoke).toContain('$Reader.ReadLineAsync()');
    expect(smoke).toContain('$read.Wait($TimeoutMilliseconds)');
    expect(smoke).toContain('$process.StandardOutput.ReadToEndAsync()');
    expect(smoke).toContain('$process.WaitForExit(60000)');
    expect(smoke).toContain('$process.WaitForExit(15000)');
    expect(smoke).toMatch(/finally \{[\s\S]*\$process\.Kill\(\)[\s\S]*\$process\.WaitForExit\(\)/);
    expect(smoke).toMatch(
      /finally \{[\s\S]*Remove-Item -LiteralPath \$smokeDirectory -Recurse -Force/,
    );
  });
});
