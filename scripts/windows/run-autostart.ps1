param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $WorkingDirectory
$runtimeDirectory = Join-Path $WorkingDirectory '.tab2api'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$logPath = Join-Path $runtimeDirectory 'service.log'

for ($attempt = 1; $attempt -le 99; $attempt++) {
    try {
        & $NodePath $EntryPath start *>> $logPath
        $exitCode = $LASTEXITCODE
        "$(Get-Date -Format o) tab2api exited with code $exitCode; watchdog attempt $attempt of 99." | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    catch {
        "$(Get-Date -Format o) tab2api launcher failed: $($_.Exception.Message); watchdog attempt $attempt of 99." | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    if ($attempt -lt 99) {
        $delaySeconds = [Math]::Min(5 * $attempt, 60)
        Start-Sleep -Seconds $delaySeconds
    }
}

exit 1
