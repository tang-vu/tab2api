$ErrorActionPreference = 'Stop'
$taskName = 'tab2api-cloudflared'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Output "Scheduled Task '$taskName' is not installed."
    exit 0
}
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$stopDeadline = (Get-Date).AddSeconds(10)
do {
    Start-Sleep -Milliseconds 200
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} while ($null -ne $task -and [string]$task.State -eq 'Running' -and (Get-Date) -lt $stopDeadline)
if ($null -ne $task -and [string]$task.State -eq 'Running') {
    throw 'The Cloudflare Tunnel task did not stop within 10 seconds.'
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
$removeDeadline = (Get-Date).AddSeconds(10)
do {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task) { Start-Sleep -Milliseconds 200 }
} while ($null -ne $task -and (Get-Date) -lt $removeDeadline)
if ($null -ne $task) {
    throw 'The Cloudflare Tunnel task was not removed within 10 seconds.'
}
Write-Output "Removed Scheduled Task '$taskName'. Tunnel credentials and DNS were preserved."
