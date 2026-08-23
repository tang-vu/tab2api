param(
    [Parameter(Mandatory = $true)] [string]$InstallerPath,
    [Parameter(Mandatory = $true)] [string]$InstallDirectory,
    [Parameter(Mandatory = $true)] [string]$AllowedRoot,
    [switch]$ExerciseDesktopLifecycle
)

$ErrorActionPreference = 'Stop'

function Assert-StrictChildPath {
    param(
        [Parameter(Mandatory = $true)] [string]$Candidate,
        [Parameter(Mandatory = $true)] [string]$Root,
        [Parameter(Mandatory = $true)] [string]$Description
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rootPrefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description must be a strict child of its approved root."
    }
    return $candidateFull
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)] [string]$FilePath,
        [Parameter(Mandatory = $true)] [string[]]$Arguments,
        [Parameter(Mandatory = $true)] [int]$TimeoutMilliseconds,
        [Parameter(Mandatory = $true)] [string]$Description
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $process.Kill()
            $process.WaitForExit()
            throw "$Description exceeded its bounded safety window."
        }
        if ($process.ExitCode -ne 0) {
            throw "$Description failed with exit code $($process.ExitCode)."
        }
    }
    finally {
        $process.Dispose()
    }
}

function Wait-PathRemoved {
    param(
        [Parameter(Mandatory = $true)] [string]$LiteralPath,
        [Parameter(Mandatory = $true)] [int]$TimeoutMilliseconds,
        [Parameter(Mandatory = $true)] [string]$Description
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ((Test-Path -LiteralPath $LiteralPath) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Path -LiteralPath $LiteralPath) {
        throw "$Description exceeded its bounded safety window."
    }
}

function Stop-TestController {
    param([Parameter(Mandatory = $true)] [Diagnostics.Process]$Process)

    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
            if (-not $Process.WaitForExit(15000)) {
                throw 'A desktop lifecycle probe could not terminate its isolated process.'
            }
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Assert-DesktopControllerLifecycle {
    param([Parameter(Mandatory = $true)] [string]$MainBinary)

    $workingDirectory = Split-Path $MainBinary -Parent
    $primary = $null
    $secondary = $null
    try {
        $primary = Start-Process -FilePath $MainBinary -ArgumentList @('--tab2api-autostart') -WorkingDirectory $workingDirectory -PassThru -WindowStyle Hidden
        if ($primary.WaitForExit(5000)) {
            throw 'The installed desktop controller did not remain available in hidden autostart mode.'
        }

        $secondary = Start-Process -FilePath $MainBinary -ArgumentList @('--tab2api-autostart') -WorkingDirectory $workingDirectory -PassThru -WindowStyle Hidden
        if (-not $secondary.WaitForExit(15000)) {
            throw 'A second desktop controller did not exit within the single-instance safety window.'
        }
        if ($secondary.ExitCode -ne 0 -or $primary.HasExited) {
            throw 'The installed desktop controller did not enforce one live instance.'
        }
    }
    finally {
        if ($null -ne $secondary) {
            Stop-TestController -Process $secondary
        }
        if ($null -ne $primary) {
            Stop-TestController -Process $primary
        }
    }

    $recovered = Start-Process -FilePath $MainBinary -ArgumentList @('--tab2api-autostart') -WorkingDirectory $workingDirectory -PassThru -WindowStyle Hidden
    try {
        if ($recovered.WaitForExit(5000)) {
            throw 'The desktop single-instance lock did not recover after a forced process exit.'
        }
    }
    finally {
        Stop-TestController -Process $recovered
    }
    Write-Output 'Installed desktop controller PASS: hidden startup, single instance, and crash-lock recovery verified.'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or [IO.Path]::GetExtension($installer) -ne '.exe') {
    throw 'The desktop installer must be an existing executable file.'
}
$allowedRootPath = (Resolve-Path -LiteralPath $AllowedRoot).Path
$allowedRootItem = Get-Item -LiteralPath $allowedRootPath -Force
if (($allowedRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The approved install root must not be a reparse point.'
}
$installDirectoryPath = Assert-StrictChildPath -Candidate $InstallDirectory -Root $allowedRootPath -Description 'Install directory'
if ($installDirectoryPath -match '[\r\n"]') {
    throw 'The install directory contains characters unsafe for an NSIS command line.'
}
if (Test-Path -LiteralPath $installDirectoryPath) {
    throw 'The isolated install directory must not already exist.'
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is required for the uninstall retention probe.'
}
$appDataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'dev.tangvu.tab2api'))
$appDataRootExisted = Test-Path -LiteralPath $appDataRoot
$profileProbeDirectory = Assert-StrictChildPath -Candidate (Join-Path $appDataRoot ('installer-smoke-' + [Guid]::NewGuid().ToString('N'))) -Root $appDataRoot -Description 'Profile retention probe'
$profileProbeFile = Join-Path $profileProbeDirectory 'retained.txt'
$startupRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupValueName = 'tab2api'
$startupValue = $null
$startupSeeded = $false

$uninstaller = Join-Path $installDirectoryPath 'uninstall.exe'
$uninstalled = $false
try {
    New-Item -ItemType Directory -Force -Path $profileProbeDirectory | Out-Null
    [IO.File]::WriteAllText($profileProbeFile, 'non-sensitive installer retention probe')

    # NSIS requires /D to be the final, unquoted argument. /NS suppresses shortcut creation.
    Invoke-BoundedProcess -FilePath $installer -Arguments @('/S', '/NS', "/D=$installDirectoryPath") -TimeoutMilliseconds 600000 -Description 'Silent desktop installation'

    $mainBinary = Join-Path $installDirectoryPath 'tab2api-desktop.exe'
    $sidecar = Join-Path $installDirectoryPath 'sidecar'
    foreach ($requiredFile in @($mainBinary, $uninstaller, (Join-Path $sidecar 'bundle-manifest.json'))) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw 'The silent installer did not create the expected application layout.'
        }
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'smoke-desktop-bundle.ps1') -SidecarDirectory $sidecar
    if ($LASTEXITCODE -ne 0) {
        throw "Installed sidecar smoke failed with exit code $LASTEXITCODE."
    }

    if ($ExerciseDesktopLifecycle) {
        Assert-DesktopControllerLifecycle -MainBinary $mainBinary
        $existingStartup = Get-ItemProperty -LiteralPath $startupRegistryPath -Name $startupValueName -ErrorAction SilentlyContinue
        if ($null -ne $existingStartup) {
            throw 'The isolated runner already has a tab2api sign-in launch registration.'
        }
        $startupValue = '"' + $mainBinary + '" --tab2api-autostart'
        New-Item -Path $startupRegistryPath -Force | Out-Null
        New-ItemProperty -LiteralPath $startupRegistryPath -Name $startupValueName -Value $startupValue -PropertyType String | Out-Null
        $startupSeeded = $true
    }

    # Normal NSIS uninstall copies itself to a temporary directory so it can remove the original.
    # The launcher can exit before that temporary child, so completion is the bounded disappearance
    # of the already validated isolated installation directory.
    Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S') -TimeoutMilliseconds 60000 -Description 'Silent desktop uninstallation launcher'
    Wait-PathRemoved -LiteralPath $installDirectoryPath -TimeoutMilliseconds 300000 -Description 'Silent desktop uninstallation'
    $uninstalled = $true

    if (-not (Test-Path -LiteralPath $profileProbeFile -PathType Leaf)) {
        throw 'Silent uninstallation removed app-local data without explicit deletion consent.'
    }
    if ($startupSeeded -and $null -ne (Get-ItemProperty -LiteralPath $startupRegistryPath -Name $startupValueName -ErrorAction SilentlyContinue)) {
        throw 'Silent uninstallation left the tab2api sign-in launch registration behind.'
    }

    Write-Output 'Packaged desktop installer smoke PASS: silent install, offline sidecar, uninstall cleanup, and profile retention verified.'
}
finally {
    try {
        if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
            Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S') -TimeoutMilliseconds 60000 -Description 'Installer smoke cleanup launcher'
            Wait-PathRemoved -LiteralPath $installDirectoryPath -TimeoutMilliseconds 300000 -Description 'Installer smoke cleanup'
        }
    }
    finally {
        if ($startupSeeded) {
            $remainingStartup = Get-ItemProperty -LiteralPath $startupRegistryPath -Name $startupValueName -ErrorAction SilentlyContinue
            if ($null -ne $remainingStartup) {
                if ([string]$remainingStartup.$startupValueName -ne $startupValue) {
                    throw 'Refusing to remove a sign-in launch value that changed during installer smoke.'
                }
                Remove-ItemProperty -LiteralPath $startupRegistryPath -Name $startupValueName
            }
        }
        if (Test-Path -LiteralPath $installDirectoryPath) {
            $installItem = Get-Item -LiteralPath $installDirectoryPath -Force
            if (($installItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Refusing to clean an install directory that became a reparse point.'
            }
            Remove-Item -LiteralPath $installDirectoryPath -Recurse -Force
        }
        if (Test-Path -LiteralPath $profileProbeDirectory) {
            $resolvedProbe = (Resolve-Path -LiteralPath $profileProbeDirectory).Path
            $appDataPrefix = $appDataRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if (-not $resolvedProbe.StartsWith($appDataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Refusing to remove a profile probe outside app-local data.'
            }
            $probeItem = Get-Item -LiteralPath $resolvedProbe -Force
            if (($probeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Refusing to remove a profile probe that became a reparse point.'
            }
            Remove-Item -LiteralPath $resolvedProbe -Recurse -Force
        }
        if (-not $appDataRootExisted -and (Test-Path -LiteralPath $appDataRoot)) {
            $remainingAppData = @(Get-ChildItem -LiteralPath $appDataRoot -Force)
            if ($remainingAppData.Count -eq 0) {
                Remove-Item -LiteralPath $appDataRoot -Force
            }
        }
    }
}
