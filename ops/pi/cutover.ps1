[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$PiHost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'Edicius airfare'
$Units = @('edicius-airfare.timer', 'edicius-sentiment.timer', 'edicius-tweets.service', 'edicius-market.service')

function Invoke-PiChecked([string]$Command) {
    # Commands are constants assembled only from the fixed unit list above.
    & ssh -- $PiHost $Command
    if ($LASTEXITCODE -ne 0) { throw "Pi command failed before cutover: $Command" }
}

function Get-ExactTask() {
    $matches = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 1) { throw "Expected exactly one scheduled task named '$TaskName'; found $($matches.Count)." }
    return $matches[0]
}

function Assert-PiPreflight() {
    Invoke-PiChecked 'sudo /opt/edicius-hq/current/ops/pi/verify.sh'
    foreach ($unit in $Units) {
        Invoke-PiChecked "sudo systemctl cat $unit"
        Invoke-PiChecked "sudo systemctl is-enabled $unit | grep -qx disabled"
        Invoke-PiChecked "! sudo systemctl is-active --quiet $unit"
    }
}

function Enable-PiUnit([string]$Unit) {
    if ($PSCmdlet.ShouldProcess("${PiHost}:$Unit", 'enable and start Pi collector')) {
        Invoke-PiChecked "sudo systemctl enable --now $Unit"
        Invoke-PiChecked "sudo systemctl is-active --quiet $Unit"
        # The collector must publish a run/row or emit an explicit healthy state in journald.
        Invoke-PiChecked "sudo journalctl -u $Unit -n 100 --no-pager | grep -Eiq 'health|upsert|synced|completed'"
    }
}

$task = Get-ExactTask
if ($WhatIfPreference) { Write-Verbose 'WhatIf: exact task validated; no remote or scheduler mutation performed.'; return }
Assert-PiPreflight
if ($PSCmdlet.ShouldProcess($TaskName, 'disable Windows airfare collector after Pi preflight')) {
    Disable-ScheduledTask -InputObject $task | Out-Null
}

# Enable and verify one equivalent collector at a time.  Stop at the first failure.
foreach ($unit in $Units) { Enable-PiUnit $unit }
Write-Output 'Cutover completed. Compare Supabase row counts and collector health before declaring the observation window started.'
