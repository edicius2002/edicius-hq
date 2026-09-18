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
    & ssh -- $PiHost $Command
    if ($LASTEXITCODE -ne 0) { throw "Pi command failed; Windows task remains unchanged: $Command" }
}

function Get-ExactTask() {
    $matches = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 1) { throw "Expected exactly one scheduled task named '$TaskName'; found $($matches.Count)." }
    return $matches[0]
}

$task = Get-ExactTask
if ($WhatIfPreference) { Write-Verbose 'WhatIf: exact task validated; no remote or scheduler mutation performed.'; return }

try {
    foreach ($unit in $Units) {
        if ($PSCmdlet.ShouldProcess("${PiHost}:$unit", 'stop and disable Pi collector')) {
            Invoke-PiChecked "sudo systemctl disable --now $unit"
            Invoke-PiChecked "! sudo systemctl is-active --quiet $unit"
            Invoke-PiChecked "sudo systemctl is-enabled $unit | grep -Eq 'disabled|masked'"
        }
    }
} catch {
    throw "Partial rollback: Pi units may still be active; Windows task was not enabled. $($_.Exception.Message)"
}

if ($PSCmdlet.ShouldProcess($TaskName, 'enable Windows airfare collector after Pi stop')) {
    Enable-ScheduledTask -InputObject $task | Out-Null
}
Write-Output 'Rollback completed without deleting or truncating Pi or Supabase data.'
