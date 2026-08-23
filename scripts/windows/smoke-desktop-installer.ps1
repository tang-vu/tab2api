param(
    [Parameter(Mandatory = $true)] [string]$InstallerPath,
    [Parameter(Mandatory = $true)] [string]$InstallDirectory,
    [Parameter(Mandatory = $true)] [string]$AllowedRoot
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

    # _?= keeps the uninstaller in place so the bounded parent can wait for complete removal.
    Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S', "_?=$installDirectoryPath") -TimeoutMilliseconds 300000 -Description 'Silent desktop uninstallation'
    $uninstalled = $true

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath $installDirectoryPath) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if (Test-Path -LiteralPath $installDirectoryPath) {
        throw 'Silent uninstallation left files in the isolated install directory.'
    }
    if (-not (Test-Path -LiteralPath $profileProbeFile -PathType Leaf)) {
        throw 'Silent uninstallation removed app-local data without explicit deletion consent.'
    }

    Write-Output 'Packaged desktop installer smoke PASS: silent install, offline sidecar, uninstall, and profile retention verified.'
}
finally {
    try {
        if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
            Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S', "_?=$installDirectoryPath") -TimeoutMilliseconds 300000 -Description 'Installer smoke cleanup'
        }
    }
    finally {
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
