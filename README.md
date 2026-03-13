# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.


## Deployment (Vercel)

This is a Vite + React app.

### Deploy with Vercel
- Build Command: `npm run build`
- Output Directory: `dist`

### SPA Routing (React Router)
This project uses client-side routing. `vercel.json` includes a rewrite to serve `/` for all routes so refresh/deep-links work.

### Environment Variables
Client-exposed environment variables must start with `VITE_`.

Local:
- Copy `.env.example` → `.env.local`

Vercel:
- Add the same keys in Project Settings → Environment Variables


## Batch mode
- You can upload multiple PDFs at once in the UI.
- The backend uses `/api/batch/plan` and `/api/batch/split` to create one combined ZIP.

## OCR (vendor + invoice #)

This project detects **Vendor name** + **Invoice number** per page (used to suggest output filenames). For scanned PDFs (image-only PDFs), it uses image-based OCR automatically.

### Quick start

Backend:

```bash
cd server
npm i

# Download OCR language data (required for scanned PDFs / image OCR)
# mac/linux:
bash scripts/download-eng-tessdata.sh
# windows:
powershell -ExecutionPolicy Bypass -File scripts/download-eng-tessdata.ps1

npm run dev
```

Frontend:

```bash
cd client
npm i
npm run dev
```

### Image OCR endpoint (optional / advanced)

`POST /api/ocr/image` (multipart form-data: `file=<png/jpg>`) returns:

- `vendorRaw`, `vendorNorm`, `vendorMatched`, `vendorConfidence`
- `invoiceNumber`, `invoiceConfidence`

Note: The main UI focuses on PDF batch processing. The image OCR endpoint is still available for troubleshooting, even if the UI doesn't show a dedicated "Image OCR" card.

### Troubleshooting OCR

- Open `GET /api/health` and confirm:
  - `canvas: true`
  - `tessdataEng: true`
- If `tessdataSource` is `remote` and OCR looks blank / stuck, download `server/tessdata/eng.traineddata` locally using the scripts above (corporate networks often block remote tessdata downloads).

### Optional: enable full-PDF OCR (OCRmyPDF)

The backend can optionally run **OCRmyPDF** to make scanned PDFs searchable before planning/splitting.

Health check:
- `GET /api/health` shows `ocrmypdf: true/false` and (when available) `ocrmypdfRunner`.

Install OCRmyPDF + dependencies, then verify one of these works in the same terminal you run the server:

```bash
ocrmypdf --version
```

or (Windows fallback if the entrypoint isn't on PATH):

```powershell
py -m ocrmypdf --version
```

If OCRmyPDF is installed but the app still reports `ocrmypdf: false`, set an override command line:

```powershell
# PowerShell (current session)
$env:OCRMYPDF_CMDLINE = "py -m ocrmypdf"
```

or add it to your environment before starting the server.
