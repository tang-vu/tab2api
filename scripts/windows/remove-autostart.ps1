$ErrorActionPreference = 'Stop'
$taskName = 'tab2api'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($null -eq $task) {
    Write-Output "Scheduled Task '$taskName' is not installed."
    exit 0
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Removed Scheduled Task '$taskName'. Runtime data and browser profile were preserved."
