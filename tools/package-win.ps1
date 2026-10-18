# Package the Windows build: hand-rolled portable folder with NEONFALL.exe.
# (Electron dist is already installed locally; no external downloads needed.)
param([string]$OutputName = 'NEONFALL-win-x64')
$ErrorActionPreference = 'Stop'
if ($OutputName -notmatch '^NEONFALL(?:-\d+\.\d+\.\d+)?-win-x64$') { throw 'Invalid portable output name' }
$root = Split-Path $PSScriptRoot -Parent
$electronDist = Join-Path $root 'node_modules\electron\dist'
$release = Join-Path $root 'release'
$out = Join-Path $release $OutputName

if (!(Test-Path (Join-Path $electronDist 'electron.exe'))) {
  throw "electron dist missing at $electronDist — run: node node_modules/electron/install.js"
}

$resolvedRoot = [IO.Path]::GetFullPath($root)
$resolvedOut = [IO.Path]::GetFullPath($out)
$expectedOut = [IO.Path]::Combine($resolvedRoot, 'release', $OutputName)
if ($resolvedOut -ne $expectedOut -or !(($resolvedOut + '\').StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Output path escaped the project release directory' }
if (Test-Path -LiteralPath $out) {
  if ((Get-Item -LiteralPath $out).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to delete a linked release directory' }
  Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 1. copy the electron runtime
Copy-Item (Join-Path $electronDist '*') $out -Recurse -Force
Rename-Item (Join-Path $out 'electron.exe') 'NEONFALL.exe'

# 2. app payload in resources/app
$appDir = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appDir 'dist') -Force | Out-Null
Copy-Item (Join-Path $root 'dist\index.html') (Join-Path $appDir 'dist\index.html') -Force
Copy-Item (Join-Path $root 'electron\main.cjs') $appDir -Force
Copy-Item (Join-Path $root 'electron\preload.cjs') $appDir -Force
Copy-Item (Join-Path $root 'electron\bundled-assets.cjs') $appDir -Force
@'
{
  "name": "neonfall",
  "version": "0.2.9",
  "main": "main.cjs"
}
'@ | Set-Content -Path (Join-Path $appDir 'package.json') -Encoding Ascii

# 3. bundled demo charts (seeded into the library on first run)
$seed = Join-Path $appDir 'seed-charts'
New-Item -ItemType Directory -Path $seed -Force | Out-Null
$samples = Join-Path $root '..\samples-converted'
if (Test-Path $samples) {
  Get-ChildItem $samples -Filter *.nfm | Copy-Item -Destination $seed -Force
}
# skin as well (goes to seed-charts too? no — skins seed dir is separate; copy nfsk next to charts for manual import)
Get-ChildItem $samples -Filter *.nfsk | Copy-Item -Destination $seed -Force
Copy-Item -LiteralPath (Join-Path $samples 'bundle-manifest.json') -Destination $seed -Force

# 4. quick sanity + zip
$exe = Join-Path $out 'NEONFALL.exe'
if (!(Test-Path $exe)) { throw 'exe missing' }
$zip = Join-Path $release 'NEONFALL-win-x64.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal
Write-Host "packaged: $out"
Write-Host "zip:      $zip"
Write-Host "size:     $([math]::Round((Get-ChildItem $out -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)) MB"
