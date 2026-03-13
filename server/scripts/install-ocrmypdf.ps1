<#
Installs OCRmyPDF on Windows using pipx (recommended) and its core dependencies.

Run in an Administrator PowerShell for best results.

After install, open a NEW terminal and verify:
  ocrmypdf --version
or:
  py -m ocrmypdf --version

If the command isn't on PATH, you can run the server with:
  $env:OCRMYPDF_CMDLINE = "py -m ocrmypdf"
#>

$ErrorActionPreference = "Stop"

Write-Host "Installing dependencies (Python, Tesseract, Ghostscript) via winget..." -ForegroundColor Cyan
try {
  winget install -e --id Python.Python.3.11
} catch { Write-Warning "Python winget install may have failed or is already installed." }

try {
  winget install -e --id UB-Mannheim.TesseractOCR
} catch { Write-Warning "Tesseract winget install may have failed or is already installed." }

try {
  winget install -e --id ArtifexSoftware.GhostScript
} catch { Write-Warning "Ghostscript winget install may have failed or is already installed." }

Write-Host "Installing pipx + ocrmypdf..." -ForegroundColor Cyan
py -m pip install --upgrade pip
py -m pip install --user pipx
py -m pipx ensurepath

Write-Host "NOTE: Close and reopen your terminal after ensurepath for PATH changes to take effect." -ForegroundColor Yellow

try {
  pipx install ocrmypdf
} catch {
  Write-Warning "pipx install ocrmypdf failed. You can try: py -m pip install ocrmypdf"
}

Write-Host "Done. Verify with: ocrmypdf --version" -ForegroundColor Green
