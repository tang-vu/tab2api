import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const scripts = new URL('../scripts/windows/', import.meta.url);
const installWorkflow = new URL('../.github/workflows/desktop-install-smoke.yml', import.meta.url);
const desktopWorkflow = new URL('../.github/workflows/desktop.yml', import.meta.url);

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
    expect(prepare).toContain('[Security.Cryptography.SHA256]::Create()');
    expect(prepare).toContain('Get-Sha256Hex -LiteralPath $_.FullName');
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
    expect(smoke).toContain('[Security.Cryptography.SHA256]::Create()');
    expect(smoke).toContain('Get-Sha256Hex -LiteralPath $candidate');
    expect(smoke).toContain('contains files absent from its integrity manifest');
    expect(smoke).toContain("$start.Arguments = 'dist/cli/index.js smoke'");
    expect(smoke).toContain('[string]$SidecarDirectory');
    expect(smoke).toContain("$start.EnvironmentVariables['HTTPS_PROXY'] = 'http://127.0.0.1:9'");
    expect(smoke).not.toMatch(/chatgpt\.com/i);
  });

  it('bounds startup, fake smoke, and shutdown failure paths', async () => {
    const smoke = await readFile(new URL('smoke-desktop-bundle.ps1', scripts), 'utf8');

    expect(smoke).toContain('$Reader.ReadLineAsync()');
    expect(smoke).toContain('$read.Wait($TimeoutMilliseconds)');
    expect(smoke).toContain('$process.StandardOutput.ReadToEndAsync()');
    expect(smoke).toContain('$process.WaitForExit(60000)');
    expect(smoke).toContain('-DisableKeepAlive');
    expect(smoke).toContain("Write-LifecycleCommand -Process $process -Command 'shutdown'");
    expect(smoke).toContain(
      '$Process.StandardInput.BaseStream.Write($payload, 0, $payload.Length)',
    );
    expect(smoke).toContain('decoder explicitly accepts that RFC 8259 interoperability case');
    expect(smoke).toContain('$process.StandardInput.Close()');
    expect(smoke).toContain("-ExpectedEvent 'stopping'");
    expect(smoke).toContain("-ExpectedEvent 'stopped' -TimeoutMilliseconds 30000");
    expect(smoke).toContain('$process.WaitForExit(5000)');
    expect(smoke).toMatch(/finally \{[\s\S]*\$process\.Kill\(\)[\s\S]*\$process\.WaitForExit\(\)/);
    expect(smoke).toMatch(
      /finally \{[\s\S]*Remove-Item -LiteralPath \$smokeDirectory -Recurse -Force/,
    );
  });

  it('installs and uninstalls the NSIS artifact inside a bounded approved root', async () => {
    const installerSmoke = await readFile(new URL('smoke-desktop-installer.ps1', scripts), 'utf8');

    expect(installerSmoke).toContain('must be a strict child of its approved root');
    expect(installerSmoke).toContain('The isolated install directory must not already exist.');
    expect(installerSmoke).toContain("@('/S', '/NS', \"/D=$installDirectoryPath\")");
    expect(installerSmoke).toContain('$process.WaitForExit($TimeoutMilliseconds)');
    expect(installerSmoke).toContain('-SidecarDirectory $sidecar');
    expect(installerSmoke).toContain('[switch]$ExerciseDesktopLifecycle');
    expect(installerSmoke).toContain("@('--tab2api-autostart')");
    expect(installerSmoke).toContain('did not enforce one live instance');
    expect(installerSmoke).toContain('single-instance lock did not recover');
    expect(installerSmoke).toContain("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'");
    expect(installerSmoke).toContain("-Arguments @('/S')");
    expect(installerSmoke).toContain('Wait-PathRemoved -LiteralPath $installDirectoryPath');
    expect(installerSmoke).toContain('function Wait-OwnedRegistryValueRemoved');
    expect(installerSmoke).toContain(
      'Wait-OwnedRegistryValueRemoved -LiteralPath $startupRegistryPath',
    );
    expect(installerSmoke).toContain(
      "-TimeoutMilliseconds 30000 -Description 'Silent desktop sign-in cleanup'",
    );
    expect(installerSmoke).toContain('sign-in launch value that changed during installer smoke');
    expect(installerSmoke).not.toContain('_?=');
    expect(installerSmoke).toContain('removed app-local data without explicit deletion consent');
    expect(installerSmoke).toMatch(
      /finally \{[\s\S]*Remove-Item -LiteralPath \$installDirectoryPath -Recurse -Force/,
    );
    expect(installerSmoke).not.toMatch(/chatgpt\.com/i);
  });

  it('keeps clean-install verification manual, ephemeral, and artifact-free', async () => {
    const workflow = await readFile(installWorkflow, 'utf8');

    expect(workflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('timeout-minutes: 60');
    expect(workflow).toContain('npm run desktop:build:windows');
    expect(workflow).toContain('smoke-desktop-installer.ps1');
    expect(workflow).toContain('-ExerciseDesktopLifecycle');
    expect(workflow).not.toMatch(
      /actions\/upload-artifact|gh\s+release|action-gh-release|chatgpt\.com/i,
    );
  });

  it('audits locked Rust dependencies without granting repository write access', async () => {
    const workflow = await readFile(desktopWorkflow, 'utf8');

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('cargo install cargo-audit --version 0.22.2 --locked');
    expect(workflow).toContain('npm run desktop:audit');
    expect(workflow).not.toMatch(/checks:\s*write|issues:\s*write/);
  });
});
