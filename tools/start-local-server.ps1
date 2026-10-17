param([int]$Port = 8787, [string]$ListenHost = '0.0.0.0')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runRoot = Join-Path $projectRoot 'local-server'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$pidFile = Join-Path $runRoot 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) {
        $existingProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($existingProcess) { throw "A saved server process is still running (PID $savedPid). Use tools\stop-local-server.ps1 before restarting." }
    }
}
$environmentNames = @('HOST', 'PORT', 'NF_DATA_DIR', 'NF_SEED_DIR')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:HOST = $ListenHost
    $env:PORT = [string]$Port
    $env:NF_DATA_DIR = Join-Path $runRoot 'data'
    $env:NF_SEED_DIR = [IO.Path]::GetFullPath((Join-Path $projectRoot '..\samples-converted'))
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $serverScript = Join-Path $projectRoot 'server\server.js'
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runRoot 'stdout.log') -RedirectStandardError (Join-Path $runRoot 'stderr.log')
    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding Ascii
    Start-Sleep -Milliseconds 700
    $process.Refresh()
    if ($process.HasExited) {
        Remove-Item -LiteralPath $pidFile -Force
        throw ('Server exited. See ' + (Join-Path $runRoot 'stderr.log'))
    }
    Write-Host "Server PID: $($process.Id)"
    Write-Host "Open: http://127.0.0.1:$Port/"
    Write-Host "Health: http://127.0.0.1:$Port/api/ping"
    Write-Host "Data and logs: $runRoot"
    Write-Host 'For phones, use this computer''s WLAN IPv4 address in place of 127.0.0.1.'
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
}
