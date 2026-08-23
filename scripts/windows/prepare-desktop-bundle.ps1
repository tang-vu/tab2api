$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktopDirectory = Join-Path $repository 'desktop'
$generatedDirectory = Join-Path $desktopDirectory 'generated'
$targetDirectory = Join-Path $generatedDirectory 'sidecar'
$releaseSidecarDirectory = Join-Path $desktopDirectory 'target\release\sidecar'
$stagingDirectory = Join-Path $generatedDirectory ('.sidecar-staging-' + [Guid]::NewGuid().ToString('N'))

if (-not $targetDirectory.StartsWith($desktopDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to prepare a desktop bundle outside the desktop directory.'
}
$releaseDirectory = Join-Path $desktopDirectory 'target\release'
if (-not $releaseSidecarDirectory.StartsWith($releaseDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a packaged sidecar outside the desktop release directory.'
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
    throw 'Node.js 22+ is required to prepare the desktop sidecar.'
}

New-Item -ItemType Directory -Force -Path $generatedDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

try {
    Push-Location $repository
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Service build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    Copy-Item -LiteralPath (Join-Path $repository 'package.json') -Destination $stagingDirectory
    Copy-Item -LiteralPath (Join-Path $repository 'package-lock.json') -Destination $stagingDirectory
    Copy-Item -LiteralPath (Join-Path $repository 'LICENSE') -Destination $stagingDirectory
    Copy-Item -LiteralPath (Join-Path $repository 'NOTICE.md') -Destination $stagingDirectory
    Copy-Item -LiteralPath $node -Destination (Join-Path $stagingDirectory 'node.exe')

    $nodeLicense = Join-Path (Split-Path $node -Parent) 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
        throw 'The selected Node.js runtime does not include its required LICENSE file.'
    }
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stagingDirectory 'NODE-LICENSE')

    npm ci --omit=dev --ignore-scripts --prefix $stagingDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Production dependency installation failed with exit code $LASTEXITCODE."
    }
    $stagedPackagePath = Join-Path $stagingDirectory 'package.json'
    $stagedPackage = Get-Content -LiteralPath $stagedPackagePath -Raw | ConvertFrom-Json
    [void]$stagedPackage.PSObject.Properties.Remove('devDependencies')
    $stagedPackageText = $stagedPackage | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($stagedPackagePath, $stagedPackageText + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    Copy-Item -LiteralPath (Join-Path $repository 'dist') -Destination $stagingDirectory -Recurse

    $browserDirectory = Join-Path $stagingDirectory 'ms-playwright'
    $previousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
    try {
        $env:PLAYWRIGHT_BROWSERS_PATH = $browserDirectory
        # The desktop app is always headed. Excluding the headless-only shell saves roughly 115 MiB.
        & (Join-Path $stagingDirectory 'node.exe') (Join-Path $stagingDirectory 'node_modules\playwright\cli.js') install chromium --no-shell
        if ($LASTEXITCODE -ne 0) {
            throw "Playwright Chromium installation failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserPath
    }

    $chromiumDirectories = @(Get-ChildItem -LiteralPath $browserDirectory -Directory | Where-Object { $_.Name -match '^chromium-[0-9]+$' })
    if ($chromiumDirectories.Count -ne 1) {
        throw 'The staged bundle must contain exactly one Playwright Chromium revision.'
    }
    $headlessShellDirectories = @(Get-ChildItem -LiteralPath $browserDirectory -Directory | Where-Object { $_.Name -match '^chromium_headless_shell-[0-9]+$' })
    if ($headlessShellDirectories.Count -ne 0) {
        throw 'The headed desktop bundle must not contain Playwright headless-shell binaries.'
    }
    $chromiumExecutables = @(Get-ChildItem -LiteralPath $chromiumDirectories[0].FullName -Filter 'chrome.exe' -File -Recurse)
    if ($chromiumExecutables.Count -ne 1) {
        throw 'The staged Playwright Chromium executable is missing or ambiguous.'
    }

    $sbomPath = Join-Path $stagingDirectory 'sidecar-sbom.cdx.json'
    $sbomOutput = & npm sbom --omit=dev --sbom-format cyclonedx --prefix $stagingDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Production dependency SBOM generation failed with exit code $LASTEXITCODE."
    }
    $sbomText = $sbomOutput -join [Environment]::NewLine
    try {
        $sbom = $sbomText | ConvertFrom-Json
    }
    catch {
        throw 'Production dependency SBOM generation returned invalid JSON.'
    }
    if ($sbom.bomFormat -ne 'CycloneDX' -or $null -eq $sbom.components -or @($sbom.components).Count -lt 1) {
        throw 'Production dependency SBOM is missing required CycloneDX component metadata.'
    }
    [IO.File]::WriteAllText($sbomPath, $sbomText + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    # Preserve the tracked placeholder when the generated directory is atomically replaced.
    [IO.File]::WriteAllBytes((Join-Path $stagingDirectory '.gitkeep'), [byte[]]@(10))

    $manifestPath = Join-Path $stagingDirectory 'bundle-manifest.json'
    $inventory = @(Get-ChildItem -LiteralPath $stagingDirectory -File -Recurse |
        Where-Object { $_.FullName -ne $manifestPath } |
        Sort-Object -Property FullName |
        ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($stagingDirectory.Length + 1).Replace('\', '/')
                bytes = [long]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        })
    if ($inventory.Count -lt 10) {
        throw 'The staged bundle inventory is unexpectedly small.'
    }

    $manifest = [ordered]@{
        format = 2
        node = (& (Join-Path $stagingDirectory 'node.exe') --version)
        package = (Get-Content -Raw (Join-Path $repository 'package.json') | ConvertFrom-Json).version
        platform = (& (Join-Path $stagingDirectory 'node.exe') -p "process.platform + '-' + process.arch")
        chromium = $chromiumDirectories[0].Name
        sbom = 'sidecar-sbom.cdx.json'
        files = $inventory
        generatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $manifestPath

    if (Test-Path -LiteralPath $targetDirectory) {
        Remove-Item -LiteralPath $targetDirectory -Recurse -Force
    }
    Move-Item -LiteralPath $stagingDirectory -Destination $targetDirectory
    # Tauri overlays directory resources instead of pruning removed files. Clear the prior
    # copied resource so obsolete code or browser binaries cannot survive into a new package.
    if (Test-Path -LiteralPath $releaseSidecarDirectory) {
        Remove-Item -LiteralPath $releaseSidecarDirectory -Recurse -Force
    }
    Write-Output "Prepared the private desktop sidecar resource at $targetDirectory"
}
finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}
