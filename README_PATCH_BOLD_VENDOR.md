# Patch: Prefer bold vendor names (text PDFs)

This update improves vendor detection for PDFs that have a text layer (native PDFs or OCRmyPDF output).

## What changed
- When extracting the top-third header text from PDF pages, we now also compute an **"emphasis text"** string:
  - lines that are **bold** (based on PDF font metadata) and/or have **unusually large font size**
  - this is returned as `topLeftBoldText`, `topMiddleBoldText`, `topRightBoldText` (and `topVendorBoldText` in the text-layer fast path)

- Vendor detection now tries the vendor list match in this order:
  1) **bold/large-font header lines**
  2) regular header lines (top-left / top-middle)
  3) full text fallback

This helps with invoices where the vendor name is printed in bold at the very top.

## Notes
- For scanned image-only PDFs (no text layer), we still rely on OCR (no bold info available).
