#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tessdata
url="https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz"
out="tessdata/eng.traineddata.gz"
final="tessdata/eng.traineddata"

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -L "$url" -o "$out"
elif command -v wget >/dev/null 2>&1; then
  wget "$url" -O "$out"
else
  echo "Need curl or wget" >&2
  exit 1
fi

echo "Saved $out ($(wc -c < "$out") bytes)"

echo "Decompressing to $final"
if command -v gzip >/dev/null 2>&1; then
  gzip -dc "$out" > "$final"
elif command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import gzip
import shutil
src = 'tessdata/eng.traineddata.gz'
dst = 'tessdata/eng.traineddata'
with gzip.open(src, 'rb') as f_in, open(dst, 'wb') as f_out:
  shutil.copyfileobj(f_in, f_out)
PY
else
  echo "Need gzip or python3 to decompress eng.traineddata.gz" >&2
  exit 1
fi

rm -f "$out"
echo "Ready: $final ($(wc -c < "$final") bytes)"
