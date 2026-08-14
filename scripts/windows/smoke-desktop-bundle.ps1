$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sidecar = (Resolve-Path (Join-Path $repository 'desktop\target\release\sidecar')).Path
$runtimeRoot = Join-Path $repository '.tab2api'
$smokeDirectory = Join-Path $runtimeRoot 'desktop-packaged-smoke'
if (-not $smokeDirectory.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to use a smoke directory outside the ignored runtime root.'
}

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $sidecar 'node.exe'
$start.Arguments = 'dist/sidecar/index.js --parent-pipe'
$start.WorkingDirectory = $sidecar
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.CreateNoWindow = $true
$start.EnvironmentVariables['TAB2API_HOST'] = '127.0.0.1'
$start.EnvironmentVariables['TAB2API_PORT'] = '43210'
$start.EnvironmentVariables['TAB2API_DATA_DIR'] = $smokeDirectory
$start.EnvironmentVariables['TAB2API_PROFILE_DIR'] = Join-Path $smokeDirectory 'browser-profile'
$start.EnvironmentVariables['TAB2API_BROWSER_BACKEND'] = 'playwright'
$start.EnvironmentVariables['PLAYWRIGHT_BROWSERS_PATH'] = Join-Path $sidecar 'ms-playwright'

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
[void]$process.Start()
try {
    $starting = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    $listening = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if ($starting.event -ne 'starting' -or $listening.event -ne 'listening') {
        throw 'The packaged sidecar emitted an unexpected lifecycle.'
    }
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43210/healthz' -TimeoutSec 10
    if ($health.status -ne 'ok' -or $health.service -ne 'tab2api') {
        throw 'The packaged sidecar returned an unexpected health response.'
    }
    $process.StandardInput.WriteLine('{"command":"shutdown"}')
    $process.StandardInput.Flush()
    if (-not $process.WaitForExit(15000)) {
        throw 'The packaged sidecar did not stop within 15 seconds.'
    }
    if ($process.ExitCode -ne 0) {
        throw "The packaged sidecar exited with code $($process.ExitCode)."
    }
    Write-Output 'Packaged desktop sidecar smoke PASS: listening, health, graceful shutdown.'
}
finally {
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
    if (Test-Path -LiteralPath $smokeDirectory) {
        Remove-Item -LiteralPath $smokeDirectory -Recurse -Force
    }
}
