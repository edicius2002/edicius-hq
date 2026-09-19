[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$PiHost,

    [ValidatePattern('^http://127\.0\.0\.1(?::[1-9][0-9]{0,4})?$')]
    [string]$LegacyApiBase = 'http://127.0.0.1:8000'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'Edicius airfare'
$LegacyRefreshEndpoint = "$LegacyApiBase/api/tweets/thsottiaux/refresh"
$LegacyWatchEndpoint = "$LegacyApiBase/api/tweets/thsottiaux/watch"
$Collectors = @(
    [pscustomobject]@{ Name = 'sentiment'; Unit = 'edicius-sentiment.timer'; Service = 'edicius-sentiment.service'; RequireComplete = $true; JournalMarker = 'Finished Edicius sentiment collector pass.' },
    [pscustomobject]@{ Name = 'x-posts'; Unit = 'edicius-tweets.service'; Service = 'edicius-tweets.service'; RequireComplete = $false; JournalMarker = 'Started Edicius X post collector.' },
    [pscustomobject]@{ Name = 'market'; Unit = 'edicius-market.service'; Service = 'edicius-market.service'; RequireComplete = $false; JournalMarker = 'Started Edicius market collector worker.' },
    [pscustomobject]@{ Name = 'airfare'; Unit = 'edicius-airfare.timer'; Service = 'edicius-airfare.service'; RequireComplete = $true; JournalMarker = 'Finished Edicius Airfare collector pass.' }
)

function Invoke-PiChecked([string]$Command) {
    # Every caller supplies a fixed command assembled from the fixed mappings above.
    & ssh -- $PiHost $Command
    if ($LASTEXITCODE -ne 0) { throw "Pi command failed: $Command" }
}

function Invoke-LegacyWatchRequest([ValidateSet('Delete', 'Post')][string]$Method) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $LegacyWatchEndpoint -Method $Method
    if ($response.StatusCode -ne 202) { throw "Legacy X watcher $Method did not return 202." }
    $body = $response.Content | ConvertFrom-Json
    if ($body.handle -ne 'thsottiaux') { throw 'Legacy X watcher response did not confirm the expected handle.' }
    return $body
}

function Invoke-LegacyRefreshProbe() {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $LegacyRefreshEndpoint -Method Get
    if ($response.StatusCode -ne 200) { throw 'Legacy X refresh probe did not return 200.' }
    $body = $response.Content | ConvertFrom-Json
    if ($body.handle -ne 'thsottiaux') { throw 'Legacy X refresh probe did not confirm the expected handle.' }
}

function Assert-LegacyWatchStopped() {
    $watch = Invoke-LegacyWatchRequest -Method Delete
    if ($watch.state -notin @('stopped', 'idle')) { throw "Legacy X watcher did not stop; reported state '$($watch.state)'." }
}

function Get-ExactTask() {
    $matches = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 1) { throw "Expected exactly one scheduled task named '$TaskName'; found $($matches.Count)." }
    return $matches[0]
}

function Stop-WindowsAirfare() {
    $current = Get-ExactTask
    Stop-ScheduledTask -InputObject $current
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-ExactTask).State -eq 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
    }
    $current = Get-ExactTask
    if ($current.State -eq 'Running') { throw 'Windows Airfare task did not stop before the deadline.' }
    Disable-ScheduledTask -InputObject $current | Out-Null
    $current = Get-ExactTask
    if ($current.State -ne 'Disabled') { throw 'Windows Airfare task is not disabled.' }
    if ($current.State -eq 'Running') { throw 'Windows Airfare task is still running.' }
}

function Assert-PiPreflight() {
    Invoke-PiChecked 'sudo /opt/edicius-hq/current/ops/pi/verify.sh'
    foreach ($collector in $Collectors) {
        Invoke-PiChecked "sudo systemctl cat $($collector.Unit) $($collector.Service)"
        Invoke-PiChecked "sudo systemctl is-enabled $($collector.Unit) | grep -qx disabled"
        Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Unit)"
        Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Service)"
    }
}

function Stop-PiCollector($Collector) {
    Invoke-PiChecked "sudo systemctl disable --now $($Collector.Unit)"
    if ($Collector.Service -ne $Collector.Unit) {
        Invoke-PiChecked "sudo systemctl stop $($Collector.Service)"
    }
}

function Start-And-GatePiCollector($Collector) {
    $cutoff = (Get-Date).ToUniversalTime().ToString('o')
    if (-not $PSCmdlet.ShouldProcess("${PiHost}:$($Collector.Name)", 'enable, start, and gate Pi collector')) { return }

    if ($Collector.RequireComplete) {
        Invoke-PiChecked "sudo systemctl enable --now $($Collector.Unit)"
        Invoke-PiChecked "sudo systemctl is-active --quiet $($Collector.Unit)"
        Invoke-PiChecked "sudo systemctl start $($Collector.Service)"
        Invoke-PiChecked "! sudo systemctl is-failed --quiet $($Collector.Service)"
        Invoke-PiChecked "sudo systemctl show --property=Result --value $($Collector.Service) | grep -qx success"
        Invoke-PiChecked "sudo /opt/edicius-hq/current/services/api/.venv/bin/python /opt/edicius-hq/current/ops/pi/check-collector-run.py $($Collector.Name) --cutoff '$cutoff' --require-complete"
    } else {
        Invoke-PiChecked "sudo systemctl enable --now $($Collector.Unit)"
        Invoke-PiChecked "sudo systemctl is-active --quiet $($Collector.Service)"
        Invoke-PiChecked "sudo /opt/edicius-hq/current/services/api/.venv/bin/python /opt/edicius-hq/current/ops/pi/check-collector-run.py $($Collector.Name) --cutoff '$cutoff'"
    }
    Invoke-PiChecked "sudo journalctl -u $($Collector.Service) --since '$cutoff' --no-pager | grep -Fq '$($Collector.JournalMarker)'"
    Invoke-PiChecked "! sudo journalctl -u $($Collector.Service) --since '$cutoff' --no-pager | grep -Eiq 'error|fatal|failed|failure'"
}

$task = Get-ExactTask
if ($WhatIfPreference) { Write-Verbose 'WhatIf: exact task validated; no remote or scheduler mutation performed.'; return }
Assert-PiPreflight
Invoke-LegacyRefreshProbe

$activeCollector = $null
$legacyWatcherStopState = 'not-attempted'
$windowsAirfareState = 'unchanged'
try {
    foreach ($collector in $Collectors) {
        $activeCollector = $collector
        if ($collector.Name -eq 'x-posts') {
            $legacyWatcherStopState = 'attempted-unconfirmed'
            Assert-LegacyWatchStopped
            $legacyWatcherStopState = 'confirmed-stopped'
        }
        if ($collector.Name -eq 'airfare') {
            if ($PSCmdlet.ShouldProcess($TaskName, 'stop and disable Windows airfare immediately before Pi Airfare')) {
                $windowsAirfareState = 'stop-attempted-unconfirmed'
                Stop-WindowsAirfare
                $windowsAirfareState = 'confirmed-disabled'
            }
        }
        Start-And-GatePiCollector $collector
        $activeCollector = $null
    }
} catch {
    if ($null -ne $activeCollector) {
        try { Stop-PiCollector $activeCollector } catch { Write-Error "Could not stop failed Pi collector: $($_.Exception.Message)" }
    }
    $watcherState = switch ($legacyWatcherStopState) {
        'confirmed-stopped' { ' The PC X watcher remains stopped until full rollback.' }
        'attempted-unconfirmed' { ' PC X watcher stop was attempted but its outcome is unconfirmed; do not start another PC or Pi X watcher until it is reconciled.' }
        default { ' The PC X watcher was not changed.' }
    }
    $airfareState = switch ($windowsAirfareState) {
        'confirmed-disabled' { ' Windows Airfare is confirmed disabled.' }
        'stop-attempted-unconfirmed' { ' Windows Airfare stop was attempted but its state is unconfirmed; do not start Pi Airfare.' }
        default { ' Windows Airfare was not changed.' }
    }
    throw "Cutover stopped; later Pi collectors remain disabled.$airfareState$watcherState $($_.Exception.Message)"
}

Write-Output 'Cutover completed after a fresh collector_runs row and cutoff-bounded journal health check for each collector.'
