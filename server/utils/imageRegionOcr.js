import fs from "fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import Jimp from "jimp";
import { recognizePng, terminateWorker } from "./tesseractShared.js";
import { ocrLogoTextFromPngBuffer } from "./logoOcr.js";

/**
 * Image-focused OCR fallback for scanned PDFs.
 *
 * Also includes a fast path for PDFs that already have a text layer (e.g. OCRmyPDF output):
 * we first try to read the PDF text content in the top portion of the page and only
 * fall back to rendering + Tesseract if there isn't enough text.
 *
 * Env vars:
 * - IMAGE_OCR_DPI : default 130 (higher = better OCR, slower)
 * - IMAGE_OCR_TOP_FRACTION : default 0.28 (how much of the top of the page to OCR)
 * - IMAGE_OCR_MAX_DIM : default 1600 (downscale large crops before OCR)
 * - IMAGE_OCR_TIMEOUT_MS : default 120000 (per recognize)
 * - PDF_RENDER_TIMEOUT_MS : default 60000
 * - PDF_RENDER_MAX_PIXELS : default 3500000 (cap rendered page pixels to avoid huge bitmaps)
 */

const IMAGE_OCR_DPI = Number(process.env.IMAGE_OCR_DPI || 130);
const SCALE_BASE = IMAGE_OCR_DPI / 72; // PDF points are 72 DPI

// Default enlarged to better capture invoice number blocks that often sit below the first header band.
// You can override via IMAGE_OCR_TOP_FRACTION in server/.env.
const IMAGE_OCR_TOP_FRACTION = Number(process.env.IMAGE_OCR_TOP_FRACTION || 0.40);
const IMAGE_OCR_MAX_DIM = Number(process.env.IMAGE_OCR_MAX_DIM || 1600);

// When vendor can't be found in the header, we optionally OCR the remainder of the page
// to look for stable mailing addresses (used by address-to-vendor overrides).
// This is only executed as a last-resort fallback.
const IMAGE_OCR_ADDRESS_START_FRACTION = Number(process.env.IMAGE_OCR_ADDRESS_START_FRACTION || 0.22);

// Timeouts (ms) to prevent hung renders/OCR from stalling the whole app
const PDF_RENDER_TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 60000);
const IMAGE_OCR_TIMEOUT_MS = Number(process.env.IMAGE_OCR_TIMEOUT_MS || 120000);

// Cap render size so very large pages/scans don't explode CPU/memory
const PDF_RENDER_MAX_PIXELS = Number(process.env.PDF_RENDER_MAX_PIXELS || 3500000);

// When vendor text is printed in very light grey, normal OCR can miss it.
// Enable a targeted "light-grey" OCR pass for vendor header hints.
// Set IMAGE_OCR_LIGHTGREY_VENDOR=0 to disable.
const IMAGE_OCR_LIGHTGREY_VENDOR = String(process.env.IMAGE_OCR_LIGHTGREY_VENDOR ?? "1") !== "0";

function withTimeout(promise, ms, label, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(async () => {
      try {
        await onTimeout?.();
      } catch {}
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// In Node we don't use a worker file for pdfjs
try {
  pdfjs.GlobalWorkerOptions.workerSrc = null;
} catch {}

function toPlainUint8Array(input) {
  if (!input) return new Uint8Array();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  try {
    return new Uint8Array(input);
  } catch {
    return new Uint8Array();
  }
}

// Cache parsed PDFs by path to avoid reparsing repeatedly during /api/plan
const pdfCache = new Map(); // pdfPath -> { mtimeMs, docPromise }

async function loadPdfDoc(pdfPath) {
  const stat = fs.statSync(pdfPath);
  const mtimeMs = stat.mtimeMs;

  const cached = pdfCache.get(pdfPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.docPromise;

  const bytes = fs.readFileSync(pdfPath);
  const data = toPlainUint8Array(bytes);
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const docPromise = loadingTask.promise;

  pdfCache.set(pdfPath, { mtimeMs, docPromise });
  return docPromise;
}

/**
 * Try to pull text from the PDF's existing text layer in the TOP portion of the page.
 * Returns region strings similar to OCR regions.
 */

function _getFontSizeFromItem(it) {
  const h = Number(it?.height);
  if (Number.isFinite(h) && h > 0) return h;
  const t = it?.transform;
  if (Array.isArray(t) && t.length >= 4) {
    const a = Number(t[0] || 0);
    const b = Number(t[1] || 0);
    const c = Number(t[2] || 0);
    const d = Number(t[3] || 0);
    const sx = Math.hypot(a, b);
    const sy = Math.hypot(c, d);
    const s = Math.max(sx, sy);
    return Number.isFinite(s) && s > 0 ? s : 0;
  }
  return 0;
}

function _isBoldPdfItem(it, styles) {
  const st = (styles && it && it.fontName && styles[it.fontName]) ? styles[it.fontName] : null;
  const fam = String(st?.fontFamily || "").toUpperCase();
  const w = st?.fontWeight;
  const wStr = String(w ?? "").toUpperCase();

  if (/(BOLD|BLACK|HEAVY|SEMIBOLD|DEMI)/.test(fam)) return true;

  const wNum = Number(w);
  if (Number.isFinite(wNum) && wNum >= 600) return true;
  if (wStr === "BOLD") return true;

  const fn = String(it?.fontName || "").toUpperCase();
  if (fn.includes("BOLD")) return true;

  return false;
}


// Detect the first likely line-items table header (column labels) Y position in a text-layer PDF.
// Scans lines from top -> bottom and returns the Y coordinate of the first matching line.
function findTableHeaderYFromItems(items) {
  if (!items?.length) return null;

  const bucket = new Map();
  const snap = (y) => Math.round(y / 6) * 6;

  for (const it of items) {
    const key = snap(it.y);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(it);
  }

  const ys = Array.from(bucket.keys()).sort((a, b) => b - a);

  const TOKENS = [
    "DESCRIPTION","DESC","QTY","QUANTITY","UNIT","UNIT PRICE","PRICE","RATE","AMOUNT",
    "ITEM","SKU","PRODUCT","PART","EXT","EXTENDED","HOURS","HRS","SERVICE","CHARGE","TAX"
  ];

  const normLine = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/_/g, " ")
      .replace(/[^A-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  for (const y of ys) {
    const row = bucket.get(y).sort((a, b) => a.x - b.x);
    const text = row.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim();
    const n = normLine(text);
    if (!n) continue;

    const hasDesc = /\b(DESCRIPTION|DESC)\b/.test(n);
    let hits = 0;
    for (const t of TOKENS) {
      if (t.includes(" ")) {
        if (n.includes(t)) hits += 1;
      } else if (new RegExp(`\\b${t}\\b`).test(n)) {
        hits += 1;
      }
    }
    if (hasDesc || hits >= 2) return y;
  }

  return null;
}

export async function getTopThirdTextRegions({ pdfPath, pageNumber }) {
  try {
    const doc = await withTimeout(loadPdfDoc(pdfPath), PDF_RENDER_TIMEOUT_MS, "pdfjs load");
    const page = await withTimeout(doc.getPage(pageNumber), PDF_RENDER_TIMEOUT_MS, "pdfjs getPage");
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width || 1;
    const height = viewport.height || 1;

    const topY = height * (1 - clamp01(IMAGE_OCR_TOP_FRACTION));

    const textContent = await withTimeout(page.getTextContent(), PDF_RENDER_TIMEOUT_MS, "pdfjs text");
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const styles = textContent?.styles || {};

    const allItems = [];
for (const it of items) {
  const str = String(it?.str || "").trim();
  const tr = it?.transform;
  if (!str) continue;
  if (!Array.isArray(tr) || tr.length < 6) continue;
  const x = Number(tr[4] || 0);
  const y = Number(tr[5] || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
  allItems.push({ str, x, y, fontName: it.fontName, height: it.height, transform: it.transform });
}

const topItems = allItems.filter((it) => it.y >= topY);

// NEW: "Above chart/table" region — detect the first column-header row and take everything above it.
const tableHeaderY = findTableHeaderYFromItems(allItems);
const aboveTableMinY = (tableHeaderY != null) ? (tableHeaderY + 6) : topY;
const aboveTableItems = allItems.filter((it) => it.y >= aboveTableMinY);

if (!topItems.length && !aboveTableItems.length) {

      return {
        hasText: false,
        topLeftText: "",
        topMiddleText: "",
        topRightText: "",
        topVendorText: "",
        fullTopText: "",
        topFullText: "",
        topLeftBoldText: "",
        topMiddleBoldText: "",
        topRightBoldText: "",
        topVendorBoldText: "",
        aboveTableLeftText: "",
        aboveTableMiddleText: "",
        aboveTableRightText: "",
        aboveTableVendorText: "",
        aboveTableFullText: "",
        aboveTableLeftBoldText: "",
        aboveTableMiddleBoldText: "",
        aboveTableRightBoldText: "",
        aboveTableVendorBoldText: "",
        aboveTableFullBoldText: ""
      };
    }

    // Preserve LINE breaks by clustering items by y-coordinate into lines.
    // This is important because vendor name is usually a line ABOVE the street/city/state lines.
    
const joinAsLines = (arr) => {
  if (!arr?.length) return { text: "", boldText: "" };

  const bucket = new Map();
  const snap = (y) => Math.round(y / 6) * 6;
  for (const it of arr) {
    const key = snap(it.y);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(it);
  }

  const ys = Array.from(bucket.keys()).sort((a, b) => b - a);

  const lines = ys
    .map((y) => {
      const row = bucket.get(y).sort((a, b) => a.x - b.x);
      const text = row.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim();
      const totalChars = row.reduce((n, x) => n + String(x.str || "").length, 0) || 1;
      const boldChars = row.reduce(
        (n, x) => n + (_isBoldPdfItem(x, styles) ? String(x.str || "").length : 0),
        0
      );
      const boldRatio = boldChars / totalChars;

      const sizeWeighted =
        row.reduce((s, x) => s + _getFontSizeFromItem(x) * Math.max(1, String(x.str || "").length), 0) /
        row.reduce((s, x) => s + Math.max(1, String(x.str || "").length), 0);

      const avgSize = Number.isFinite(sizeWeighted) ? sizeWeighted : 0;

      return { y, text, boldRatio, avgSize };
    })
    .filter((l) => l && l.text);

  const text = lines.map((l) => l.text).join("\n").trim();

  const sizes = lines.map((l) => l.avgSize).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;

  const scored = lines
    .map((l) => {
      const sizeScore = median > 0 ? l.avgSize / median : 0;
      const score = (l.boldRatio || 0) * 2.5 + sizeScore;
      return { ...l, score };
    })
    .sort((a, b) => (b.score - a.score) || (b.y - a.y));

  const chosen = scored.filter((l) => l.text && l.text.length >= 2).slice(0, 3);
  const boldText = chosen.map((l) => l.text).join("\n").trim();

  return { text, boldText };
};

    // Full-page reading-order text (useful for address-based vendor overrides).
    const PAGE = joinAsLines(allItems);
    const fullPageText = PAGE.text;

    const left = [];
    const middle = [];
    const right = [];

    for (const it of topItems) {
      if (it.x < width / 3) left.push(it);
      else if (it.x < (2 * width) / 3) middle.push(it);
      else right.push(it);
    }

    const L = joinAsLines(left);
    const topLeftText = L.text;
    const topLeftBoldText = L.boldText;
    const M = joinAsLines(middle);
    const topMiddleText = M.text;
    const topMiddleBoldText = M.boldText;
    const R = joinAsLines(right);
    const topRightText = R.text;
    const topRightBoldText = R.boldText;
    const F = joinAsLines(topItems);
    const fullTopText = F.text;
    const topFullText = fullTopText;
    const V = joinAsLines(topItems.filter((it) => it.x < (2 * width) / 3));
    const topVendorText = V.text;

// Above-table (chart) regions
const aLeft = [];
const aMiddle = [];
const aRight = [];

for (const it of aboveTableItems) {
  if (it.x < width / 3) aLeft.push(it);
  else if (it.x < (2 * width) / 3) aMiddle.push(it);
  else aRight.push(it);
}

const AL = joinAsLines(aLeft);
const aboveTableLeftText = AL.text;
const aboveTableLeftBoldText = AL.boldText;
const AM = joinAsLines(aMiddle);
const aboveTableMiddleText = AM.text;
const aboveTableMiddleBoldText = AM.boldText;
const AR = joinAsLines(aRight);
const aboveTableRightText = AR.text;
const aboveTableRightBoldText = AR.boldText;
const AV = joinAsLines(aboveTableItems.filter((it) => it.x < (2 * width) / 3));
const aboveTableVendorText = AV.text;
const aboveTableVendorBoldText = AV.boldText;

    // Full-width reading-order text above the table header.
    const AF = joinAsLines(aboveTableItems);
    const aboveTableFullText = AF.text;
    const aboveTableFullBoldText = AF.boldText;

    const topVendorBoldText = V.boldText;

    const hasText = ((aboveTableVendorText || fullTopText) || "").length >= 10;

    return { hasText, topLeftText, topMiddleText, topRightText, topVendorText, fullTopText, topFullText, topLeftBoldText, topMiddleBoldText, topRightBoldText, topVendorBoldText,
      aboveTableLeftText,
      aboveTableMiddleText,
      aboveTableRightText,
      aboveTableVendorText,
      aboveTableFullText,
      aboveTableLeftBoldText,
      aboveTableMiddleBoldText,
      aboveTableRightBoldText,
      aboveTableVendorBoldText,
      aboveTableFullBoldText,
      fullPageText
    };
  } catch {
    return {
      hasText: false,
      topLeftText: "",
      topMiddleText: "",
      topRightText: "",
      topVendorText: "",
      fullTopText: "",
      topFullText: "",
      topLeftBoldText: "",
      topMiddleBoldText: "",
      topRightBoldText: "",
      topVendorBoldText: "",
        aboveTableLeftText: "",
        aboveTableMiddleText: "",
        aboveTableRightText: "",
        aboveTableVendorText: "",
        aboveTableFullText: "",
        aboveTableLeftBoldText: "",
        aboveTableMiddleBoldText: "",
        aboveTableRightBoldText: "",
        aboveTableVendorBoldText: "",
        aboveTableFullBoldText: "",
        fullPageText: ""
    };
  }
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.28;
  if (n < 0.1) return 0.1;
  if (n > 0.6) return 0.6;
  return n;
}

async function renderPageToPngBuffer(pdfPath, pageNumber) {
  const doc = await withTimeout(loadPdfDoc(pdfPath), PDF_RENDER_TIMEOUT_MS, "pdfjs load");
  const page = await withTimeout(doc.getPage(pageNumber), PDF_RENDER_TIMEOUT_MS, "pdfjs getPage");

  // Start from target DPI but cap total pixels.
  const viewport1 = page.getViewport({ scale: 1 });
  const baseW = Math.max(1, viewport1.width || 1);
  const baseH = Math.max(1, viewport1.height || 1);

  let scale = SCALE_BASE;
  const pixels = (baseW * scale) * (baseH * scale);
  if (PDF_RENDER_MAX_PIXELS > 0 && pixels > PDF_RENDER_MAX_PIXELS) {
    const factor = Math.sqrt(PDF_RENDER_MAX_PIXELS / pixels);
    scale = scale * factor;
  }

  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

  await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, PDF_RENDER_TIMEOUT_MS, "pdfjs render");
  return canvas.toBuffer("image/png");
}

async function recognizeWithPsm(pngBuffer, psm = "6") {
  // If OCR times out, reset the shared worker so the next job doesn't get stuck.
  const r = await withTimeout(
    recognizePng(pngBuffer, { psm }),
    IMAGE_OCR_TIMEOUT_MS,
    "tesseract recognize",
    async () => terminateWorker()
  );
  return r.text;
}

function downscaleInPlace(jimpImg, maxDim) {
  if (!maxDim || maxDim <= 0) return jimpImg;
  const w = jimpImg.bitmap.width;
  const h = jimpImg.bitmap.height;
  const m = Math.max(w, h);
  if (m <= maxDim) return jimpImg;
  if (w >= h) return jimpImg.resize(maxDim, Jimp.AUTO);
  return jimpImg.resize(Jimp.AUTO, maxDim);
}

async function cropPng(img, x, y, w, h) {
  const c = img.clone().crop(x, y, w, h);
  // Light preprocessing helps both speed (less entropy) and accuracy.
  c.greyscale();
  c.contrast(0.2);
  downscaleInPlace(c, IMAGE_OCR_MAX_DIM);
  return c.getBufferAsync(Jimp.MIME_PNG);
}

// Heavier preprocessing tuned to reveal faint/light-grey header text.
// This is only used as a fallback hint for vendor detection.
async function cropPngLightGreyText(img, x, y, w, h) {
  const c = img.clone().crop(x, y, w, h);
  try {
    c.greyscale();
    c.normalize();
    c.contrast(0.55);
    c.brightness(-0.12);

    // Nudge very light greys darker while keeping near-white paper background white.
    // Conservative band so we don't introduce heavy background noise on off-white scans.
    c.scan(0, 0, c.bitmap.width, c.bitmap.height, function (_x, _y, idx) {
      const v = this.bitmap.data[idx] || 0; // grayscale => r=g=b
      let nv = v;
      if (v >= 245) nv = 255; // paper
      else if (v >= 210) nv = Math.max(0, v - 55); // faint text
      this.bitmap.data[idx] = nv;
      this.bitmap.data[idx + 1] = nv;
      this.bitmap.data[idx + 2] = nv;
    });
  } catch {}

  downscaleInPlace(c, IMAGE_OCR_MAX_DIM);
  return c.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Fallback helper: OCR only the vendor-relevant top-left and/or wide vendor band
 * using light-grey-enhancing preprocessing.
 */
export async function ocrTopThirdVendorHintsLightGrey({
  pdfPath,
  pageNumber,
  needLeft = true,
  needVendor = true,
  needFull = false
}) {
  if (!IMAGE_OCR_LIGHTGREY_VENDOR) {
    return { topLeftText: "", topVendorText: "" };
  }

  const fullPng = await renderPageToPngBuffer(pdfPath, pageNumber);
  const img = await Jimp.read(fullPng);

  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const topH = Math.max(1, Math.floor(h * clamp01(IMAGE_OCR_TOP_FRACTION)));
  const thirdW = Math.max(1, Math.floor(w / 3));

  const leftBuf = needLeft ? await cropPngLightGreyText(img, 0, 0, thirdW, topH) : null;
  const vendorBuf = needVendor ? await cropPngLightGreyText(img, 0, 0, Math.max(1, Math.floor(w * (2 / 3))), topH) : null;
  const fullBuf = needFull ? await cropPngLightGreyText(img, 0, 0, w, topH) : null;

  const topLeftText = leftBuf ? await recognizeWithPsm(leftBuf, "6") : "";
  const topVendorText = vendorBuf ? await recognizeWithPsm(vendorBuf, "6") : "";
  const topFullText = fullBuf ? await recognizeWithPsm(fullBuf, "6") : "";
  return { topLeftText, topVendorText, topFullText };
}

/**
 * LAST-RESORT helper: OCR most of the page BELOW the header.
 * Used only when vendor is UNKNOWN and we want to trigger address-to-vendor overrides.
 */
export async function ocrPdfPageAddressHints({ pdfPath, pageNumber }) {
  const fullPng = await renderPageToPngBuffer(pdfPath, pageNumber);
  const img = await Jimp.read(fullPng);

  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const frac = Math.max(0.12, Math.min(0.65, Number(IMAGE_OCR_ADDRESS_START_FRACTION) || 0.22));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(h * frac)));
  const hh = Math.max(1, h - y0);

  const buf = await cropPng(img, 0, y0, w, hh);
  const text = await recognizeWithPsm(buf, "6");
  return text || "";
}

/**
 * Region OCR on the top part of the page.
 *
 * Options let callers OCR only the regions they need (huge speed win).
 */
export async function ocrTopThirdRegions({
  pdfPath,
  pageNumber,
  needLeft = true,
  needMiddle = true,
  needRight = true,
  needVendor = true,
  needFull = false
}) {
  const fullPng = await renderPageToPngBuffer(pdfPath, pageNumber);
  const img = await Jimp.read(fullPng);

  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const topH = Math.max(1, Math.floor(h * clamp01(IMAGE_OCR_TOP_FRACTION)));
  const thirdW = Math.max(1, Math.floor(w / 3));

  // Crop to buffers (no temp files) + downscale for performance
  const leftBuf = needLeft ? await cropPng(img, 0, 0, thirdW, topH) : null;
  const midBuf = needMiddle ? await cropPng(img, thirdW, 0, thirdW, topH) : null;
  const rightBuf = needRight ? await cropPng(img, thirdW * 2, 0, Math.max(1, w - thirdW * 2), topH) : null;
  const vendorBuf = needVendor ? await cropPng(img, 0, 0, Math.max(1, Math.floor(w * (2 / 3))), topH) : null;
  const fullBuf = needFull ? await cropPng(img, 0, 0, w, topH) : null;

  // OCR sequentially (stable)
  const topLeftText = leftBuf ? await recognizeWithPsm(leftBuf, "6") : "";
  const topMiddleText = midBuf ? await recognizeWithPsm(midBuf, "6") : "";

  let topRightText = "";
  if (rightBuf) {
    const right = await withTimeout(
      recognizePng(rightBuf, { psm: "7", whitelist: "0123456789-/" }),
      IMAGE_OCR_TIMEOUT_MS,
      "tesseract recognize",
      async () => terminateWorker()
    );
    topRightText = right.text;
  }

  const topVendorText = vendorBuf ? await recognizeWithPsm(vendorBuf, "6") : "";
  const topFullText = fullBuf ? await recognizeWithPsm(fullBuf, "6") : "";

  return { topLeftText, topMiddleText, topRightText, topVendorText, topFullText };
}

/**
 * LAST RESORT vendor helper: OCR likely logo regions from a PDF page.
 * Only used when the vendor would otherwise be UNKNOWN_VENDOR.
 */
export async function ocrLogoTextFromPdfPage({ pdfPath, pageNumber }) {
  const fullPng = await renderPageToPngBuffer(pdfPath, pageNumber);
  return ocrLogoTextFromPngBuffer(fullPng);
}

// Optional: allow graceful shutdown if you want to terminate the worker
export async function shutdownOcrWorker() {
  // Kept for backward compatibility.
  // The shared worker lives in utils/tesseractShared.js.
  return;
}
