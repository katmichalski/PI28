Patch: Ignore Description Column + Logo Vendor Fallback

## 1) Ignore everything under a Description column

If an invoice's line-items table starts high on the page, the OCR header regions can accidentally include
line-item numbers and text. This patch detects a table header line containing **"Description"** (or **"Desc"**)
and removes everything **after** that line from the text used to detect:

- Vendor name
- Invoice number

This applies automatically to both:

- PDFs (text-layer and image-OCR fallbacks)
- Standalone images (png/jpg)

## 2) Look at logos as a last resort

When the vendor would otherwise be `UNKNOWN_VENDOR`, the server now OCRs likely **logo regions** in the
top band (top-left / top-center / top-right) and attempts vendor detection again using that logo text.

Debug output now includes:

- `logoBestText`
- `logoTopLeftText`
- `logoTopCenterText`
- `logoTopRightText`

### Optional env tuning

- `LOGO_OCR_TIMEOUT_MS` (default 90000)
- `LOGO_OCR_MAX_DIM` (default 1400)
