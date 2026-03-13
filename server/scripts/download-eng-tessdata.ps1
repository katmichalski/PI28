$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Resolve-Path (Join-Path $here '..')
$tessDir = Join-Path $serverDir 'tessdata'
New-Item -ItemType Directory -Force -Path $tessDir | Out-Null

# High-accuracy English model (gzipped)
$url = 'https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz'
$out = Join-Path $tessDir 'eng.traineddata.gz'
$final = Join-Path $tessDir 'eng.traineddata'

Write-Host "Downloading $url" -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $out

$size = (Get-Item $out).Length
Write-Host "Saved: $out ($size bytes)" -ForegroundColor Green

Write-Host "Decompressing to $final" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression
$inStream = [System.IO.File]::OpenRead($out)
try {
  $gz = New-Object System.IO.Compression.GzipStream($inStream, [System.IO.Compression.CompressionMode]::Decompress)
  try {
    $outStream = [System.IO.File]::Create($final)
    try {
      $gz.CopyTo($outStream)
    } finally {
      $outStream.Dispose()
    }
  } finally {
    $gz.Dispose()
  }
} finally {
  $inStream.Dispose()
}

Remove-Item -Force $out
$finalSize = (Get-Item $final).Length
Write-Host "Ready: $final ($finalSize bytes)" -ForegroundColor Green
