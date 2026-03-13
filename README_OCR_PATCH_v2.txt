PROJECT INVOICE — OCR PATCH (v2)

Why you're seeing "No PDF header found"
- That error is NOT because the PDF is image-based.
- It happens when the bytes received are NOT a PDF (common causes: you uploaded a ZIP, an image, an HTML error page, or the file is corrupted),
  OR the PDF has junk bytes before the real %PDF- header.

What this patch does
- Detects file type by magic bytes (PDF/ZIP/PNG/JPG).
- Repairs PDFs with junk before %PDF- by slicing to the real header.
- If pdf.js still fails, it returns a clear JSON error containing:
  detected type + first bytes (ascii/hex) to identify what was uploaded.
- If the PDF page has little/no text, it renders that page to PNG and runs OCR with tesseract.js.

Install backend deps
  cd server
  npm i express cors multer pdf-lib pdfjs-dist adm-zip xlsx tesseract.js @napi-rs/canvas

Run
  node index.js

Verify server is the OCR build:
  Open http://localhost:5050/api/health
  It should return: {"ok":true,"flavor":"ocr-v2",...}

If you still get an error:
- The server will now respond with a JSON error including headAscii/headHex and detected type.
  Paste that message into chat and I can tell you exactly what file is being uploaded.


[Option A] OCRmyPDF command override:
- Set in server/.env: OCRMYPDF_CMDLINE=py -m ocrmypdf
- Server loads server/.env via dotenv in server/config.js
