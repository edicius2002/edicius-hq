[CmdletBinding()]
param(
    [ValidatePattern('^airfare_pagination_test_[a-f0-9]{32}$')]
    [string] $Database = ('airfare_pagination_test_' + [guid]::NewGuid().ToString('N')),
    [switch] $Create,
    [string[]] $Tests
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$container = 'supabase_db_edicius-hq'

function Invoke-LocalDocker([string[]] $DockerArguments, [string] $InputText = '') {
    $start = [System.Diagnostics.ProcessStartInfo]::new('docker')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $start.StandardInputEncoding = $encoding
    $start.StandardOutputEncoding = $encoding
    $start.StandardErrorEncoding = $encoding
    foreach ($argument in $DockerArguments) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $write = $process.StandardInput.WriteAsync($InputText)
        if (-not $write.Wait(60000)) { throw 'Local database stdin timed out' }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(120000)) { throw 'Local database command timed out' }
        $text = $output.GetAwaiter().GetResult()
        $stderr = $errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Local database command failed: $stderr`n$text" }
        return $text
    } finally {
        if (-not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}

function Invoke-LocalSql([string] $Target, [string] $Sql) {
    Invoke-LocalDocker @('exec', '-i', $container, 'psql', '-U', 'postgres', '-d', $Target,
        '-X', '-At', '-v', 'ON_ERROR_STOP=1') $Sql
}

Write-Host "Test database: $Database (retained; no cleanup/reset performed)"
if ($Create) {
    $exists = Invoke-LocalSql 'postgres' "select 1 from pg_database where datname = '$Database';"
    if ($exists.Trim() -eq '1') { throw 'Refusing to reuse an existing database with -Create' }
    $versions = (Invoke-LocalSql 'postgres' 'select version from supabase_migrations.schema_migrations order by version;') -split '\r?\n'
    if ('20260918000000' -notin $versions) { throw 'Local baseline must include collector data plane migration' }
    $schema = Invoke-LocalDocker @('exec', $container, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
        '--schema-only', '--no-owner', '--schema=public', '--schema=auth', '--schema=extensions')
    # Fresh databases already contain public. Other schemas have no data to copy.
    $schema = $schema.Replace('CREATE SCHEMA public;', 'CREATE SCHEMA IF NOT EXISTS public;')
    $schema = $schema.Replace('CREATE SCHEMA extensions;', 'CREATE SCHEMA IF NOT EXISTS extensions;')
    # Preserve object ACLs and postgres defaults. Managed-role defaults concern
    # future objects created by those roles, not the archive/migration under test.
    $schema = (($schema -split '\r?\n') | Where-Object {
        $_ -notmatch '^ALTER DEFAULT PRIVILEGES FOR ROLE (supabase_auth_admin|supabase_admin) IN SCHEMA '
    }) -join "`n"
    $null = Invoke-LocalSql 'postgres' "create database $Database template template0;"
    $null = Invoke-LocalSql $Database 'create schema extensions; create extension pgcrypto with schema extensions; create extension "uuid-ossp" with schema extensions;'
    $null = Invoke-LocalSql $Database $schema
    foreach ($migration in Get-ChildItem -LiteralPath (Join-Path $repoRoot 'supabase/migrations') -Filter '*.sql' | Sort-Object Name) {
        $version = $migration.BaseName.Split('_')[0]
        if ($version -le '20260919000000' -and $version -notin $versions) {
            Write-Host "Preparing isolated baseline: $($migration.Name)"
            $null = Invoke-LocalSql $Database ("begin;`n" + [IO.File]::ReadAllText($migration.FullName) + "`ncommit;")
        }
    }
}
$exists = Invoke-LocalSql 'postgres' "select 1 from pg_database where datname = '$Database';"
if ($exists.Trim() -ne '1') { throw 'Test database does not exist; use -Create first' }
$publication = Invoke-LocalSql $Database "select 1 from pg_publication where pubname = 'supabase_realtime';"
if ($publication.Trim() -ne '1') {
    # Schema-filtered pg_dump omits publications. Copy only their table membership,
    # never subscriptions or a connection to the shared/local/hosted source.
    $publicationSql = Invoke-LocalSql 'postgres' @'
select 'create publication supabase_realtime for table ' ||
  string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename) || ';'
from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public';
'@
    if (-not $publicationSql.Trim()) { throw 'Local baseline has no realtime publication members' }
    $null = Invoke-LocalSql $Database $publicationSql
}
$null = Invoke-LocalSql $Database 'create extension if not exists pgtap with schema extensions;'
$pagination = Join-Path $repoRoot 'supabase/migrations/20260919010000_airfare_history_pagination.sql'
if (Test-Path -LiteralPath $pagination) {
    $null = Invoke-LocalSql $Database ("begin;`n" + [IO.File]::ReadAllText($pagination) + "`ncommit;")
}
$coordinateReference = Join-Path $repoRoot 'supabase/migrations/20260919020000_airport_coordinate_reference.sql'
if (Test-Path -LiteralPath $coordinateReference) {
    $null = Invoke-LocalSql $Database ("begin;`n" + [IO.File]::ReadAllText($coordinateReference) + "`ncommit;")
}
$ownerAirports = Join-Path $repoRoot 'supabase/migrations/20260919020100_airfare_owner_airports.sql'
if (Test-Path -LiteralPath $ownerAirports) {
    $null = Invoke-LocalSql $Database ("begin;`n" + [IO.File]::ReadAllText($ownerAirports) + "`ncommit;")
}
if (-not $Tests) {
    $Tests = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'supabase/tests') -Filter '*.sql' | Sort-Object Name | ForEach-Object FullName)
}
$total = 0
foreach ($test in $Tests) {
    $testPath = if ([IO.Path]::IsPathRooted($test)) { $test } else { Join-Path $repoRoot $test }
    $result = Invoke-LocalSql $Database ("set search_path = public, extensions;`n" + [IO.File]::ReadAllText($testPath))
    $plans = [regex]::Matches($result, '(?m)^1\.\.(\d+)\r?$')
    $assertions = [regex]::Matches($result, '(?m)^(?:not )?ok \d+\b')
    if ($plans.Count -ne 1 -or $result -match '(?m)^not ok\b|^Bail out!|^# (?:Looks like|No tests run)') {
        throw "pgTAP failed: $test`n$result"
    }
    $expected = [int] $plans[0].Groups[1].Value
    if ($assertions.Count -ne $expected) { throw "pgTAP count mismatch: $test`n$result" }
    $total += $expected
    Write-Host "PASS $([IO.Path]::GetFileName($testPath)): $expected assertions"
}
Write-Host "SQL suite: $($Tests.Count) files, $total assertions passed"
