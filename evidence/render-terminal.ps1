param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Title
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$lines = [System.IO.File]::ReadAllLines($InputPath)

# Wrap long DETAIL lines rather than letting the image grow unbounded in width.
$maxCols = 118
$rendered = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  $clean = $line -replace "`r", ""
  if ($clean.Length -le $maxCols) {
    $rendered.Add($clean)
  }
  else {
    $remainder = $clean
    while ($remainder.Length -gt 0) {
      $take = [Math]::Min($maxCols, $remainder.Length)
      $rendered.Add($remainder.Substring(0, $take))
      $remainder = $remainder.Substring($take)
    }
  }
}

$font = New-Object System.Drawing.Font('Consolas', 8.5)
$bold = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Bold)
$titleFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)

$charW = [System.Windows.Forms.TextRenderer]::MeasureText('M', $font).Width
if ($charW -le 0) { $charW = 8 }
$lineH = 14
$padX = 18
$padTop = 46
$padBottom = 18

$width = ($maxCols * $charW) + ($padX * 2)
$height = $padTop + ($rendered.Count * $lineH) + $padBottom
if ($width -lt 900) { $width = 900 }

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(13, 17, 23))

# Title bar
$barBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 27, 34))
$g.FillRectangle($barBrush, 0, 0, $width, 32)
$g.DrawLine((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 54, 61))), 0, 32, $width, 32)
$g.DrawString($Title, $titleFont, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 237, 243))), $padX, 8)

$normal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(201, 209, 217))
$errBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 123, 114))
$detailBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 166, 87))
$headBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(121, 192, 255))
$sqlBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(163, 113, 247))
$okBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(86, 211, 100))

$y = $padTop
foreach ($line in $rendered) {
  $brush = $normal
  if ($line -match '^\s*ERROR:') { $brush = $errBrush }
  elseif ($line -match '^\s*DETAIL:') { $brush = $detailBrush }
  elseif ($line -match '^###') { $brush = $headBrush }
  elseif ($line -match '^\s*(INSERT|SELECT|FROM|WHERE|DELETE|UPDATE)\b') { $brush = $sqlBrush }
  elseif ($line -match '^\s*(INSERT 0 1|DELETE 1|\(\d+ rows?\))') { $brush = $okBrush }
  $g.DrawString($line, $font, $brush, $padX, $y)
  $y += $lineH
}

$g.Dispose()
$bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}  {1}x{2}  {3} bytes" -f (Split-Path -Leaf $OutputPath), $width, $height, (Get-Item $OutputPath).Length)
