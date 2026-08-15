$ErrorActionPreference = 'Stop'
$taskName = 'tab2api'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($null -eq $task) {
    Write-Output "Scheduled Task '$taskName' is not installed."
    exit 1
}

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "Task state: $($task.State)"
Write-Output "Last result: $($info.LastTaskResult)"
Write-Output "Last run: $($info.LastRunTime)"

$port = 3210
$envPath = Join-Path $repository '.env'
if (Test-Path -LiteralPath $envPath) {
    $portLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^TAB2API_PORT=\d+$' } | Select-Object -Last 1
    if ($portLine) { $port = [int]($portLine -replace '^TAB2API_PORT=', '') }
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
    Write-Output "HTTP liveness: $($health.status) at http://127.0.0.1:$port"
}
catch {
    Write-Output "HTTP liveness: unavailable at http://127.0.0.1:$port"
    exit 1
}
