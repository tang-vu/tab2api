$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'tab2api-cloudflared' -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName 'tab2api-cloudflared'
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
}
