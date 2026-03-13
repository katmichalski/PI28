# Migration Notes

Your original Project Invoice repo has been updated with the **new OCR → plan → split → download** application flow.

## What changed
### Backend (`/server`)
- New endpoints:
  - `POST /api/plan` (upload PDF → optional OCR → analyze pages → suggested groups)
  - `GET  /api/progress/:jobId` (SSE progress stream)
  - `POST /api/split` (accepts `{ jobId, groups }` and streams a ZIP)
- Vendor list support:
  - `server/data/Vendor List.xlsx` is used to match vendors.
  - Newly detected vendors can be appended.
- Output naming enforced in suggestions:
  - `VENDOR_INVOICENUMBER` (digits-only invoice number) → `VENDOR_INVOICENUMBER.pdf`

### Frontend (`/client`)
- Drag & drop upload + click-to-upload
- Upload progress percent bar
- Editable output filename stems
- Download ZIP

## Install / run
Backend:
```bash
cd server
npm i
npm run dev
```

Frontend:
```bash
cd client
npm i
npm run dev
```

## OCR (recommended for scanned PDFs)
Install:
- Python 3
- `pip install ocrmypdf`
- Tesseract installed and on PATH

If OCR tools are not installed, text PDFs still work; scanned PDFs may need manual renaming.

