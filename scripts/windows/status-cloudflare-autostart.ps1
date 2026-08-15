param([string]$RuntimeDirectory)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) {
    $RuntimeDirectory = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.tab2api'
}
$task = Get-ScheduledTask -TaskName 'tab2api-cloudflared' -ErrorAction SilentlyContinue
$description = if ($null -eq $task) { '' } else { [string]$task.Description }
$mode = if ($description.StartsWith('Access-protected', [StringComparison]::Ordinal)) {
    'access'
}
elseif ($description.StartsWith('Bearer-only', [StringComparison]::Ordinal)) {
    'bearer_only'
}
else {
    'none'
}
[ordered]@{
    cloudflared_installed = $null -ne (Get-Command cloudflared.exe -ErrorAction SilentlyContinue)
    config_ready = Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'cloudflared-tab2api.yml') -PathType Leaf
    access_probe_ready = Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'cloudflared-access-probe.yml') -PathType Leaf
    task_installed = $null -ne $task
    running = $null -ne $task -and [string]$task.State -eq 'Running'
    mode = $mode
} | ConvertTo-Json -Compress
