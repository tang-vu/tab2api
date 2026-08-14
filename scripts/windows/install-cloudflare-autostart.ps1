param([switch]$AllowBearerOnly)

$ErrorActionPreference = 'Stop'
$taskName = 'tab2api-cloudflared'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeDirectory = Join-Path $repository '.tab2api'
$configPath = Join-Path $runtimeDirectory 'cloudflared-tab2api.yml'
$probePath = Join-Path $runtimeDirectory 'cloudflared-access-probe.yml'
$cloudflaredPath = (Get-Command cloudflared.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Missing ignored runtime config: $configPath"
}
if (-not (Test-Path -LiteralPath $probePath)) {
    throw "Missing ignored Access probe config: $probePath"
}

& $cloudflaredPath --config $configPath tunnel ingress validate
if ($LASTEXITCODE -ne 0) { throw 'The tab2api tunnel ingress configuration is invalid.' }
& $cloudflaredPath --config $probePath tunnel ingress validate
if ($LASTEXITCODE -ne 0) { throw 'The Cloudflare Access probe configuration is invalid.' }

if (-not $AllowBearerOnly) {
    # The probe publishes only a fixed 418 response, never the tab2api origin. Installation
    # continues only when Cloudflare Access intercepts it first and redirects to its login host.
    $probe = Start-Process -FilePath $cloudflaredPath -ArgumentList @('--config', $probePath, 'tunnel', 'run') -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Seconds 5
        $status = 0
        $location = $null
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://tab2api.tangvu.dev/healthz' -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
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
            throw "Cloudflare Access is not protecting tab2api.tangvu.dev (probe HTTP $status). Create Access or explicitly use the bearer-only installer."
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

$arguments = '--config "{0}" tunnel run' -f $configPath
$action = New-ScheduledTaskAction -Execute $cloudflaredPath -Argument $arguments -WorkingDirectory $repository
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = if ($AllowBearerOnly) { 'Bearer-only Cloudflare Tunnel for the loopback-only personal tab2api origin.' } else { 'Access-protected Cloudflare Tunnel for the loopback-only tab2api origin.' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started Scheduled Task '$taskName'."
