param(
    [string]$SidecarDirectory
)

$ErrorActionPreference = 'Stop'

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)] [string]$LiteralPath)

    $stream = [IO.File]::OpenRead($LiteralPath)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Read-LifecycleEvent {
    param(
        [Parameter(Mandatory = $true)] [IO.StreamReader]$Reader,
        [Parameter(Mandatory = $true)] [string]$ExpectedEvent,
        [int]$TimeoutMilliseconds = 15000
    )

    $read = $Reader.ReadLineAsync()
    if (-not $read.Wait($TimeoutMilliseconds)) {
        throw "Packaged sidecar did not emit $ExpectedEvent within the bounded startup window."
    }
    $line = $read.Result
    if ([string]::IsNullOrWhiteSpace($line)) {
        throw "Packaged sidecar closed its lifecycle stream before $ExpectedEvent."
    }
    try {
        $event = $line | ConvertFrom-Json
    }
    catch {
        throw 'Packaged sidecar emitted malformed lifecycle JSON.'
    }
    if ($event.event -ne $ExpectedEvent) {
        throw "Packaged sidecar emitted an unexpected lifecycle event before $ExpectedEvent."
    }
    return $event
}

function Write-LifecycleCommand {
    param(
        [Parameter(Mandatory = $true)] [Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)] [ValidateSet('status', 'shutdown')] [string]$Command
    )

    # Keep the command bytes UTF-8 across runner console code pages. Windows' redirected
    # StreamWriter can emit one leading BOM when BaseStream is exposed; the bounded sidecar
    # decoder explicitly accepts that RFC 8259 interoperability case only at stream start.
    $payload = [Text.UTF8Encoding]::new($false).GetBytes('{"command":"' + $Command + '"}' + "`n")
    $Process.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
    $Process.StandardInput.BaseStream.Flush()
}

function Assert-BundleIntegrity {
    param([Parameter(Mandatory = $true)] [string]$BundleDirectory)

    $bundlePrefix = $BundleDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $manifestPath = Join-Path $BundleDirectory 'bundle-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Packaged sidecar integrity manifest is missing.'
    }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'Packaged sidecar integrity manifest is invalid.'
    }
    $entries = @($manifest.files)
    if ($manifest.format -ne 2 -or $entries.Count -lt 10) {
        throw 'Packaged sidecar integrity manifest has an unsupported or incomplete format.'
    }

    $seen = @{}
    foreach ($entry in $entries) {
        $relative = [string]$entry.path
        $key = $relative.ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($relative) -or $seen.ContainsKey($key)) {
            throw 'Packaged sidecar integrity manifest contains an invalid or duplicate path.'
        }
        $seen[$key] = $true
        $platformRelative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($platformRelative)) {
            throw 'Packaged sidecar integrity manifest contains a rooted path.'
        }
        $candidate = [IO.Path]::GetFullPath((Join-Path $BundleDirectory $platformRelative))
        if (-not $candidate.StartsWith($bundlePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Packaged sidecar integrity manifest escapes the bundle directory.'
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw 'Packaged sidecar integrity manifest references a missing file.'
        }
        $file = Get-Item -LiteralPath $candidate
        if ([long]$entry.bytes -ne $file.Length) {
            throw 'Packaged sidecar integrity check found an unexpected file size.'
        }
        $actualHash = Get-Sha256Hex -LiteralPath $candidate
        if ($actualHash -ne [string]$entry.sha256) {
            throw 'Packaged sidecar integrity check found an unexpected file hash.'
        }
    }

    $actualFiles = @(Get-ChildItem -LiteralPath $BundleDirectory -File -Recurse |
        Where-Object { $_.FullName -ne $manifestPath })
    if ($actualFiles.Count -ne $entries.Count) {
        throw 'Packaged sidecar contains files absent from its integrity manifest.'
    }

    $sbomRelative = [string]$manifest.sbom
    if ([string]::IsNullOrWhiteSpace($sbomRelative) -or -not $seen.ContainsKey($sbomRelative.ToLowerInvariant())) {
        throw 'Packaged sidecar SBOM is absent from its integrity manifest.'
    }
    $sbomPath = [IO.Path]::GetFullPath((Join-Path $BundleDirectory $sbomRelative))
    if (-not $sbomPath.StartsWith($bundlePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Packaged sidecar SBOM path escapes the bundle directory.'
    }
    try {
        $sbom = Get-Content -LiteralPath $sbomPath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'Packaged sidecar SBOM is invalid.'
    }
    if ($sbom.bomFormat -ne 'CycloneDX' -or $null -eq $sbom.components -or @($sbom.components).Count -lt 1) {
        throw 'Packaged sidecar SBOM is missing required component metadata.'
    }
    Write-Output "Packaged sidecar integrity PASS: $($entries.Count) files and CycloneDX SBOM verified."
}

function Invoke-FakeAdapterSmoke {
    param(
        [Parameter(Mandatory = $true)] [string]$BundleDirectory,
        [Parameter(Mandatory = $true)] [string]$RuntimeDirectory
    )

    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $BundleDirectory 'node.exe'
    $start.Arguments = 'dist/cli/index.js smoke'
    $start.WorkingDirectory = $BundleDirectory
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['TAB2API_HOST'] = '127.0.0.1'
    $start.EnvironmentVariables['TAB2API_PORT'] = '3210'
    $start.EnvironmentVariables['TAB2API_API_TOKEN'] = 'desktop-smoke-only-token-never-use'
    $start.EnvironmentVariables['TAB2API_DATA_DIR'] = $RuntimeDirectory
    $start.EnvironmentVariables['TAB2API_PROFILE_DIR'] = Join-Path $RuntimeDirectory 'browser-profile'
    $start.EnvironmentVariables['TAB2API_BROWSER_BACKEND'] = 'playwright'
    $start.EnvironmentVariables['TAB2API_BROWSER_CDP_ENDPOINT'] = ''
    $start.EnvironmentVariables['TAB2API_DEBUG'] = 'false'
    $start.EnvironmentVariables['TAB2API_LOG_LEVEL'] = 'silent'
    $start.EnvironmentVariables['PLAYWRIGHT_BROWSERS_PATH'] = Join-Path $BundleDirectory 'ms-playwright'
    $start.EnvironmentVariables['HTTP_PROXY'] = 'http://127.0.0.1:9'
    $start.EnvironmentVariables['HTTPS_PROXY'] = 'http://127.0.0.1:9'
    $start.EnvironmentVariables['ALL_PROXY'] = 'http://127.0.0.1:9'
    $start.EnvironmentVariables['NO_PROXY'] = '127.0.0.1,localhost'

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    $stdoutRead = $process.StandardOutput.ReadToEndAsync()
    $stderrRead = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit(60000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'Packaged fake-adapter smoke exceeded its 60-second safety limit.'
        }
        if (-not $stdoutRead.Wait(5000) -or -not $stderrRead.Wait(5000)) {
            throw 'Packaged fake-adapter smoke did not close its output streams.'
        }
        $stdout = $stdoutRead.Result.Trim()
        if ($process.ExitCode -ne 0) {
            throw "Packaged fake-adapter smoke exited with code $($process.ExitCode)."
        }
        if ($stdout -ne 'Smoke PASS: authenticated Chat Completions request completed through the FIFO queue.') {
            throw 'Packaged fake-adapter smoke returned an unexpected result.'
        }
        Write-Output 'Packaged fake-adapter smoke PASS: authenticated request completed offline.'
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
    }
}

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sidecarCandidate = if ([string]::IsNullOrWhiteSpace($SidecarDirectory)) {
    Join-Path $repository 'desktop\target\release\sidecar'
}
else {
    $SidecarDirectory
}
$sidecar = (Resolve-Path -LiteralPath $sidecarCandidate).Path
$runtimeRoot = Join-Path $repository '.tab2api'
$smokeDirectory = Join-Path $runtimeRoot 'desktop-packaged-smoke'
if (-not $smokeDirectory.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to use a smoke directory outside the ignored runtime root.'
}

$portAllocator = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portAllocator.Start()
$smokePort = ([Net.IPEndPoint]$portAllocator.LocalEndpoint).Port
$portAllocator.Stop()

try {
    Assert-BundleIntegrity -BundleDirectory $sidecar
    Invoke-FakeAdapterSmoke -BundleDirectory $sidecar -RuntimeDirectory $smokeDirectory

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
    $start.EnvironmentVariables['TAB2API_PORT'] = [string]$smokePort
    $start.EnvironmentVariables['TAB2API_API_TOKEN'] = 'desktop-smoke-only-token-never-use'
    $start.EnvironmentVariables['TAB2API_DATA_DIR'] = $smokeDirectory
    $start.EnvironmentVariables['TAB2API_PROFILE_DIR'] = Join-Path $smokeDirectory 'browser-profile'
    $start.EnvironmentVariables['TAB2API_BROWSER_BACKEND'] = 'playwright'
    $start.EnvironmentVariables['TAB2API_BROWSER_CDP_ENDPOINT'] = ''
    $start.EnvironmentVariables['TAB2API_DEBUG'] = 'false'
    $start.EnvironmentVariables['TAB2API_LOG_LEVEL'] = 'silent'
    $start.EnvironmentVariables['PLAYWRIGHT_BROWSERS_PATH'] = Join-Path $sidecar 'ms-playwright'

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    try {
        [void](Read-LifecycleEvent -Reader $process.StandardOutput -ExpectedEvent 'starting')
        $listening = Read-LifecycleEvent -Reader $process.StandardOutput -ExpectedEvent 'listening'
        if ($listening.host -ne '127.0.0.1' -or [int]$listening.port -ne $smokePort) {
            throw 'The packaged sidecar did not bind the expected loopback endpoint.'
        }
        # The probe must not retain an idle HTTP socket that can interfere with the shutdown check.
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/healthz" -TimeoutSec 10 -DisableKeepAlive
        if ($health.status -ne 'ok' -or $health.service -ne 'tab2api') {
            throw 'The packaged sidecar returned an unexpected health response.'
        }
        Write-LifecycleCommand -Process $process -Command 'shutdown'
        $process.StandardInput.Close()
        [void](Read-LifecycleEvent -Reader $process.StandardOutput -ExpectedEvent 'stopping')
        [void](Read-LifecycleEvent -Reader $process.StandardOutput -ExpectedEvent 'stopped' -TimeoutMilliseconds 30000)
        if (-not $process.WaitForExit(5000)) {
            throw 'The packaged sidecar emitted stopped but did not exit within five seconds.'
        }
        if ($process.ExitCode -ne 0) {
            throw "The packaged sidecar exited with code $($process.ExitCode)."
        }
        Write-Output 'Packaged desktop sidecar smoke PASS: loopback health and graceful shutdown verified.'
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
    }
}
finally {
    if (Test-Path -LiteralPath $smokeDirectory) {
        Remove-Item -LiteralPath $smokeDirectory -Recurse -Force
    }
}
