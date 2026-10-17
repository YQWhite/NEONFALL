$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $projectRoot 'local-server\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No saved server PID.'; exit 0 }
$savedPid = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) { throw 'Invalid server PID file.' }
$process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
if ($process) {
    if ($process.ProcessName -ne 'node') { throw 'Saved PID belongs to another program; refusing to stop it.' }
    # Verify the command line as well, because Windows can reuse process IDs.
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
    $expected = Join-Path $projectRoot 'server\server.js'
    if (-not $info.CommandLine -or $info.CommandLine.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Cannot verify that the saved PID is this project server; refusing to stop it.'
    }
    Stop-Process -Id $savedPid
    Write-Host "Stopped server PID $savedPid"
}
Remove-Item -LiteralPath $pidFile -Force
