$ErrorActionPreference = 'Stop'
$taskName = 'tab2api'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entryPath = Join-Path $repository 'dist\cli\index.js'
$runnerPath = Join-Path $repository 'scripts\windows\run-autostart.ps1'
$envPath = Join-Path $repository '.env'

if (-not (Test-Path -LiteralPath $entryPath)) {
    throw 'Production build is missing. Run npm run build first.'
}
if (-not (Test-Path -LiteralPath $envPath)) {
    throw '.env is missing. Copy .env.example to .env and configure it first.'
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}" -EntryPath "{2}" -WorkingDirectory "{3}"' -f $runnerPath, $nodePath, $entryPath, $repository
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $repository
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Local-only tab2api bridge; starts at user logon and restarts after failures.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started Scheduled Task '$taskName'."
Write-Output 'It runs after this user logs in, binds according to .env, and restarts up to 99 times after failures.'
