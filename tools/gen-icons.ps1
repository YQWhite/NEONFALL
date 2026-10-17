# Generate NEONFALL app icons (rounded neon gradient + N) for Android mipmaps & Windows.
param([string]$OutDir = 'android\app\src\main\res')
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255,13,24,48), [System.Drawing.Color]::FromArgb(255,64,16,74), 45)
  $g.FillRectangle($brush, $rect)
  # subtle center glow via concentric alpha rings
  for ($i = 8; $i -ge 1; $i--) {
    $alpha = [int](3 * $i)
    $glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 63, 214, 255))
    $rr = [int]($size * (0.42 - $i * 0.03))
    $g.FillEllipse($glow, [int]($size/2 - $rr), [int]($size/2 - $rr), $rr*2, $rr*2)
    $glow.Dispose()
  }
  # N letter
  $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $fg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255,125,249,255), [System.Drawing.Color]::FromArgb(255,255,122,224), 90)
  $g.DrawString('N', $font, $fg, (New-Object System.Drawing.RectangleF(0, [float](-$size*0.03), $size, $size)), $sf)
  # bottom accent line
  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,125,249,255))
  $g.FillRectangle($accent, [int]($size*0.26), [int]($size*0.76), [int]($size*0.48), [int]($size*0.035))
  $g.Dispose()
  $dir = Split-Path $path -Parent
  if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "icon -> $path"
}

$sizes = @{ 'mipmap-mdpi' = 48; 'mipmap-hdpi' = 72; 'mipmap-xhdpi' = 96; 'mipmap-xxhdpi' = 144; 'mipmap-xxxhdpi' = 192 }
foreach ($dpi in $sizes.Keys) {
  $d = Join-Path $OutDir $dpi
  New-Icon $sizes[$dpi] (Join-Path $d 'ic_launcher.png')
  New-Icon $sizes[$dpi] (Join-Path $d 'ic_launcher_round.png')
  New-Icon $sizes[$dpi] (Join-Path $d 'ic_launcher_foreground.png')
}
Write-Host 'done'
