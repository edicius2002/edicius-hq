[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$PiHost,

    [ValidatePattern('^http://127\.0\.0\.1(?::[1-9][0-9]{0,4})?$')]
    [string]$LegacyApiBase = 'http://127.0.0.1:8000',

    [switch]$LegacyXAbsent,

    [switch]$LegacyAirfareAbsent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'Edicius airfare'
$LegacyWatchEndpoint = "$LegacyApiBase/api/tweets/thsottiaux/watch"
$Collectors = @(
    [pscustomobject]@{ Unit = 'edicius-airfare.timer'; Service = 'edicius-airfare.service' },
    [pscustomobject]@{ Unit = 'edicius-sentiment.timer'; Service = 'edicius-sentiment.service' },
    [pscustomobject]@{ Unit = 'edicius-tweets.service'; Service = 'edicius-tweets.service' },
    [pscustomobject]@{ Unit = 'edicius-market.service'; Service = 'edicius-market.service' }
)

function Invoke-PiChecked([string]$Command) {
    & ssh -- $PiHost $Command
    if ($LASTEXITCODE -ne 0) { throw "Pi command failed; Windows task remains unchanged: $Command" }
}

function Invoke-LegacyWatchRequest([ValidateSet('Delete', 'Post')][string]$Method) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $LegacyWatchEndpoint -Method $Method
    if ($response.StatusCode -ne 202) { throw "Legacy X watcher $Method did not return 202." }
    $body = $response.Content | ConvertFrom-Json
    if ($body.handle -ne 'thsottiaux') { throw 'Legacy X watcher response did not confirm the expected handle.' }
    return $body
}

function Assert-AllPiCollectorsStopped() {
    foreach ($collector in $Collectors) {
        Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Unit)"
        Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Service)"
    }
}

function Get-ExactTask() {
    $matches = @(Get-ScheduledTask -ErrorAction Stop |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 1) { throw "Expected exactly one scheduled task named '$TaskName'; found $($matches.Count)." }
    return $matches[0]
}

function Assert-LegacyXAbsent() {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $LegacyWatchEndpoint -Method Get -SkipHttpErrorCheck
    if ($response.StatusCode -ne 404) { throw "Legacy-X-absent mode requires the watcher endpoint to return 404; received $($response.StatusCode)." }
}

function Assert-LegacyAirfareAbsent() {
    $matches = @(Get-ScheduledTask -ErrorAction Stop |
        Where-Object { $_.TaskName -eq $TaskName })
    if ($matches.Count -ne 0) { throw "Legacy-Airfare-absent mode requires zero tasks named '$TaskName'; found $($matches.Count)." }
}

$task = $null
if ($LegacyAirfareAbsent) { Assert-LegacyAirfareAbsent } else { $task = Get-ExactTask }
if ($LegacyXAbsent) { Assert-LegacyXAbsent }
if ($WhatIfPreference) { Write-Verbose 'WhatIf: exact task validated; no remote or scheduler mutation performed.'; return }

try {
    foreach ($collector in $Collectors) {
        if ($PSCmdlet.ShouldProcess("${PiHost}:$($collector.Unit)", 'stop and disable Pi collector')) {
            Invoke-PiChecked "sudo systemctl disable --now $($collector.Unit)"
            Invoke-PiChecked "sudo systemctl stop $($collector.Service)"
            Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Unit)"
            Invoke-PiChecked "! sudo systemctl is-active --quiet $($collector.Service)"
            Invoke-PiChecked "sudo systemctl is-enabled $($collector.Unit) | grep -Eq 'disabled|masked'"
        }
    }
    Assert-AllPiCollectorsStopped
} catch {
    throw "Partial rollback: Pi units may still be active; Windows task and PC X watcher were not enabled. $($_.Exception.Message)"
}

if ($LegacyXAbsent) {
    Assert-LegacyXAbsent
} elseif ($PSCmdlet.ShouldProcess($LegacyWatchEndpoint, 'restart the legacy PC X watcher after all Pi collectors are stopped')) {
    $watch = Invoke-LegacyWatchRequest -Method Post
    if ($watch.state -ne 'watching') { throw "Legacy X watcher restart did not enter watching state; reported '$($watch.state)'." }
}
if ($LegacyAirfareAbsent) {
    Assert-LegacyAirfareAbsent
} elseif ($PSCmdlet.ShouldProcess($TaskName, 'enable Windows airfare collector after Pi stop')) {
    Enable-ScheduledTask -InputObject $task | Out-Null
}
Write-Output 'Rollback completed without deleting or truncating Pi or Supabase data.'
