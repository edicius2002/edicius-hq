[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9.-]*)?$')]
    [string]$PiHost = 'pi-bodas',

    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$Commit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'https://github.com/edicius2002/edicius-hq.git'
$remoteScript = Join-Path $PSScriptRoot 'deploy-release.sh'

if (-not (Test-Path -LiteralPath $remoteScript -PathType Leaf)) {
    throw "Missing Pi deployment script: $remoteScript"
}

if (-not $Commit) {
    $remoteRef = & git ls-remote $repository refs/heads/main
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the latest main commit.' }
    $match = [regex]::Match(($remoteRef -join "`n"), '(?m)^([0-9a-f]{40})\s+refs/heads/main$')
    if (-not $match.Success) { throw 'Git did not return exactly one main commit.' }
    $Commit = $match.Groups[1].Value
}

if (-not $PSCmdlet.ShouldProcess($PiHost, "deploy Pi release $Commit")) {
    Write-Output "Would deploy $Commit to $PiHost"
    return
}

$stage = $null
try {
    $stageOutput = & ssh -- $PiHost 'mktemp -d /tmp/edicius-deploy.XXXXXXXX'
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a temporary staging directory on the Pi.' }
    $stage = ($stageOutput | Select-Object -Last 1).Trim()
    if ($stage -notmatch '^/tmp/edicius-deploy\.[A-Za-z0-9]{8}$') {
        throw "Unexpected Pi staging path: $stage"
    }

    Push-Location -LiteralPath $PSScriptRoot
    try {
        # A relative source avoids treating the Windows drive colon as an SCP host.
        & scp -- './deploy-release.sh' "${PiHost}:$stage/deploy-release.sh"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the deployment script to the Pi.' }
    } finally {
        Pop-Location
    }

    Write-Host "Deploying $Commit on $PiHost. SSH will ask for the sudo password."
    & ssh -tt -- $PiHost "sudo -v && sudo bash '$stage/deploy-release.sh' '$Commit'"
    if ($LASTEXITCODE -ne 0) { throw "Pi deployment failed with exit code $LASTEXITCODE. See the output above." }
} finally {
    if ($stage -and $stage -match '^/tmp/edicius-deploy\.[A-Za-z0-9]{8}$') {
        & ssh -- $PiHost "rm -f '$stage/deploy-release.sh' && rmdir '$stage'"
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove Pi staging directory $stage" }
    }
}
