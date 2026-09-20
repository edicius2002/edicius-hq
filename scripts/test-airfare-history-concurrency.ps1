[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^airfare_pagination_test_[a-f0-9]{32}$')]
    [string] $Database
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$previous = $env:AIRFARE_TEST_DATABASE
try {
    $env:AIRFARE_TEST_DATABASE = $Database
    Push-Location (Join-Path $repoRoot 'services/api')
    try {
        & './.venv/Scripts/python.exe' -m pytest tests/fares/test_airfare_history_pages.py -k local_replica -q
        if ($LASTEXITCODE -ne 0) { throw 'Isolated concurrency checks failed' }
    } finally { Pop-Location }
} finally { $env:AIRFARE_TEST_DATABASE = $previous }
