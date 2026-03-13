import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { PDFDocument } from "pdf-lib";
import { PORT, CLIENT_ORIGIN, JOB_DIR, FORCE_OCR } from "./config.js";
import { ensureSearchablePdf } from "./utils/ocrWholePdf.js";
import { makePlan } from "./utils/plan.js";
import { streamSplitZip, streamBatchZip } from "./utils/split.js";
import { extractInvoiceFieldsFromImageBuffer } from "./utils/invoiceImageOcr.js";
import { extractInvoiceFieldsFromPdfPages, extractInvoiceFieldsFromPdfPage } from "./utils/invoicePdfOcr.js";
import { getOcrmypdfRunner } from "./utils/ocrmypdfRunner.js";
import { terminateWorker, getTessdataStatus } from "./utils/tesseractShared.js";
import { sanitizeFilenameStem } from "./utils/normalize.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(cors({ origin: CLIENT_ORIGIN }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// Make crashes easier to diagnose in dev: log unhandled errors.
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
});

fs.mkdirSync(JOB_DIR, { recursive: true });
// Serve local OCR assets so tesseract.js does not need to download over HTTPS (avoids corporate TLS issues)
app.use("/tessdata", express.static(path.join(__dirname, "tessdata")));
app.use("/_tesscore", express.static(path.join(__dirname, "node_modules", "tesseract.js-core")));


// In-memory progress store: jobId -> { stage, current, total, message, done }
const progress = new Map();

// In-memory result stores so async endpoints can return quickly
const batchPlanResults = new Map(); // batchJobId -> { items, updatedAt }
const pdfOcrResults = new Map();    // jobId -> { ready, result, error, updatedAt }

function pruneOld(map, max = 50) {
  if (map.size <= max) return;
  const entries = Array.from(map.entries())
    .map(([k, v]) => ({ k, t: Number(v?.updatedAt || 0) }))
    .sort((a, b) => a.t - b.t);
  const removeCount = entries.length - max;
  for (let i = 0; i < removeCount; i++) map.delete(entries[i].k);
}

// Simple timeout wrapper to prevent long-running PDF/OCR work from hanging forever
function withTimeout(promise, ms, label, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(async () => {
      try {
        await onTimeout?.();
      } catch {}
      const what = label ? String(label) : "operation";
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}


function setProgress(jobId, patch) {
  const prev = progress.get(jobId) || { stage: "idle", current: 0, total: 0, message: "" };
  progress.set(jobId, { ...prev, ...patch, updatedAt: Date.now() });
}

let _canvasOk = null;
async function canvasOk() {
  if (_canvasOk != null) return _canvasOk;
  try {
    // eslint-disable-next-line no-unused-vars
    const mod = await import("@napi-rs/canvas");
    _canvasOk = true;
  } catch {
    _canvasOk = false;
  }
  return _canvasOk;
}

function ocrmypdfStatus() {
  const runner = getOcrmypdfRunner();
  return {
    ok: Boolean(runner),
    runner: runner?.display || null
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    const engPath = path.join(__dirname, "tessdata", "eng.traineddata");
    const tess = getTessdataStatus();
    const ocr = ocrmypdfStatus();
    res.json({
      ok: true,
      flavor: "invoice-ocr",
      port: PORT,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      // true if local eng.traineddata exists OR we're configured to use a remote tessdata host.
      tessdataEng: fs.existsSync(engPath) || tess.usingRemote,
      tessdataSource: fs.existsSync(engPath) ? "local" : (tess.usingRemote ? "remote" : "missing"),
      ocrmypdf: ocr.ok,
      ocrmypdfRunner: ocr.runner,
      canvas: await canvasOk()
    });
  } catch (err) {
    res.json({ ok: true, flavor: "invoice-ocr", port: PORT, healthError: String(err?.message || err) });
  }
});

/**
 * POST /api/ocr/image
 * form-data: file=<png/jpg>
 *
 * Returns:
 * {
 *   vendorRaw, vendorNorm, vendorMatched, vendorConfidence,
 *   invoiceNumber, invoiceConfidence,
 *   debug: { topVendorText, topLeftText, topMiddleText, topRightText }
 * }
 */
app.post("/api/ocr/image", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ error: "No file uploaded." });

    const mime = String(file.mimetype || "");
    const okMime = /^image\/(png|jpeg|jpg|webp|tiff?)$/i.test(mime);
    if (!okMime) {
      return res.status(400).json({
        error: `Unsupported file type for image OCR: ${mime || "(unknown)"}. Please upload a PNG/JPG image.`
      });
    }

    const result = await extractInvoiceFieldsFromImageBuffer(file.buffer);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

function parsePageList(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  if (raw.toLowerCase() === "all") return ["ALL"];

  // Support: "1", "1,2,3", "1-3" mixed
  const parts = raw.split(/\s*,\s*/g).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b >= 1) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) out.push(i);
      }
      continue;
    }
    const n = Number(part);
    if (Number.isFinite(n) && n >= 1) out.push(n);
  }

  // de-dupe while keeping order
  const seen = new Set();
  const deduped = [];
  for (const n of out) {
    if (!seen.has(n)) {
      seen.add(n);
      deduped.push(n);
    }
  }
  return deduped;
}

/**
/**
 * POST /api/ocr/pdf
 * form-data: file=<pdf>
 * query: pages=1  OR pages=1,2  OR pages=1-3  OR pages=all
 * query: sync=1 (optional) to run OCR synchronously and return results in this response
 *
 * Default behavior is async:
 * - returns { jobId, pageCount, pagesRequested }
 * - stream progress via /api/progress/:jobId
 * - fetch results via GET /api/ocr/pdf/:jobId
 *
 * Extracts vendor + invoice number from scanned/image PDFs by rendering pages to images.
 */
app.post("/api/ocr/pdf", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ error: "No file uploaded." });

    const mime = String(file.mimetype || "");
    const ok = /pdf/i.test(mime) || /\.pdf$/i.test(String(file.originalname || ""));
    if (!ok) {
      return res.status(400).json({
        error: `Unsupported file type for PDF OCR: ${mime || "(unknown)"}. Please upload a PDF.`
      });
    }

    // Save into JOB_DIR so pdfjs rendering can reuse the cache + avoid Buffer->pdfjs issues.
    const jobId = nanoid(10);
    const pdfPath = path.join(JOB_DIR, `${jobId}.pdf`);
    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    fs.writeFileSync(pdfPath, file.buffer);

    // Determine page count (best-effort)
    let pageCount = 0;
    try {
      const src = await PDFDocument.load(file.buffer);
      pageCount = src.getPageCount();
    } catch {
      pageCount = 0;
    }

    const MAX_OCR_PAGES = Number(process.env.PDF_OCR_MAX_PAGES || 10);
    const requested = parsePageList(req.query.pages);

    let pages = [];
    if (requested.length === 1 && requested[0] === "ALL") {
      const n = pageCount || MAX_OCR_PAGES;
      pages = Array.from({ length: Math.min(n, MAX_OCR_PAGES) }, (_, i) => i + 1);
    } else if (requested.length) {
      pages = requested;
    } else {
      pages = [1];
    }

    // Clamp to range if we know pageCount
    if (pageCount) pages = pages.filter((p) => p >= 1 && p <= pageCount);
    pages = pages.slice(0, MAX_OCR_PAGES);
    if (!pages.length) return res.status(400).json({ error: "No valid pages to OCR." });

    // Back-compat: allow synchronous mode
    const sync = String(req.query.sync || "") === "1";
    if (sync) {
      // Make the PDF searchable first when possible; then extract via text-layer fast path.
      const ocrResult = await ensureSearchablePdf({ inputPath: pdfPath, outputPath: ocrPath, force: FORCE_OCR });
      const results = await extractInvoiceFieldsFromPdfPages({ pdfPath: ocrResult.path, pageNumbers: pages });
      return res.json({
        jobId,
        pageCount: pageCount || null,
        ocrApplied: ocrResult.ocrApplied,
        ocrError: ocrResult.ocrError,
        kind: ocrResult.kind,
        pages: results
      });
    }

    // Async mode: start work in background and return immediately.
    pdfOcrResults.set(jobId, {
      ready: false,
      updatedAt: Date.now(),
      pagesRequested: pages,
      pageCount: pageCount || null
    });
    pruneOld(pdfOcrResults);

    setProgress(jobId, { stage: "pdf_ocr", current: 0, total: pages.length, message: "Queued…", done: false });

    res.json({ jobId, pageCount: pageCount || null, pagesRequested: pages });

    (async () => {
      try {
        // Ensure searchable before doing per-page OCR breakdown.
        setProgress(jobId, { stage: "ocr", current: 0, total: 1, message: "Making PDF searchable…", done: false });
        const ocrResult = await ensureSearchablePdf({ inputPath: pdfPath, outputPath: ocrPath, force: FORCE_OCR });
        const workingPdfPath = ocrResult.path;

        const out = [];
        for (let idx = 0; idx < pages.length; idx++) {
          const p = pages[idx];
          setProgress(jobId, {
            stage: "pdf_ocr",
            current: idx + 1,
            total: pages.length,
            message: `OCR page ${p} (${idx + 1}/${pages.length})`,
            done: false
          });
          // Page OCR can be slow on high-resolution scans; default to 10 minutes (configurable).
          const PAGE_TIMEOUT_MS = Number(process.env.PDF_OCR_PAGE_TIMEOUT_MS || 600000);
          out.push(await withTimeout(
            extractInvoiceFieldsFromPdfPage({ pdfPath: workingPdfPath, pageNumber: p }),
            PAGE_TIMEOUT_MS,
            `pdf page OCR (page ${p})`,
            async () => terminateWorker()
          ));
        }

        pdfOcrResults.set(jobId, {
          ready: true,
          updatedAt: Date.now(),
          result: {
            jobId,
            pageCount: pageCount || null,
            ocrApplied: ocrResult.ocrApplied,
            ocrError: ocrResult.ocrError,
            kind: ocrResult.kind,
            pages: out
          }
        });
        pruneOld(pdfOcrResults);

        setProgress(jobId, { stage: "done", done: true, message: "PDF OCR ready." });
      } catch (e) {
        const errMsg = e?.stack || String(e?.message || e);
        pdfOcrResults.set(jobId, { ready: true, updatedAt: Date.now(), error: errMsg });
        pruneOld(pdfOcrResults);
        setProgress(jobId, { stage: "done", done: true, message: `PDF OCR failed: ${String(e?.message || e)}` });
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});
/**
 * GET /api/preview?jobId=xxxxx&pages=1,2
 * Returns an inline PDF made from the requested pages (for UI preview).
 * Safe default: max 4 pages.
 */
app.get("/api/preview", async (req, res) => {
  try {
    const jobId = String(req.query.jobId || "");
    const pagesParam = String(req.query.pages || "");
    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!pagesParam) return res.status(400).json({ error: "Missing pages (e.g. 1,2)." });

    const pageNums = pagesParam
      .split(",")
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n >= 1);

    if (!pageNums.length) return res.status(400).json({ error: "No valid pages provided." });
    if (pageNums.length > 4) return res.status(400).json({ error: "Too many pages for preview (max 4)." });

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    let pdfPath = fs.existsSync(ocrPath) ? ocrPath : inPath;
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "Job not found (PDF missing). Re-run plan." });

    // Ensure the source PDF is searchable before producing any output PDFs.
    if (!fs.existsSync(ocrPath) && fs.existsSync(inPath)) {
      const ocrResult = await ensureSearchablePdf({ inputPath: inPath, outputPath: ocrPath, force: FORCE_OCR });
      pdfPath = ocrResult.path;
    }

    const srcBytes = fs.readFileSync(pdfPath);
    const srcPdf = await PDFDocument.load(srcBytes);
    const maxPage = srcPdf.getPageCount();

    const valid = pageNums.filter((p) => p <= maxPage);
    if (!valid.length) return res.status(400).json({ error: `Pages out of range. PDF has ${maxPage} pages.` });

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, valid.map((p) => p - 1));
    copied.forEach((pg) => outPdf.addPage(pg));

    const bytes = await outPdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="preview_${jobId}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/**
 * GET /api/output?jobId=xxxxx&pages=1,2&name=VENDOR_123
 * Returns a single output PDF (attachment) for the requested pages.
 * Intended for per-row "Download" in the UI.
 */
app.get("/api/output", async (req, res) => {
  try {
    const jobId = String(req.query.jobId || "").trim();
    const pagesParam = String(req.query.pages || "").trim();
    const rawName = String(req.query.name || "").trim();

    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!pagesParam) return res.status(400).json({ error: "Missing pages (e.g. 1,2)." });

    // Parse pages: supports "1", "1,2", "1-3" (same as parsePageList())
    const pages = parsePageList(pagesParam)
      .filter((p) => p !== "ALL")
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n >= 1);

    if (!pages.length) return res.status(400).json({ error: "No valid pages provided." });
    // Safety cap: outputs should usually be 1-2 pages; allow up to 12 just in case.
    if (pages.length > 12) return res.status(400).json({ error: "Too many pages for a single output (max 12)." });

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    let pdfPath = fs.existsSync(ocrPath) ? ocrPath : inPath;
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "Job not found (PDF missing). Re-run plan." });

    // Ensure the source PDF is searchable before producing any output PDFs.
    if (!fs.existsSync(ocrPath) && fs.existsSync(inPath)) {
      const ocrResult = await ensureSearchablePdf({ inputPath: inPath, outputPath: ocrPath, force: FORCE_OCR });
      pdfPath = ocrResult.path;
    }

    const srcBytes = fs.readFileSync(pdfPath);
    const srcPdf = await PDFDocument.load(srcBytes);
    const maxPage = srcPdf.getPageCount();

    const valid = pages.filter((p) => p <= maxPage);
    if (!valid.length) return res.status(400).json({ error: `Pages out of range. PDF has ${maxPage} pages.` });

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, valid.map((p) => p - 1));
    copied.forEach((pg) => outPdf.addPage(pg));
    const bytes = await outPdf.save();

    const stem = sanitizeFilenameStem(String(rawName || "OUTPUT").replace(/\.pdf$/i, "")) || "output_unknownInvoice";
    const filename = `${stem}.pdf`;

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});


// SSE progress stream
app.get("/api/progress/:jobId", (req, res) => {
  const { jobId } = req.params;
  const once = req.query.once === "1";

  if (once) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.json(progress.get(jobId) || null);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const timer = setInterval(() => {
    const p = progress.get(jobId) || null;
    res.write(`data: ${JSON.stringify(p)}\n\n`);
    if (p?.done) {
      clearInterval(timer);
      res.end();
    }
  }, 350);

  req.on("close", () => clearInterval(timer));
});

/**
 * GET /api/batch/plan/:batchJobId
 * Fetch async batch plan results (items include plan/error when ready).
 */
app.get("/api/batch/plan/:batchJobId", (req, res) => {
  const { batchJobId } = req.params;
  const entry = batchPlanResults.get(batchJobId);
  if (!entry) return res.status(404).json({ error: "Batch job not found." });
  const p = progress.get(batchJobId) || null;
  // Prevent browser cache revalidation (304 Not Modified), which breaks fetch().json() in the client.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.json({ batchJobId, done: !!p?.done, progress: p, items: entry.items || [] });
});

/**
 * GET /api/ocr/pdf/:jobId
 * Fetch async PDF OCR result once ready.
 */
app.get("/api/ocr/pdf/:jobId", (req, res) => {
  const { jobId } = req.params;
  const entry = pdfOcrResults.get(jobId);
  if (!entry) return res.status(404).json({ error: "OCR job not found." });

  // Prevent browser cache revalidation (304 Not Modified), which breaks fetch().json() in the client.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (!entry.ready) {
    return res.status(202).json({ ready: false, progress: progress.get(jobId) || null });
  }

  if (entry.error) {
    return res.status(500).json({ ready: true, error: entry.error });
  }

  return res.json({ ready: true, ...(entry.result || {}) });
});

/**
 * POST /api/plan
 * form-data: file=<pdf>
 *
 * Returns:
 * { jobId, ocrApplied, ocrError, plan: { pages, groups, vendorsAdded } }
 */
app.post("/api/plan", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ error: "No file uploaded." });

    const jobId = nanoid(10);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);

    fs.writeFileSync(inPath, file.buffer);

    setProgress(jobId, { stage: "ocr", current: 0, total: 1, message: "Checking OCR…", done: false });

    const ocrResult = await ensureSearchablePdf({ inputPath: inPath, outputPath: ocrPath, force: FORCE_OCR });
    const workingPath = ocrResult.path;

    setProgress(jobId, { stage: "analyzing", current: 0, total: 0, message: "Reading pages…", done: false });

    const plan = await makePlan({
      pdfPath: workingPath,
      onProgress: ({ current, total }) => setProgress(jobId, { stage: "analyzing", current, total, message: `Analyzing page ${current}/${total}` })
    });

    setProgress(jobId, { stage: "done", done: true, message: "Plan ready." });

    res.json({ jobId, ocrApplied: ocrResult.ocrApplied, ocrError: ocrResult.ocrError, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.stack || String(err?.message || err) });
  }
});

/**
 * POST /api/batch/plan
 * form-data: files=<pdf> (multiple)
 * query: sync=1 (optional) to run synchronously and return full plans in this response
 *
 * Default behavior is async:
 * - returns { batchJobId, items: [{ sourceName, jobId }] }
 * - stream progress via /api/progress/:batchJobId
 * - fetch results via GET /api/batch/plan/:batchJobId
 */
app.post("/api/batch/plan", upload.array("files"), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded (field name must be 'files')." });

    const sync = String(req.query.sync || "") === "1";

    const batchJobId = nanoid(10);
    const totalFiles = files.length;

    setProgress(batchJobId, { stage: "batch_ocr", current: 0, total: totalFiles, message: "Starting batch…", done: false });

    // Pre-save inputs so async jobs can run after we respond.
    const inputs = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const jobId = nanoid(10);
      const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
      const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
      fs.writeFileSync(inPath, file.buffer);
      inputs.push({ idx: i, sourceName: file?.originalname || `file_${i + 1}`, jobId, inPath, ocrPath });
    }

    if (sync) {
      // Old behavior: run everything now (blocks this request until complete).
      const items = [];
      for (let i = 0; i < inputs.length; i++) {
        const meta = inputs[i];
        try {
          setProgress(batchJobId, {
            stage: "batch_ocr",
            current: i + 1,
            total: totalFiles,
            message: `OCR check (${i + 1}/${totalFiles}): ${meta.sourceName}`,
            done: false
          });

          const ocrResult = await ensureSearchablePdf({ inputPath: meta.inPath, outputPath: meta.ocrPath, force: FORCE_OCR });
          const workingPath = ocrResult.path;

          setProgress(batchJobId, {
            stage: "batch_analyzing",
            current: i + 1,
            total: totalFiles,
            message: `Analyzing (${i + 1}/${totalFiles}): ${meta.sourceName}`,
            fileIndex: i + 1,
            fileTotal: totalFiles,
            done: false
          });

          const plan = await makePlan({
            pdfPath: workingPath,
            onProgress: ({ current, total }) =>
              setProgress(batchJobId, {
                stage: "batch_analyzing",
                current: i + 1,
                total: totalFiles,
                fileIndex: i + 1,
                fileTotal: totalFiles,
                pageCurrent: current,
                pageTotal: total,
                message: `Analyzing ${meta.sourceName}: page ${current}/${total}`,
                done: false
              })
          });

          items.push({ sourceName: meta.sourceName, jobId: meta.jobId, ocrApplied: ocrResult.ocrApplied, ocrError: ocrResult.ocrError, plan });
        } catch (err) {
          console.error("Batch item failed:", meta.sourceName, err);
          items.push({
            sourceName: meta.sourceName,
            jobId: meta.jobId,
            ocrApplied: false,
            ocrError: null,
            plan: null,
            error: err?.stack || String(err?.message || err)
          });
        }
      }

      setProgress(batchJobId, { stage: "done", done: true, message: "Batch plan ready." });
      return res.json({ batchJobId, items });
    }

    // Async mode: return immediately and do work in the background.
    const placeholderItems = inputs.map((m) => ({
      sourceName: m.sourceName,
      jobId: m.jobId,
      ocrApplied: false,
      ocrError: null,
      plan: null,
      error: ""
    }));

    batchPlanResults.set(batchJobId, { items: placeholderItems, updatedAt: Date.now() });
    pruneOld(batchPlanResults);

    res.json({ batchJobId, items: placeholderItems });

    (async () => {
      try {
        const entry = batchPlanResults.get(batchJobId) || { items: placeholderItems };

        for (let i = 0; i < inputs.length; i++) {
          const meta = inputs[i];
          try {
            setProgress(batchJobId, {
              stage: "batch_ocr",
              current: i + 1,
              total: totalFiles,
              message: `OCR check (${i + 1}/${totalFiles}): ${meta.sourceName}`,
              done: false
            });

            const ocrResult = await ensureSearchablePdf({ inputPath: meta.inPath, outputPath: meta.ocrPath, force: FORCE_OCR });
            const workingPath = ocrResult.path;

            setProgress(batchJobId, {
              stage: "batch_analyzing",
              current: i + 1,
              total: totalFiles,
              message: `Analyzing (${i + 1}/${totalFiles}): ${meta.sourceName}`,
              fileIndex: i + 1,
              fileTotal: totalFiles,
              done: false
            });

            const plan = await makePlan({
              pdfPath: workingPath,
              onProgress: ({ current, total }) =>
                setProgress(batchJobId, {
                  stage: "batch_analyzing",
                  current: i + 1,
                  total: totalFiles,
                  fileIndex: i + 1,
                  fileTotal: totalFiles,
                  pageCurrent: current,
                  pageTotal: total,
                  message: `Analyzing ${meta.sourceName}: page ${current}/${total}`,
                  done: false
                })
            });

            entry.items[i] = {
              sourceName: meta.sourceName,
              jobId: meta.jobId,
              ocrApplied: ocrResult.ocrApplied,
              ocrError: ocrResult.ocrError,
              plan,
              error: ""
            };
          } catch (err) {
            console.error("Batch item failed:", meta.sourceName, err);
            entry.items[i] = {
              sourceName: meta.sourceName,
              jobId: meta.jobId,
              ocrApplied: false,
              ocrError: null,
              plan: null,
              error: err?.stack || String(err?.message || err)
            };
          }

          entry.updatedAt = Date.now();
          batchPlanResults.set(batchJobId, entry);
          pruneOld(batchPlanResults);
        }

        setProgress(batchJobId, { stage: "done", done: true, message: "Batch plan ready." });
      } catch (e) {
        console.error("Async batch plan failed:", e);
        setProgress(batchJobId, { stage: "done", done: true, message: `Batch plan failed: ${String(e?.message || e)}` });
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.stack || String(err?.message || err) });
  }
});
/**
 * POST /api/batch/split
 * body: { batchJobId, items: [{ jobId, groups, folderName?, sourceName? }] }
 * Streams: ZIP file (folders per input PDF)
 */
app.post("/api/batch/split", async (req, res) => {
  try {
    const { batchJobId, items } = req.body || {};
    if (!batchJobId) return res.status(400).json({ error: "Missing batchJobId." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Missing items array." });

    const hasAnyPages = items.some((r) => (Array.isArray(r.groups) ? r.groups : []).some((g) => Array.isArray(g.pages) && g.pages.length > 0));
    if (!hasAnyPages) {
      return res.status(400).json({ error: "No output pages selected. Run Analyze first and ensure at least one group has page numbers." });
    }

    // Ensure each source PDF is searchable BEFORE splitting so output PDFs inherit a text layer.
    setProgress(batchJobId, { stage: "batch_output_ocr", current: 0, total: items.length, message: "Making PDFs searchable…", done: false });

    const resolved = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const jobId = it.jobId;
      const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
      const inPath = path.join(JOB_DIR, `${jobId}.pdf`);

      // Prefer existing OCR'd PDF if present; otherwise attempt to create it.
      let pdfPath = fs.existsSync(ocrPath) ? ocrPath : inPath;
      if (!fs.existsSync(pdfPath)) {
        return res.status(404).json({ error: "One or more jobs not found (PDF missing). Re-run batch plan." });
      }

      if (!fs.existsSync(ocrPath) && fs.existsSync(inPath)) {
        setProgress(batchJobId, {
          stage: "batch_output_ocr",
          current: i + 1,
          total: items.length,
          message: `Making searchable (${i + 1}/${items.length}): ${it.sourceName || it.folderName || jobId}`,
          done: false
        });
        const ocrResult = await ensureSearchablePdf({ inputPath: inPath, outputPath: ocrPath, force: FORCE_OCR });
        pdfPath = ocrResult.path;
      }

      resolved.push({
        pdfPath,
        groups: Array.isArray(it.groups) ? it.groups : [],
        folderName: it.folderName || it.sourceName || jobId,
        sourceName: it.sourceName || it.folderName || jobId
      });
    }

    setProgress(batchJobId, { stage: "batch_splitting", current: 0, total: items.length, message: "Packaging ZIP…", done: false });

    let last = 0;
    await streamBatchZip({
      items: resolved,
      res,
      zipName: "batch_split_invoices.zip",
      onProgress: (p) => {
        // coarse file progress + fine group progress
        setProgress(batchJobId, {
          stage: "batch_splitting",
          current: p.fileIndex,
          total: p.fileTotal,
          doneGroups: p.doneGroups,
          totalGroups: p.totalGroups,
          message: `Splitting ${p.fileName}: ${p.groupIndex}/${p.groupTotal} • ${p.outputName}`,
          done: false
        });
        last = p.doneGroups || last;
      }
    });

    setProgress(batchJobId, { stage: "done", done: true, message: "Batch download ready." });
  } catch (err) {
    console.error(err);
    try {
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      else res.end();
    } catch {}
  }
});

/**
 * POST /api/split
 * body: { jobId, groups }
 * Streams: ZIP file
 */
app.post("/api/split", async (req, res) => {
  try {
    const { jobId, groups } = req.body || {};
    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!Array.isArray(groups)) return res.status(400).json({ error: "Missing groups array." });

    const hasAnyPages = groups.some((g) => Array.isArray(g.pages) && g.pages.length > 0);
    if (!hasAnyPages) {
      return res.status(400).json({ error: "No pages selected for split. Ensure each group has a non-empty pages array." });
    }

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);

    // Ensure the source PDF is searchable BEFORE producing output PDFs.
    // This makes the split PDFs inherit a text layer (searchable) when OCRmyPDF is available.
    let pdfPath = fs.existsSync(ocrPath) ? ocrPath : inPath;
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "Job not found (PDF missing). Re-run plan." });

    if (!fs.existsSync(ocrPath) && fs.existsSync(inPath)) {
      setProgress(jobId, { stage: "ocr", current: 0, total: 1, message: "Making PDF searchable…", done: false });
      const ocrResult = await ensureSearchablePdf({ inputPath: inPath, outputPath: ocrPath, force: FORCE_OCR });
      pdfPath = ocrResult.path;
    }

    setProgress(jobId, { stage: "splitting", current: 0, total: groups.length, message: "Creating output PDFs…", done: false });

    // Stream zip; update progress by counting files appended is hard with archiver, so do coarse updates
    let idx = 0;
    const wrappedGroups = groups.map((g) => ({ ...g }));

    // Monkey-patch: update progress roughly before streaming
    for (const g of wrappedGroups) {
      idx++;
      setProgress(jobId, { stage: "splitting", current: idx, total: wrappedGroups.length, message: `Preparing file ${idx}/${wrappedGroups.length}` });
    }

    // Now actually stream (this is fast compared to OCR)
    await streamSplitZip({ pdfPath, groups: wrappedGroups, res });
    setProgress(jobId, { stage: "done", done: true, message: "Download ready." });
  } catch (err) {
    console.error(err);
    // If headers already sent, just end
    try {
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
      else res.end();
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${CLIENT_ORIGIN}`);
});
