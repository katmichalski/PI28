PROJECT INVOICE — PATCH ZIP

This zip contains:
- server/index.js  (updated backend: pdfjs-dist Uint8Array fix, ZIP sniffing, job endpoints, MAX 2 pages per invoice)
- client/src/App.jsx (updated frontend with Preview button + per-output downloads)
- client/vite.config.js (optional dev proxy to backend)

How to apply
1) Copy:
   - server/index.js -> your project /server/index.js
   - client/src/App.jsx -> your project /client/src/App.jsx
   - client/vite.config.js -> your project /client/vite.config.js (if you want proxy)

2) Install backend deps:
   cd server
   npm i express cors multer pdf-lib pdfjs-dist adm-zip xlsx

3) Start backend:
   node index.js
   (should print Server running on http://localhost:5050)

4) Start frontend:
   cd ../client
   npm i
   npm run dev

Notes
- If you use the Vite proxy (client/vite.config.js), you can leave "Backend URL" blank in the UI.
- If you don't use the proxy, set Backend URL in the UI to: http://localhost:5050
- Image inputs are currently passed through (no OCR). PDFs with selectable text get vendor/invoice extraction.
