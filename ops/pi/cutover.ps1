[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$PiHost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'Edicius airfare'
$Collectors = @(
    [pscustomobject]@{ Name = 'airfare'; Unit = 'edicius-airfare.timer'; Service = 'edicius-airfare.service'; RequireComplete = $true },
    [pscustomobject]@{ Name = 'sentiment'; Unit = 'edicius-sentiment.timer'; Service = 'edicius-sentiment.service'; RequireComplete = $true },
    [pscustomobject]@{ Name = 'x-posts'; Unit = 'edicius-tweets.service'; Service = 'edicius-tweets.service'; RequireComplete = $false },
    [pscustomobject]@{ Name = 'market'; Unit = 'edicius-market.service'; Service = 'edicius-market.service'; RequireComplete = $false }
)

function Invoke-PiChecked([string]$Command) {
    # Every caller supplies a fixed command assembled from the fixed mappings above.
    & ssh -- $PiHost $Command
    if ($LASTEXITCODE -ne 0) { throw "Pi command failed: $Command" }
}

function Get-ExactTask() {
    $matches = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 1) { throw "Expected exactly one scheduled task named '$TaskName'; found $($matches.Count)." }
    return $matches[0]
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
    Invoke-PiChecked "sudo journalctl -u $($Collector.Service) --since '$cutoff' --no-pager | grep -q ."
}

$task = Get-ExactTask
if ($WhatIfPreference) { Write-Verbose 'WhatIf: exact task validated; no remote or scheduler mutation performed.'; return }
Assert-PiPreflight
if ($PSCmdlet.ShouldProcess($TaskName, 'disable Windows airfare collector after full Pi preflight')) {
    Disable-ScheduledTask -InputObject $task | Out-Null
}

$activeCollector = $null
try {
    foreach ($collector in $Collectors) {
        $activeCollector = $collector
        Start-And-GatePiCollector $collector
        $activeCollector = $null
    }
} catch {
    if ($null -ne $activeCollector) {
        try { Stop-PiCollector $activeCollector } catch { Write-Error "Could not stop failed Pi collector: $($_.Exception.Message)" }
    }
    throw "Cutover stopped; later Pi collectors remain disabled and Windows task remains disabled. $($_.Exception.Message)"
}

Write-Output 'Cutover completed after a fresh collector_runs row and cutoff-bounded journal health check for each collector.'
