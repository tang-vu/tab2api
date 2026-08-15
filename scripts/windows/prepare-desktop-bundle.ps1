$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktopDirectory = Join-Path $repository 'desktop'
$generatedDirectory = Join-Path $desktopDirectory 'generated'
$targetDirectory = Join-Path $generatedDirectory 'sidecar'
$stagingDirectory = Join-Path $generatedDirectory ('.sidecar-staging-' + [Guid]::NewGuid().ToString('N'))

if (-not $targetDirectory.StartsWith($desktopDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to prepare a desktop bundle outside the desktop directory.'
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
    }
    finally {
        Pop-Location
    }

    Copy-Item -LiteralPath (Join-Path $repository 'package.json') -Destination $stagingDirectory
    Copy-Item -LiteralPath (Join-Path $repository 'package-lock.json') -Destination $stagingDirectory
    Copy-Item -LiteralPath (Join-Path $repository 'LICENSE') -Destination $stagingDirectory
    Copy-Item -LiteralPath $node -Destination (Join-Path $stagingDirectory 'node.exe')

    $nodeLicense = Join-Path (Split-Path $node -Parent) 'LICENSE'
    if (Test-Path -LiteralPath $nodeLicense) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stagingDirectory 'NODE-LICENSE')
    }

    npm ci --omit=dev --ignore-scripts --prefix $stagingDirectory
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

    $manifest = [ordered]@{
        format = 1
        node = (& (Join-Path $stagingDirectory 'node.exe') --version)
        package = (Get-Content -Raw (Join-Path $repository 'package.json') | ConvertFrom-Json).version
        platform = (& (Join-Path $stagingDirectory 'node.exe') -p "process.platform + '-' + process.arch")
        generatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $stagingDirectory 'bundle-manifest.json')

    if (Test-Path -LiteralPath $targetDirectory) {
        Remove-Item -LiteralPath $targetDirectory -Recurse -Force
    }
    Move-Item -LiteralPath $stagingDirectory -Destination $targetDirectory
    Write-Output "Prepared the private desktop sidecar resource at $targetDirectory"
}
finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}
