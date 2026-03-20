import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { PDFDocument } from "pdf-lib";
import { PORT, CLIENT_ORIGIN, JOB_DIR, FORCE_OCR, VENDOR_CSV_PATH } from "./config.js";
import { ensureSearchablePdf } from "./utils/ocrWholePdf.js";
import { makePlan } from "./utils/plan.js";
import { streamSplitZip, streamBatchZip } from "./utils/split.js";
import { extractInvoiceFieldsFromImageBuffer } from "./utils/invoiceImageOcr.js";
import { extractInvoiceFieldsFromPdfPages, extractInvoiceFieldsFromPdfPage } from "./utils/invoicePdfOcr.js";
import { enrichPlanWithVendorOcr, getVendorCatalogSource } from "./utils/vendorResolver.js";
import { getOcrmypdfRunner } from "./utils/ocrmypdfRunner.js";
import { terminateWorker, getTessdataStatus } from "./utils/tesseractShared.js";
import { sanitizeFilenameStem } from "./utils/normalize.js";
import { loadVendorIndex } from "./utils/vendorStore.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const MAX_OCR_PAGES = Number(process.env.PDF_OCR_MAX_PAGES || 10);
const PDF_OCR_PAGE_TIMEOUT_MS = Number(process.env.PDF_OCR_PAGE_TIMEOUT_MS || 600000);
const MAP_MAX_ENTRIES = 50;

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(
  cors({
    origin(origin, cb) {
      if (!CLIENT_ORIGIN) return cb(null, true);
      if (!origin) return cb(null, true);
      return cb(null, origin === CLIENT_ORIGIN);
    }
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    try {
      await terminateWorker();
    } catch (err) {
      console.error(`Failed to terminate OCR worker on ${signal}:`, err);
    } finally {
      process.exit(0);
    }
  });
}

fs.mkdirSync(JOB_DIR, { recursive: true });

app.use("/tessdata", express.static(path.join(__dirname, "tessdata")));
app.use("/_tesscore", express.static(path.join(__dirname, "node_modules", "tesseract.js-core")));

const progress = new Map();
const batchPlanResults = new Map();
const pdfOcrResults = new Map();

function pruneOld(map, max = MAP_MAX_ENTRIES) {
  if (map.size <= max) return;

  const entries = Array.from(map.entries())
    .map(([key, value]) => ({ key, updatedAt: Number(value?.updatedAt || 0) }))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const removeCount = entries.length - max;
  for (let i = 0; i < removeCount; i += 1) {
    map.delete(entries[i].key);
  }
}

function withTimeout(promise, ms, label, onTimeout) {
  if (!ms || ms <= 0) return promise;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try {
        await onTimeout?.();
      } catch {
        // ignore timeout cleanup failures
      }
      reject(new Error(`${label || "operation"} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setProgress(jobId, patch) {
  const prev = progress.get(jobId) || {
    stage: "idle",
    current: 0,
    total: 0,
    message: "",
    done: false,
    updatedAt: Date.now()
  };

  progress.set(jobId, {
    ...prev,
    ...patch,
    updatedAt: Date.now()
  });
  pruneOld(progress);
}

let canvasOkCache = null;
async function canvasOk() {
  if (canvasOkCache != null) return canvasOkCache;
  try {
    await import("@napi-rs/canvas");
    canvasOkCache = true;
  } catch {
    canvasOkCache = false;
  }
  return canvasOkCache;
}

function ocrmypdfStatus() {
  const runner = getOcrmypdfRunner();
  return {
    ok: Boolean(runner),
    runner: runner?.display || null
  };
}

function parsePageList(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  if (raw.toLowerCase() === "all") return ["ALL"];

  const parts = raw.split(/\s*,\s*/g).filter(Boolean);
  const out = [];

  for (const part of parts) {
    const range = part.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b >= 1) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let page = lo; page <= hi; page += 1) out.push(page);
      }
      continue;
    }

    const n = Number(part);
    if (Number.isFinite(n) && n >= 1) out.push(n);
  }

  return Array.from(new Set(out));
}

function requireFile(req, res) {
  const file = req.file;
  if (!file?.buffer) {
    res.status(400).json({ error: "No file uploaded." });
    return null;
  }
  return file;
}

function validatePdfUpload(file) {
  const mime = String(file?.mimetype || "");
  const name = String(file?.originalname || "");
  return /pdf/i.test(mime) || /\.pdf$/i.test(name);
}

async function ensureWorkingPdf({ inPath, ocrPath }) {
  if (fs.existsSync(ocrPath)) return ocrPath;
  if (!fs.existsSync(inPath)) return null;

  const ocrResult = await ensureSearchablePdf({
    inputPath: inPath,
    outputPath: ocrPath,
    force: FORCE_OCR
  });

  return ocrResult.path;
}

async function loadPdfPageCount(buffer) {
  try {
    const src = await PDFDocument.load(buffer);
    return src.getPageCount();
  } catch {
    return 0;
  }
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
      tessdataEng: fs.existsSync(engPath) || tess.usingRemote,
      tessdataSource: fs.existsSync(engPath) ? "local" : tess.usingRemote ? "remote" : "missing",
      ocrmypdf: ocr.ok,
      ocrmypdfRunner: ocr.runner,
      canvas: await canvasOk(),
      tesseractWorkerInitTimeoutMs: tess.workerInitTimeoutMs,
      tesseractWorkerInitRetries: tess.workerInitRetries,
      tesseractWorkerRetryDelayMs: tess.workerRetryDelayMs,
      tesseractWorkerIdleTerminateMs: tess.workerIdleTerminateMs,
      tesseractCoreDir: tess.coreDir,
      tesseractWorkerPath: tess.workerPath,
      vendorCatalogSource: getVendorCatalogSource()
    });
  } catch (err) {
    res.json({
      ok: true,
      flavor: "invoice-ocr",
      port: PORT,
      healthError: String(err?.message || err)
    });
  }
});

app.get("/api/vendors", (_req, res) => {
  try {
    const { entries } = loadVendorIndex();
    const vendors = entries.map((e) => e.raw);
    res.json({ vendors, count: vendors.length });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post("/api/ocr/image", upload.single("file"), async (req, res) => {
  try {
    const file = requireFile(req, res);
    if (!file) return;

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

app.post("/api/ocr/pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const jobId = nanoid(10);
    const pdfPath = path.join(JOB_DIR, `${jobId}.pdf`);
    fs.writeFileSync(pdfPath, req.file.buffer);

    const results = await extractInvoiceFieldsFromPdfPages({
      pdfPath,
      pageNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
      vendorCsvPath: VENDOR_CSV_PATH
    });

    res.json({ jobId, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/api/preview", async (req, res) => {
  try {
    const jobId = String(req.query.jobId || "");
    const pagesParam = String(req.query.pages || "");
    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!pagesParam) return res.status(400).json({ error: "Missing pages (e.g. 1,2)." });

    const pageNums = pagesParam
      .split(",")
      .map((value) => Number(String(value).trim()))
      .filter((n) => Number.isFinite(n) && n >= 1);

    if (!pageNums.length) return res.status(400).json({ error: "No valid pages provided." });
    if (pageNums.length > 4) return res.status(400).json({ error: "Too many pages for preview (max 4)." });

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    const pdfPath = await ensureWorkingPdf({ inPath, ocrPath });

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "Job not found (PDF missing). Re-run plan." });
    }

    const srcBytes = fs.readFileSync(pdfPath);
    const srcPdf = await PDFDocument.load(srcBytes);
    const maxPage = srcPdf.getPageCount();

    const valid = pageNums.filter((page) => page <= maxPage);
    if (!valid.length) {
      return res.status(400).json({ error: `Pages out of range. PDF has ${maxPage} pages.` });
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, valid.map((page) => page - 1));
    copied.forEach((page) => outPdf.addPage(page));

    const bytes = await outPdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="preview_${jobId}.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/api/output", async (req, res) => {
  try {
    const jobId = String(req.query.jobId || "").trim();
    const pagesParam = String(req.query.pages || "").trim();
    const rawName = String(req.query.name || "").trim();

    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!pagesParam) return res.status(400).json({ error: "Missing pages (e.g. 1,2)." });

    const pages = parsePageList(pagesParam)
      .filter((page) => page !== "ALL")
      .map((value) => Number(value))
      .filter((n) => Number.isFinite(n) && n >= 1);

    if (!pages.length) return res.status(400).json({ error: "No valid pages provided." });
    if (pages.length > 12) return res.status(400).json({ error: "Too many pages for a single output (max 12)." });

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    const pdfPath = await ensureWorkingPdf({ inPath, ocrPath });

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "Job not found (PDF missing). Re-run plan." });
    }

    const srcBytes = fs.readFileSync(pdfPath);
    const srcPdf = await PDFDocument.load(srcBytes);
    const maxPage = srcPdf.getPageCount();

    const valid = pages.filter((page) => page <= maxPage);
    if (!valid.length) {
      return res.status(400).json({ error: `Pages out of range. PDF has ${maxPage} pages.` });
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, valid.map((page) => page - 1));
    copied.forEach((page) => outPdf.addPage(page));

    const bytes = await outPdf.save();
    const stem = sanitizeFilenameStem(String(rawName || "OUTPUT").replace(/\.pdf$/i, "")) || "output_unknownInvoice";
    const filename = `${stem}.pdf`;

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/api/progress/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const snapshot = progress.get(jobId);

  if (!snapshot) {
    return res.status(404).json({ error: "Job not found." });
  }

  const accept = String(req.headers.accept || "");
  const wantsSse = accept.includes("text/event-stream");
  const once = String(req.query.once || "") === "1";

  if (!wantsSse || once) {
    return res.json(snapshot);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = () => {
    const current = progress.get(jobId) || {
      stage: "unknown",
      current: 0,
      total: 0,
      message: "Job not found.",
      done: true,
      error: "Job not found."
    };

    res.write(`data: ${JSON.stringify(current)}\n\n`);

    if (current.done) {
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    }
  };

  res.write(": connected\n\n");
  send();

  const timer = setInterval(send, 1000);
  req.on("close", () => {
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  });
});

app.get("/api/ocr/pdf/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const entry = pdfOcrResults.get(jobId);

  if (!entry) return res.status(404).json({ error: "Job not found." });

  if (!entry.ready) {
    return res.json({
      ready: false,
      jobId,
      pageCount: entry.pageCount ?? null,
      pagesRequested: entry.pagesRequested ?? []
    });
  }

  if (entry.error) {
    return res.status(500).json({
      ready: true,
      jobId,
      error: entry.error
    });
  }

  return res.json({ ready: true, ...(entry.result || {}) });
});

app.get("/api/batch/plan/:batchJobId", (req, res) => {
  const batchJobId = String(req.params.batchJobId || "");
  const entry = batchPlanResults.get(batchJobId);

  if (!entry) return res.status(404).json({ error: "Batch job not found." });

  return res.json({
    batchJobId,
    items: entry.items || []
  });
});

app.post("/api/plan", upload.single("file"), async (req, res) => {
  try {
    const file = requireFile(req, res);
    if (!file) return;

    if (!validatePdfUpload(file)) {
      return res.status(400).json({ error: "Please upload a PDF file." });
    }

    const jobId = nanoid(10);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    fs.writeFileSync(inPath, file.buffer);

    setProgress(jobId, {
      stage: "ocr",
      current: 0,
      total: 1,
      message: "Making PDF searchable...",
      done: false
    });

    const ocrResult = await ensureSearchablePdf({
      inputPath: inPath,
      outputPath: ocrPath,
      force: FORCE_OCR
    });

    setProgress(jobId, {
      stage: "analyzing",
      current: 0,
      total: 0,
      message: "Analyzing pages...",
      done: false
    });

    const basePlan = await makePlan({
      pdfPath: ocrResult.path,
      onProgress: ({ current, total }) =>
        setProgress(jobId, {
          stage: "analyzing",
          current,
          total,
          message: `Analyzing page ${current}/${total}`,
          done: false
        })
    });

    setProgress(jobId, {
      stage: "vendor_ocr",
      current: 0,
      total: Array.isArray(basePlan?.groups) ? basePlan.groups.length : 0,
      message: "Resolving unknown vendors...",
      done: false
    });

    const plan = await enrichPlanWithVendorOcr({
      plan: basePlan,
      pdfPath: ocrResult.path,
      jobId,
      onProgress: ({ current, total, message }) =>
        setProgress(jobId, {
          stage: "vendor_ocr",
          current,
          total,
          message,
          done: false
        })
    });

    setProgress(jobId, {
      stage: "done",
      done: true,
      message: "Plan ready."
    });

    res.json({
      jobId,
      ocrApplied: ocrResult.ocrApplied,
      ocrError: ocrResult.ocrError,
      plan
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.stack || String(err?.message || err) });
  }
});

async function buildPlannedBatchItem(meta, batchJobId, index, totalFiles) {
  setProgress(batchJobId, {
    stage: "batch_ocr",
    current: index + 1,
    total: totalFiles,
    message: `OCR check (${index + 1}/${totalFiles}): ${meta.sourceName}`,
    done: false
  });

  const ocrResult = await ensureSearchablePdf({
    inputPath: meta.inPath,
    outputPath: meta.ocrPath,
    force: FORCE_OCR
  });

  setProgress(batchJobId, {
    stage: "batch_analyzing",
    current: index + 1,
    total: totalFiles,
    message: `Analyzing (${index + 1}/${totalFiles}): ${meta.sourceName}`,
    fileIndex: index + 1,
    fileTotal: totalFiles,
    done: false
  });

  const basePlan = await makePlan({
    pdfPath: ocrResult.path,
    onProgress: ({ current, total }) =>
      setProgress(batchJobId, {
        stage: "batch_analyzing",
        current: index + 1,
        total: totalFiles,
        fileIndex: index + 1,
        fileTotal: totalFiles,
        pageCurrent: current,
        pageTotal: total,
        message: `Analyzing ${meta.sourceName}: page ${current}/${total}`,
        done: false
      })
  });

  setProgress(batchJobId, {
    stage: "batch_vendor_ocr",
    current: index + 1,
    total: totalFiles,
    fileIndex: index + 1,
    fileTotal: totalFiles,
    message: `Resolving vendors (${index + 1}/${totalFiles}): ${meta.sourceName}`,
    done: false
  });

  const plan = await enrichPlanWithVendorOcr({
    plan: basePlan,
    pdfPath: ocrResult.path,
    jobId: meta.jobId,
    onProgress: ({ current, total, message }) =>
      setProgress(batchJobId, {
        stage: "batch_vendor_ocr",
        current: index + 1,
        total: totalFiles,
        fileIndex: index + 1,
        fileTotal: totalFiles,
        groupCurrent: current,
        groupTotal: total,
        message: `${meta.sourceName}: ${message}`,
        done: false
      })
  });

  return {
    sourceName: meta.sourceName,
    jobId: meta.jobId,
    ocrApplied: ocrResult.ocrApplied,
    ocrError: ocrResult.ocrError,
    plan,
    error: ""
  };
}

app.post("/api/batch/plan", upload.array("files"), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({
        error: "No files uploaded (field name must be 'files')."
      });
    }

    const sync = String(req.query.sync || "") === "1";
    const batchJobId = nanoid(10);
    const totalFiles = files.length;

    setProgress(batchJobId, {
      stage: "batch_ocr",
      current: 0,
      total: totalFiles,
      message: "Starting batch...",
      done: false
    });

    const inputs = files.map((file, index) => {
      const jobId = nanoid(10);
      const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
      const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
      fs.writeFileSync(inPath, file.buffer);
      return {
        idx: index,
        sourceName: file?.originalname || `file_${index + 1}`,
        jobId,
        inPath,
        ocrPath
      };
    });

    if (sync) {
      const items = [];
      for (let i = 0; i < inputs.length; i += 1) {
        const meta = inputs[i];
        try {
          items.push(await buildPlannedBatchItem(meta, batchJobId, i, totalFiles));
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

      setProgress(batchJobId, {
        stage: "done",
        done: true,
        message: "Batch plan ready."
      });

      return res.json({ batchJobId, items });
    }

    const placeholderItems = inputs.map((meta) => ({
      sourceName: meta.sourceName,
      jobId: meta.jobId,
      ocrApplied: false,
      ocrError: null,
      plan: null,
      error: ""
    }));

    batchPlanResults.set(batchJobId, {
      items: placeholderItems,
      updatedAt: Date.now()
    });
    pruneOld(batchPlanResults);

    res.json({ batchJobId, items: placeholderItems });

    (async () => {
      try {
        const entry = batchPlanResults.get(batchJobId) || { items: placeholderItems };

        for (let i = 0; i < inputs.length; i += 1) {
          const meta = inputs[i];
          try {
            entry.items[i] = await buildPlannedBatchItem(meta, batchJobId, i, totalFiles);
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

        setProgress(batchJobId, {
          stage: "done",
          done: true,
          message: "Batch plan ready."
        });
      } catch (err) {
        console.error("Async batch plan failed:", err);
        setProgress(batchJobId, {
          stage: "done",
          done: true,
          message: `Batch plan failed: ${String(err?.message || err)}`,
          error: String(err?.message || err)
        });
      }
    })();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.stack || String(err?.message || err) });
  }
});

app.post("/api/batch/split", async (req, res) => {
  try {
    const { batchJobId, items } = req.body || {};
    if (!batchJobId) return res.status(400).json({ error: "Missing batchJobId." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Missing items array." });

    const hasAnyPages = items.some((item) =>
      (Array.isArray(item.groups) ? item.groups : []).some((group) => Array.isArray(group.pages) && group.pages.length > 0)
    );

    if (!hasAnyPages) {
      return res.status(400).json({
        error: "No output pages selected. Run Analyze first and ensure at least one group has page numbers."
      });
    }

    setProgress(batchJobId, {
      stage: "batch_output_ocr",
      current: 0,
      total: items.length,
      message: "Making PDFs searchable...",
      done: false
    });

    const resolved = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] || {};
      const jobId = String(item.jobId || "").trim();
      if (!jobId) continue;

      const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
      const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
      if (!fs.existsSync(inPath) && !fs.existsSync(ocrPath)) {
        return res.status(404).json({ error: `Source PDF not found for jobId=${jobId}. Re-run Analyze.` });
      }

      setProgress(batchJobId, {
        stage: "batch_output_ocr",
        current: i + 1,
        total: items.length,
        message: `Preparing output PDF ${i + 1}/${items.length}`,
        done: false
      });

      const pdfPath = await ensureWorkingPdf({ inPath, ocrPath });
      resolved.push({
        jobId,
        pdfPath,
        groups: Array.isArray(item.groups) ? item.groups : [],
        folderName: item.folderName || "",
        sourceName: item.sourceName || ""
      });
    }

    setProgress(batchJobId, {
      stage: "batch_output",
      current: 0,
      total: resolved.length,
      message: "Building ZIP...",
      done: false
    });

    await streamBatchZip({
      res,
      items: resolved,
      onProgress: (patch) => setProgress(batchJobId, patch)
    });

    setProgress(batchJobId, {
      stage: "done",
      done: true,
      message: "Batch ZIP ready."
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.stack || String(err?.message || err) });
    }
  }
});

app.post("/api/split", async (req, res) => {
  try {
    const { jobId, groups } = req.body || {};
    if (!jobId) return res.status(400).json({ error: "Missing jobId." });
    if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: "Missing groups array." });

    const hasAnyPages = groups.some((group) => Array.isArray(group.pages) && group.pages.length > 0);
    if (!hasAnyPages) {
      return res.status(400).json({
        error: "No output pages selected. Run Analyze first and ensure at least one group has page numbers."
      });
    }

    const ocrPath = path.join(JOB_DIR, `${jobId}.ocr.pdf`);
    const inPath = path.join(JOB_DIR, `${jobId}.pdf`);
    if (!fs.existsSync(inPath) && !fs.existsSync(ocrPath)) {
      return res.status(404).json({ error: "Source PDF not found for this job. Re-run Analyze." });
    }

    setProgress(jobId, {
      stage: "output_ocr",
      current: 0,
      total: 1,
      message: "Making output PDF searchable...",
      done: false
    });

    const pdfPath = await ensureWorkingPdf({ inPath, ocrPath });

    setProgress(jobId, {
      stage: "output",
      current: 0,
      total: groups.length,
      message: "Building ZIP...",
      done: false
    });

    await streamSplitZip({
      res,
      jobId,
      pdfPath,
      groups,
      onProgress: (patch) => setProgress(jobId, patch)
    });

    setProgress(jobId, {
      stage: "done",
      done: true,
      message: "ZIP ready."
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.stack || String(err?.message || err) });
    }
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `Upload exceeded ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit.`
      : err.message;
    return res.status(400).json({ error: message });
  }

  console.error(err);
  return res.status(500).json({ error: err?.message || "Internal server error." });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${CLIENT_ORIGIN || "*"}`);
});