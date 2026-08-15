param(
    [string]$RuntimeDirectory,
    [string]$WorkingDirectory,
    [string]$Hostname = $env:TAB2API_TUNNEL_HOSTNAME,
    [switch]$AllowBearerOnly
)

$ErrorActionPreference = 'Stop'
$taskName = 'tab2api-cloudflared'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) { $RuntimeDirectory = Join-Path $repository '.tab2api' }
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { $WorkingDirectory = $repository }
$runtimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$workingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$configPath = Join-Path $runtimeDirectory 'cloudflared-tab2api.yml'
$probePath = Join-Path $runtimeDirectory 'cloudflared-access-probe.yml'
$cloudflaredPath = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$hostname = if ([string]::IsNullOrWhiteSpace($Hostname)) { '' } else { $Hostname.Trim().ToLowerInvariant() }
if ($hostname -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
    throw 'A valid dedicated tunnel hostname is required. Set TAB2API_TUNNEL_HOSTNAME or use -Hostname.'
}

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Missing ignored runtime config: $configPath"
}
if (-not $AllowBearerOnly -and -not (Test-Path -LiteralPath $probePath)) {
    throw "Missing ignored Access probe config: $probePath"
}

& $cloudflaredPath --config $configPath tunnel ingress validate
if ($LASTEXITCODE -ne 0) { throw 'The tab2api tunnel ingress configuration is invalid.' }

if (-not $AllowBearerOnly) {
    & $cloudflaredPath --config $probePath tunnel ingress validate
    if ($LASTEXITCODE -ne 0) { throw 'The Cloudflare Access probe configuration is invalid.' }

    # The probe publishes only a fixed 418 response, never the tab2api origin. Installation
    # continues only when Cloudflare Access intercepts it first and redirects to its login host.
    $probe = Start-Process -FilePath $cloudflaredPath -ArgumentList @('--config', $probePath, 'tunnel', 'run') -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Seconds 5
        $status = 0
        $location = $null
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "https://$hostname/healthz" -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
            $status = [int]$response.StatusCode
            $location = $response.Headers.Location
        }
        catch {
            if ($null -eq $_.Exception.Response) { throw }
            $status = [int]$_.Exception.Response.StatusCode
            $location = $_.Exception.Response.Headers.Location
        }
        $accessHost = if ($location) { ([uri]$location).Host } else { '' }
        if (($status -ne 302 -and $status -ne 303) -or -not $accessHost.EndsWith('.cloudflareaccess.com', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Cloudflare Access is not protecting the configured hostname (probe HTTP $status). Create Access or explicitly use the bearer-only installer."
        }
    }
    finally {
        $runningProbe = Get-Process -Id $probe.Id -ErrorAction SilentlyContinue
        if ($null -ne $runningProbe -and $runningProbe.ProcessName -eq 'cloudflared') {
            Stop-Process -Id $probe.Id -Force
        }
    }
}
else {
    Write-Warning 'Installing bearer-only public routing by explicit operator request. Cloudflare Access is not enabled.'
}

# Task Scheduler transitions are asynchronous. Fully settle an older task before replacing it so
# Disable -> Enable cannot race with an instance that Windows is still stopping.
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $stopDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    } while ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running' -and (Get-Date) -lt $stopDeadline)
    if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') {
        throw 'The previous Cloudflare Tunnel task did not stop within 10 seconds.'
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    $removeDeadline = (Get-Date).AddSeconds(10)
    do {
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $existingTask) { Start-Sleep -Milliseconds 200 }
    } while ($null -ne $existingTask -and (Get-Date) -lt $removeDeadline)
    if ($null -ne $existingTask) {
        throw 'The previous Cloudflare Tunnel task was not removed within 10 seconds.'
    }
}

$arguments = '--config "{0}" tunnel run' -f $configPath
$action = New-ScheduledTaskAction -Execute $cloudflaredPath -Argument $arguments -WorkingDirectory $workingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = if ($AllowBearerOnly) { 'Bearer-only Cloudflare Tunnel for the loopback-only personal tab2api origin.' } else { 'Access-protected Cloudflare Tunnel for the loopback-only tab2api origin.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$startDeadline = (Get-Date).AddSeconds(10)
do {
    Start-Sleep -Milliseconds 200
    $startedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} while (($null -eq $startedTask -or [string]$startedTask.State -ne 'Running') -and (Get-Date) -lt $startDeadline)
if ($null -eq $startedTask -or [string]$startedTask.State -ne 'Running') {
    throw 'The Cloudflare Tunnel task did not reach Running within 10 seconds.'
}
Write-Output "Installed and started Scheduled Task '$taskName'."
