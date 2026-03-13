#!/usr/bin/env bash
set -euo pipefail

echo "This installs OCRmyPDF on macOS/Linux (best-effort)."
echo "You may need sudo privileges."

if command -v brew >/dev/null 2>&1; then
  echo "Detected Homebrew. Installing dependencies..."
  brew install tesseract ghostscript python@3.11 || true
  python3 -m pip install --upgrade pip
  python3 -m pip install --user pipx
  python3 -m pipx ensurepath
  pipx install ocrmypdf || python3 -m pip install --user ocrmypdf
elif command -v apt-get >/dev/null 2>&1; then
  echo "Detected apt-get. Installing dependencies..."
  sudo apt-get update
  sudo apt-get install -y tesseract-ocr ghostscript python3-pip
  python3 -m pip install --upgrade pip
  python3 -m pip install --user pipx
  python3 -m pipx ensurepath
  pipx install ocrmypdf || python3 -m pip install --user ocrmypdf
else
  echo "No supported package manager detected."
  echo "Install Tesseract + Ghostscript + Python, then: python3 -m pip install ocrmypdf"
  exit 1
fi

echo "Done. Verify with: ocrmypdf --version"
