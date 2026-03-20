const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const XLSX = require("xlsx");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument } = require("pdf-lib");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 5050);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

const vendorListPath = path.join(__dirname, "Vendor List.xlsx");
const vendorTemplatePath = path.join(__dirname, "data", "vendor-templates.json");

let extractPageTexts = async () => [];

try {
  const pdfUtils = require("./utils/pdfTextWithOcr");
  if (typeof pdfUtils.extractPageTexts === "function") {
    extractPageTexts = pdfUtils.extractPageTexts;
  }
} catch (err) {
  console.warn(
    "Warning: ./utils/pdfTextWithOcr could not be loaded. OCR text extraction will be empty until that file is available."
  );
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeVendorName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeFilePart(value, fallback) {
  const clean = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return clean || fallback;
}

function makeOfficialFileName(vendorName, invoiceNumber) {
  const vendorPart = normalizeVendorName(vendorName || "UNKNOWN_VENDOR");
  const invoicePart = sanitizeFilePart(invoiceNumber, "UNKNOWN_INVOICE");
  return `${vendorPart}_${invoicePart}.pdf`;
}

function tokenizeNormalized(value) {
  return normalizeVendorName(value)
    .split("_")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function dedupeByNormalized(entries) {
  const map = new Map();

  for (const entry of entries) {
    const vendorName = String(entry?.vendorName || "").trim();
    if (!vendorName) continue;

    const normalizedVendor = normalizeVendorName(vendorName);
    if (!normalizedVendor) continue;

    if (!map.has(normalizedVendor)) {
      map.set(normalizedVendor, {
        vendorName,
        normalizedVendor,
      });
    }
  }

  return Array.from(map.values());
}

function readVendorTemplates() {
  try {
    if (!fs.existsSync(vendorTemplatePath)) {
      return {};
    }

    const raw = fs.readFileSync(vendorTemplatePath, "utf8");
    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error("Failed reading vendor templates:", err);
    return {};
  }
}

function writeVendorTemplates(data) {
  ensureParentDir(vendorTemplatePath);
  fs.writeFileSync(vendorTemplatePath, JSON.stringify(data, null, 2), "utf8");
}

function safeReadVendorsFromXlsx() {
  try {
    if (!fs.existsSync(vendorListPath)) {
      return [];
    }

    const workbook = XLSX.readFile(vendorListPath);
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    });

    const values = [];

    for (const row of rows) {
      if (!Array.isArray(row)) continue;

      for (const cell of row) {
        const value = String(cell || "").trim();
        if (!value) continue;

        const normalized = normalizeVendorName(value);
        if (!normalized) continue;
        if (normalized === "VENDORNAME" || normalized === "VENDOR_NAME") continue;

        values.push(value);
      }
    }

    return Array.from(new Set(values));
  } catch (err) {
    console.error("Failed reading Vendor List.xlsx:", err);
    return [];
  }
}

function safeEnsureVendorInXlsx(vendorName) {
  const clean = String(vendorName || "").trim();
  if (!clean) return;

  const normalizedNew = normalizeVendorName(clean);
  if (!normalizedNew) return;

  try {
    let workbook;
    let sheetName;
    let worksheet;

    if (fs.existsSync(vendorListPath)) {
      workbook = XLSX.readFile(vendorListPath);
      sheetName = workbook.SheetNames[0] || "Vendors";
      worksheet = workbook.Sheets[sheetName];
    } else {
      workbook = XLSX.utils.book_new();
      worksheet = XLSX.utils.aoa_to_sheet([["VendorName"]]);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Vendors");
      sheetName = "Vendors";
    }

    const existing = safeReadVendorsFromXlsx();
    const existingSet = new Set(existing.map(normalizeVendorName));

    if (existingSet.has(normalizedNew)) {
      return;
    }

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    });

    if (!rows.length) {
      rows.push(["VendorName"]);
    }

    rows.push([clean]);

    workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
    ensureParentDir(vendorListPath);
    XLSX.writeFile(workbook, vendorListPath);

    console.log(`Added vendor to Vendor List.xlsx: ${clean}`);
  } catch (err) {
    console.error(`Failed to append vendor "${clean}" to Vendor List.xlsx:`, err);
  }
}

function getKnownVendorEntries() {
  const entries = safeReadVendorsFromXlsx().map((vendorName) => ({ vendorName }));
  const templates = readVendorTemplates();

  for (const key of Object.keys(templates)) {
    const item = templates[key];
    if (!item) continue;

    entries.push({
      vendorName: item.vendorName || key,
    });
  }

  return dedupeByNormalized(entries);
}

function scoreVendorAgainstText(vendorName, normalizedText, textTokenSet) {
  const normalizedVendor = normalizeVendorName(vendorName);
  if (!normalizedVendor) return 0;

  if (normalizedText.includes(normalizedVendor)) {
    return 1000 + normalizedVendor.length;
  }

  const vendorTokens = tokenizeNormalized(normalizedVendor);
  if (!vendorTokens.length) return 0;

  let hits = 0;
  for (const token of vendorTokens) {
    if (textTokenSet.has(token)) hits += 1;
  }

  const ratio = hits / vendorTokens.length;

  if (ratio === 1) return 500 + vendorTokens.length;
  if (ratio >= 0.75) return 200 + hits;
  if (ratio >= 0.5 && vendorTokens.length >= 3) return 100 + hits;

  return 0;
}

function findBestVendorMatch(pageText, vendorEntries) {
  const normalizedText = normalizeVendorName(pageText || "");
  const textTokenSet = new Set(tokenizeNormalized(normalizedText));

  let best = {
    vendorName: "UNKNOWN_VENDOR",
    normalizedVendor: "UNKNOWN_VENDOR",
    score: 0,
  };

  for (const entry of vendorEntries) {
    const vendorName = entry.vendorName;
    const score = scoreVendorAgainstText(vendorName, normalizedText, textTokenSet);

    if (score > best.score) {
      best = {
        vendorName,
        normalizedVendor: normalizeVendorName(vendorName),
        score,
      };
    }
  }

  return best;
}

function extractInvoiceNumber(text) {
  const source = String(text || "");
  if (!source.trim()) return "";

  const patterns = [
    /(?:invoice\s*(?:number|num|no|#)?|inv\s*(?:number|num|no|#)?)[^0-9]{0,16}([0-9][0-9\-/]{1,})/i,
    /(?:bill\s*(?:number|num|no|#)?)[^0-9]{0,16}([0-9][0-9\-/]{1,})/i,
    /(?:reference\s*(?:number|num|no|#)?)[^0-9]{0,16}([0-9][0-9\-/]{1,})/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match || !match[1]) continue;

    const cleaned = match[1].replace(/[^0-9\-/]/g, "");
    if (cleaned && /^[0-9][0-9\-/]*$/.test(cleaned)) {
      return cleaned;
    }
  }

  const fallback = source.match(/\b[0-9][0-9\-/]{3,}\b/g);
  if (fallback?.length) {
    const value = fallback
      .map((item) => item.replace(/[^0-9\-/]/g, ""))
      .find((item) => /^[0-9][0-9\-/]*$/.test(item));

    if (value) return value;
  }

  return "";
}

function makeReviewId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function renderPdfPagesToDataUrls(pdfBuffer) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "project-invoice-preview-")
  );

  const inputPdfPath = path.join(tempDir, "input.pdf");
  const outputPrefix = path.join(tempDir, "page");

  try {
    fs.writeFileSync(inputPdfPath, pdfBuffer);

    const pdftoppmPath = process.env.PDFTOPPM_PATH || "pdftoppm";

    await execFileAsync(
      pdftoppmPath,
      ["-png", "-r", "150", inputPdfPath, outputPrefix],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 50,
      }
    );

    const pageFiles = fs
      .readdirSync(tempDir)
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => {
        const aNum = Number((a.match(/page-(\d+)\.png/i) || [])[1] || 0);
        const bNum = Number((b.match(/page-(\d+)\.png/i) || [])[1] || 0);
        return aNum - bNum;
      });

    return pageFiles.map((fileName) => {
      const filePath = path.join(tempDir, fileName);
      const base64 = fs.readFileSync(filePath).toString("base64");
      return `data:image/png;base64,${base64}`;
    });
  } catch (err) {
    console.error("renderPdfPagesToDataUrls failed:", err);
    return [];
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildPlanResponseFromUpload(file) {
  if (!file?.buffer) {
    throw new Error("No uploaded file buffer found.");
  }

  const originalFileName = file.originalname || "upload.pdf";
  const knownVendorEntries = getKnownVendorEntries();
  const templates = readVendorTemplates();

  let pageTexts = [];
  let pagePreviewUrls = [];

  try {
    pageTexts = await extractPageTexts(file.buffer);
  } catch (err) {
    console.error("extractPageTexts failed:", err);
    pageTexts = [];
  }

  try {
    pagePreviewUrls = await renderPdfPagesToDataUrls(file.buffer);
  } catch (err) {
    console.error("Preview rendering failed:", err);
    pagePreviewUrls = [];
  }

  if (!Array.isArray(pageTexts)) pageTexts = [];
  if (!Array.isArray(pagePreviewUrls)) pagePreviewUrls = [];

  const totalPages = Math.max(pageTexts.length, pagePreviewUrls.length, 1);
  if (pageTexts.length < totalPages) {
    pageTexts = Array.from({ length: totalPages }, (_, i) => pageTexts[i] || "");
  }

  const results = [];
  const newVendorReviews = [];

  for (let i = 0; i < totalPages; i += 1) {
    const pageNumber = i + 1;
    const pageText = String(pageTexts[i] || "");
    const previewUrl = pagePreviewUrls[i] || "";
    const vendorMatch = findBestVendorMatch(pageText, knownVendorEntries);
    const invoiceNumber = extractInvoiceNumber(pageText);
    const matchedVendorName = vendorMatch.vendorName || "UNKNOWN_VENDOR";
    const normalizedVendor =
      vendorMatch.normalizedVendor || normalizeVendorName(matchedVendorName);
    const existingTemplate = templates[normalizedVendor] || null;
    const officialFileName = makeOfficialFileName(matchedVendorName, invoiceNumber);

    const row = {
      pageNumber,
      vendorName: matchedVendorName,
      normalizedVendor,
      invoiceNumber,
      officialFileName,
      hasSavedTemplate: Boolean(existingTemplate),
      matchScore: vendorMatch.score || 0,
      previewUrl,
      detectedText: pageText,
    };

    results.push(row);

    if (!existingTemplate) {
      newVendorReviews.push({
        reviewId: makeReviewId(),
        fileName: originalFileName,
        pageNumber,
        suggestedVendorName:
          matchedVendorName === "UNKNOWN_VENDOR" ? "" : matchedVendorName,
        detectedText: pageText,
        previewUrl,
      });
    }
  }

  return {
    ok: true,
    fileName: originalFileName,
    totalPages,
    results,
    newVendorReviews,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    clientOrigin: CLIENT_ORIGIN,
    vendorListExists: fs.existsSync(vendorListPath),
    vendorTemplatePath,
    pdftoppmPath: process.env.PDFTOPPM_PATH || "pdftoppm",
  });
});

app.get("/api/vendor-templates", (_req, res) => {
  res.json({
    ok: true,
    templates: readVendorTemplates(),
  });
});

app.post("/api/vendor-template", (req, res) => {
  try {
    const {
      vendorName,
      vendorBox,
      invoiceBox,
      fileName = "",
      pageNumber = null,
    } = req.body || {};

    const cleanVendorName = String(vendorName || "").trim();

    if (!cleanVendorName) {
      return res.status(400).json({
        error: "vendorName is required.",
      });
    }

    if (
      !vendorBox ||
      typeof vendorBox !== "object" ||
      typeof vendorBox.x !== "number" ||
      typeof vendorBox.y !== "number" ||
      typeof vendorBox.width !== "number" ||
      typeof vendorBox.height !== "number"
    ) {
      return res.status(400).json({
        error: "vendorBox is required and must contain x, y, width, height.",
      });
    }

    if (
      !invoiceBox ||
      typeof invoiceBox !== "object" ||
      typeof invoiceBox.x !== "number" ||
      typeof invoiceBox.y !== "number" ||
      typeof invoiceBox.width !== "number" ||
      typeof invoiceBox.height !== "number"
    ) {
      return res.status(400).json({
        error: "invoiceBox is required and must contain x, y, width, height.",
      });
    }

    const normalizedVendor = normalizeVendorName(cleanVendorName);
    const templates = readVendorTemplates();

    templates[normalizedVendor] = {
      vendorName: cleanVendorName,
      normalizedVendor,
      vendorBox: {
        x: vendorBox.x,
        y: vendorBox.y,
        width: vendorBox.width,
        height: vendorBox.height,
      },
      invoiceBox: {
        x: invoiceBox.x,
        y: invoiceBox.y,
        width: invoiceBox.width,
        height: invoiceBox.height,
      },
      sampleFileName: String(fileName || ""),
      samplePageNumber:
        pageNumber === null || pageNumber === undefined ? null : Number(pageNumber),
      updatedAt: new Date().toISOString(),
    };

    writeVendorTemplates(templates);
    safeEnsureVendorInXlsx(cleanVendorName);

    return res.json({
      ok: true,
      normalizedVendor,
      template: templates[normalizedVendor],
    });
  } catch (err) {
    console.error("Failed saving vendor template:", err);
    return res.status(500).json({
      error: "Failed to save vendor template.",
    });
  }
});

app.post("/api/plan", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file?.buffer) {
      return res.status(400).json({
        error: "No file uploaded.",
      });
    }

    const response = await buildPlanResponseFromUpload(file);
    return res.json(response);
  } catch (err) {
    console.error("Plan route failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to plan invoice extraction.",
    });
  }
});

app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file?.buffer) {
      return res.status(400).json({
        error: "No file uploaded.",
      });
    }

    const response = await buildPlanResponseFromUpload(file);
    return res.json(response);
  } catch (err) {
    console.error("Process route failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to process invoice extraction.",
    });
  }
});

app.post("/api/download-page", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const pageNumber = Number(req.body?.pageNumber);
    const vendorName = String(req.body?.vendorName || "UNKNOWN_VENDOR");
    const invoiceNumber = String(req.body?.invoiceNumber || "UNKNOWN_INVOICE");

    if (!file?.buffer) {
      return res.status(400).json({
        error: "No file uploaded.",
      });
    }

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({
        error: "A valid pageNumber is required.",
      });
    }

    const sourcePdf = await PDFDocument.load(file.buffer);
    const totalPages = sourcePdf.getPageCount();

    if (pageNumber > totalPages) {
      return res.status(400).json({
        error: `pageNumber ${pageNumber} is out of range. PDF only has ${totalPages} page(s).`,
      });
    }

    const outputPdf = await PDFDocument.create();
    const [copiedPage] = await outputPdf.copyPages(sourcePdf, [pageNumber - 1]);
    outputPdf.addPage(copiedPage);

    const pdfBytes = await outputPdf.save();
    const officialFileName = makeOfficialFileName(vendorName, invoiceNumber);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${officialFileName}"`
    );

    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Download page route failed:", err);
    return res.status(500).json({
      error: err.message || "Failed to generate individual PDF download.",
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({
    error: err?.message || "Internal server error.",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${CLIENT_ORIGIN}`);
  console.log(`Vendor list path: ${vendorListPath}`);
  console.log(`Vendor template path: ${vendorTemplatePath}`);
  console.log(
    `Preview renderer path: ${process.env.PDFTOPPM_PATH || "pdftoppm"}`
  );
});