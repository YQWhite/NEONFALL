# OCR + pixel-stat analysis for NEONFALL screenshots (Windows.Media.Ocr).
param(
  [string]$Dir = "test-shots"
)
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $resultType) {
  $t = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $t.GetAwaiter().GetResult()
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
public static class PngHelper {
  public static void Load(string path) {}
}
"@

function Analyze-Shot($file) {
  Write-Host "=== $($file.Name) ($([math]::Round($file.Length/1024))KB) ==="
  # pixel stats via System.Drawing
  $bmp = [System.Drawing.Bitmap]::FromFile($file.FullName)
  $w = $bmp.Width; $h = $bmp.Height
  $sample = $bmp.GetPixel([int]($w/2), [int]($h/2))
  $tl = $bmp.GetPixel(10, 10)
  $nonDark = 0; $total = 0
  for ($x = 0; $x -lt $w; $x += 16) {
    for ($y = 0; $y -lt $h; $y += 16) {
      $p = $bmp.GetPixel($x, $y)
      $total++
      if (($p.R + $p.G + $p.B) -gt 90) { $nonDark++ }
    }
  }
  $pct = [math]::Round(100 * $nonDark / [math]::Max(1,$total), 1)
  Write-Host ("  size {0}x{1} center=({2},{3},{4}) corner=({5},{6},{7}) brightPixels={8}%" -f $w,$h,$sample.R,$sample.G,$sample.B,$tl.R,$tl.G,$tl.B,$pct)
  $bmp.Dispose()

  # OCR
  try {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes)
    $writer.StoreAsync() | Out-Null
    $writer.FlushAsync() | Out-Null
    $stream.Seek(0) | Out-Null
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) {
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lines = $result.Lines | ForEach-Object { $_.Text }
      if ($lines) { Write-Host "  OCR lines:"; $lines | Select-Object -First 24 | ForEach-Object { Write-Host "    $_" } }
      else { Write-Host "  OCR: no text found" }
    } else { Write-Host "  OCR: no language engine available" }
  } catch {
    Write-Host "  OCR failed: $($_.Exception.Message)"
  }
}

Get-ChildItem (Join-Path (Join-Path $PSScriptRoot '..') $Dir) -Filter *.png | Sort-Object Name | ForEach-Object { Analyze-Shot $_ }
