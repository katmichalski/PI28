/**
 * Extract per-page text using pdfjs-dist.
 * Works best on text PDFs or OCR'd PDFs.
 *
 * IMPORTANT: pdfjs-dist rejects Node Buffers even though they are Uint8Array subclasses.
 * Always pass a "plain" Uint8Array view.
 *
 * This file also exposes a "page object" extractor that includes a lightweight
 * header signature (top-of-page text) to help with cautious invoice splitting.
 */
import fs from "fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// In Node we don't use a worker
try {
  pdfjs.GlobalWorkerOptions.workerSrc = null;
} catch {}

function toPlainUint8Array(input) {
  if (!input) return new Uint8Array();
  // Node Buffer is a Uint8Array subclass, but pdfjs-dist explicitly rejects Buffer.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) {
    // Ensure it's not a Buffer, and avoid copying unless necessary.
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  // ArrayBuffer or other array-like
  try {
    return new Uint8Array(input);
  } catch {
    return new Uint8Array();
  }
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function getXY(item) {
  // pdfjs: transform = [a,b,c,d,e,f] where e=x, f=y
  const t = item?.transform;
  const x = Array.isArray(t) ? Number(t[4]) : 0;
  const y = Array.isArray(t) ? Number(t[5]) : 0;
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}


function getFontSize(item) {
  // Prefer pdfjs item.height (already in viewport units). Fallback to transform scale.
  const h = Number(item?.height);
  if (Number.isFinite(h) && h > 0) return h;
  const t = item?.transform;
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

function isBoldItem(item, styles) {
  // pdfjs provides a styles map keyed by item.fontName
  const st = (styles && item && item.fontName && styles[item.fontName]) ? styles[item.fontName] : null;

  const fam = String(st?.fontFamily || st?.fontFamily || "").toUpperCase();
  const w = st?.fontWeight;
  const wStr = String(w ?? "").toUpperCase();

  // Some PDFs encode weight in the family name (e.g. "Helvetica-Bold").
  if (/(BOLD|BLACK|HEAVY|SEMIBOLD|DEMI)/.test(fam)) return true;

  // Some styles expose a numeric weight
  const wNum = Number(w);
  if (Number.isFinite(wNum) && wNum >= 600) return true;

  // Or as a keyword
  if (wStr === "BOLD") return true;

  // Last resort: sometimes the raw fontName contains a hint (rare)
  const fn = String(item?.fontName || "").toUpperCase();
  if (fn.includes("BOLD")) return true;

  return false;
}


function buildHeaderSignature(items) {
  // Use top ~3 "lines" based on Y coordinate clustering.
  const enriched = items
    .filter((it) => it && typeof it.str === "string" && it.str.trim())
    .map((it) => {
      const { x, y } = getXY(it);
      return { str: it.str, x, y };
    });

  if (!enriched.length) return { headerText: "", headerSig: "" };

  const yMax = enriched.reduce((m, it) => Math.max(m, it.y), -Infinity);
  const top = enriched.filter((it) => it.y >= yMax - 90); // approx top band

  // Cluster into lines
  const bucket = new Map();
  const snap = (y) => Math.round(y / 6) * 6;
  for (const it of top) {
    const key = snap(it.y);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(it);
  }

  const lineYs = Array.from(bucket.keys()).sort((a, b) => b - a).slice(0, 3);
  const lines = lineYs.map((y) => {
    const arr = bucket.get(y).sort((a, b) => a.x - b.x);
    return normText(arr.map((x) => x.str).join(" "));
  });

  const headerText = normText(lines.join(" | "));
  const headerSig = headerText
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { headerText, headerSig };
}




// Detect likely line-items table header Y position based on common column labels.
// Returns the Y of the first matching header line when scanning from top -> bottom.
function findTableHeaderY(enriched) {
  if (!enriched?.length) return null;

  // Cluster into lines by y, then scan from top to bottom.
  const bucket = new Map();
  const snap = (y) => Math.round(y / 6) * 6;

  for (const it of enriched) {
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

  const countHits = (line) => {
    const n = normLine(line);
    if (!n) return { hits: 0, hasDesc: false };
    const hasDesc = /\b(DESCRIPTION|DESC)\b/.test(n);
    let hits = 0;
    for (const t of TOKENS) {
      // treat "UNIT PRICE" as phrase; others as word
      if (t.includes(" ")) {
        if (n.includes(t)) hits += 1;
      } else if (new RegExp(`\\b${t}\\b`).test(n)) {
        hits += 1;
      }
    }
    return { hits, hasDesc };
  };

  for (const y of ys) {
    const row = bucket.get(y).sort((a, b) => a.x - b.x);
    const text = normText(row.map((x) => x.str).join(" "));
    if (!text) continue;

    const { hits, hasDesc } = countHits(text);
    // Table header heuristic:
    // - If it contains DESCRIPTION/DESC, accept.
    // - Otherwise require at least 2 column-ish tokens (QTY, AMOUNT, PRICE, ITEM, etc.)
    if (hasDesc || hits >= 2) return y;
  }

  return null;
}

function buildAboveTableRegions(items, styles, viewport) {
  const width = Number(viewport?.width) || 0;
  const height = Number(viewport?.height) || 0;
  if (!width || !height) {
    return {
      aboveTableLeftText: "",
      aboveTableMiddleText: "",
      aboveTableRightText: "",
      aboveTableVendorText: "",
      aboveTableLeftBoldText: "",
      aboveTableMiddleBoldText: "",
      aboveTableRightBoldText: "",
      aboveTableVendorBoldText: ""
    };
  }

  const enriched = (items || [])
    .filter((it) => it && typeof it.str === "string" && it.str.trim())
    .map((it) => {
      const { x, y } = getXY(it);
      const fontSize = getFontSize(it);
      const bold = isBoldItem(it, styles);
      return { str: it.str, x, y, fontSize, bold };
    });

  if (!enriched.length) {
    return {
      aboveTableLeftText: "",
      aboveTableMiddleText: "",
      aboveTableRightText: "",
      aboveTableVendorText: "",
      aboveTableLeftBoldText: "",
      aboveTableMiddleBoldText: "",
      aboveTableRightBoldText: "",
      aboveTableVendorBoldText: ""
    };
  }

  const yMax = enriched.reduce((m, it) => Math.max(m, it.y), -Infinity);
  const tableHeaderY = findTableHeaderY(enriched);

  // If we detect a table header, use EVERYTHING above it as "header region".
  // Otherwise fall back to the top third.
  const headerItems = (tableHeaderY != null)
    ? enriched.filter((it) => it.y > (tableHeaderY + 6))
    : enriched.filter((it) => it.y >= (yMax - height / 3));

  const left = [];
  const mid = [];
  const right = [];

  for (const it of headerItems) {
    if (it.x >= width * (2 / 3)) right.push(it);
    else if (it.x >= width * (1 / 3)) mid.push(it);
    else left.push(it);
  }

  const linesWithMeta = (arr) => {
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
        const text = normText(row.map((x) => x.str).join(" "));
        const totalChars = row.reduce((n, x) => n + String(x.str || "").length, 0) || 1;
        const boldChars = row.reduce((n, x) => n + (x.bold ? String(x.str || "").length : 0), 0);
        const boldRatio = boldChars / totalChars;

        const sizeWeighted =
          row.reduce((s, x) => s + (Number(x.fontSize) || 0) * Math.max(1, String(x.str || "").length), 0) /
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

  const L = linesWithMeta(left);
  const M = linesWithMeta(mid);
  const R = linesWithMeta(right);
  const V = linesWithMeta(headerItems.filter((it) => it.x < width * (2 / 3)));

  return {
    aboveTableLeftText: L.text,
    aboveTableMiddleText: M.text,
    aboveTableRightText: R.text,
    aboveTableVendorText: V.text,
    aboveTableLeftBoldText: L.boldText,
    aboveTableMiddleBoldText: M.boldText,
    aboveTableRightBoldText: R.boldText,
    aboveTableVendorBoldText: V.boldText
  };
}

function buildTopThirdRegions(items, styles, viewport) {
  const width = Number(viewport?.width) || 0;
  const height = Number(viewport?.height) || 0;
  if (!width || !height) {
    return {
      topLeftText: "",
      topMiddleText: "",
      topRightText: "",
      topLeftBoldText: "",
      topMiddleBoldText: "",
      topRightBoldText: ""
    };
  }

  const enriched = (items || [])
    .filter((it) => it && typeof it.str === "string" && it.str.trim())
    .map((it) => {
      const { x, y } = getXY(it);
      const fontSize = getFontSize(it);
      const bold = isBoldItem(it, styles);
      return { str: it.str, x, y, fontSize, bold };
    });

  if (!enriched.length) {
    return {
      topLeftText: "",
      topMiddleText: "",
      topRightText: "",
      topLeftBoldText: "",
      topMiddleBoldText: "",
      topRightBoldText: ""
    };
  }

  // pdfjs y increases upward; yMax is top of page
  const yMax = enriched.reduce((m, it) => Math.max(m, it.y), -Infinity);
  const topBandMinY = yMax - height / 3; // top third
  const top = enriched.filter((it) => it.y >= topBandMinY);

  const left = [];
  const mid = [];
  const right = [];
  for (const it of top) {
    if (it.x >= width * (2 / 3)) right.push(it);
    else if (it.x >= width * (1 / 3)) mid.push(it);
    else left.push(it);
  }

  const linesWithMeta = (arr) => {
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
        const text = normText(row.map((x) => x.str).join(" "));
        const totalChars = row.reduce((n, x) => n + String(x.str || "").length, 0) || 1;
        const boldChars = row.reduce((n, x) => n + (x.bold ? String(x.str || "").length : 0), 0);
        const boldRatio = boldChars / totalChars;

        const sizeWeighted =
          row.reduce((s, x) => s + (Number(x.fontSize) || 0) * Math.max(1, String(x.str || "").length), 0) /
          row.reduce((s, x) => s + Math.max(1, String(x.str || "").length), 0);

        const avgSize = Number.isFinite(sizeWeighted) ? sizeWeighted : 0;

        return { y, text, boldRatio, avgSize };
      })
      .filter((l) => l && l.text);

    const text = lines.map((l) => l.text).join("\n").trim();

    // Pick "emphasis" lines: bold OR unusually large font.
    const sizes = lines.map((l) => l.avgSize).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;

    const scored = lines
      .map((l) => {
        const sizeScore = median > 0 ? l.avgSize / median : 0;
        // Weight bold more strongly than size; size is a helpful backup when fonts don't flag bold.
        const score = (l.boldRatio || 0) * 2.5 + sizeScore;
        return { ...l, score };
      })
      .sort((a, b) => (b.score - a.score) || (b.y - a.y));

    const chosen = scored
      .filter((l) => l.text && l.text.length >= 2)
      .slice(0, 3);

    const boldText = chosen.map((l) => l.text).join("\n").trim();

    return { text, boldText };
  };

  const L = linesWithMeta(left);
  const M = linesWithMeta(mid);
  const R = linesWithMeta(right);

  return {
    topLeftText: L.text,
    topMiddleText: M.text,
    topRightText: R.text,
    topLeftBoldText: L.boldText,
    topMiddleBoldText: M.boldText,
    topRightBoldText: R.boldText
  };
}
export async function extractPageTextsFromBuffer(buffer, onProgress) {
  const data = toPlainUint8Array(buffer);
  // In Node, disabling the worker avoids a common class of runtime failures
  // ("Setting up fake worker failed") across environments.
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const pages = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items
      .map((it) => (it && "str" in it ? it.str : ""))
      .filter(Boolean);

    const text = normText(strings.join(" "));
    pages.push(text);

    if (onProgress) onProgress({ current: p, total: pageCount });
  }

  return pages;
}

export async function extractPageTextsFromPath(filePath, onProgress) {
  const buf = fs.readFileSync(filePath);
  return extractPageTextsFromBuffer(buf, onProgress);
}

/**
 * Returns per-page objects: [{ text, headerText, headerSig }]
 */
export async function extractPageObjectsFromBuffer(buffer, onProgress) {
  const data = toPlainUint8Array(buffer);
  // In Node, disabling the worker avoids a common class of runtime failures
  // ("Setting up fake worker failed") across environments.
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const pages = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const items = content.items || [];

    const text = normText(
      items
        .map((it) => (it && typeof it.str === "string" ? it.str : ""))
        .filter(Boolean)
        .join(" ")
    );

    const { headerText, headerSig } = buildHeaderSignature(items);
    const { topLeftText, topMiddleText, topRightText, topLeftBoldText, topMiddleBoldText, topRightBoldText } = buildTopThirdRegions(items, content.styles || {}, viewport);
    const { aboveTableLeftText, aboveTableMiddleText, aboveTableRightText, aboveTableVendorText, aboveTableLeftBoldText, aboveTableMiddleBoldText, aboveTableRightBoldText, aboveTableVendorBoldText } = buildAboveTableRegions(items, content.styles || {}, viewport);
    pages.push({ text, headerText, headerSig, topLeftText, topMiddleText, topRightText, topLeftBoldText, topMiddleBoldText, topRightBoldText, aboveTableLeftText, aboveTableMiddleText, aboveTableRightText, aboveTableVendorText, aboveTableLeftBoldText, aboveTableMiddleBoldText, aboveTableRightBoldText, aboveTableVendorBoldText });

    if (onProgress) onProgress({ current: p, total: pageCount });
  }

  return pages;
}

export async function extractPageObjectsFromPath(filePath, onProgress) {
  const buf = fs.readFileSync(filePath);
  return extractPageObjectsFromBuffer(buf, onProgress);
}

/**
 * Quick text stats to determine whether a PDF is already searchable.
 *
 * We intentionally only sample a handful of pages to keep this fast.
 * Returns:
 * {
 *   numPages,
 *   samplePages,
 *   pagesWithText,
 *   avgChars,
 *   perPageChars
 * }
 */
export async function quickPdfTextStatsFromPath(filePath, opts = {}) {
  const maxPages = Math.max(1, Number(opts.maxPages || process.env.PDF_TYPE_SAMPLE_PAGES || 3));
  const minCharsPerPage = Math.max(1, Number(opts.minCharsPerPage || 20));

  const buf = fs.readFileSync(filePath);
  const data = toPlainUint8Array(buf);
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const doc = await loadingTask.promise;

  const numPages = doc.numPages || 0;
  if (!numPages) {
    return { numPages: 0, samplePages: 0, pagesWithText: 0, avgChars: 0, perPageChars: [] };
  }

  // Sample pages spread across the document: first, middle, last, then fill in.
  const sampleSet = new Set();
  sampleSet.add(1);
  sampleSet.add(Math.max(1, Math.ceil(numPages / 2)));
  sampleSet.add(numPages);
  let i = 2;
  while (sampleSet.size < Math.min(maxPages, numPages)) {
    sampleSet.add(Math.min(numPages, i));
    i++;
  }
  const samplePages = Array.from(sampleSet).sort((a, b) => a - b);

  const perPageChars = [];
  let pagesWithText = 0;
  let sumChars = 0;

  for (const p of samplePages) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items || [];
    const raw = items
      .map((it) => (it && typeof it.str === "string" ? it.str : ""))
      .join(" ");

    // Count only visible-ish chars (letters/digits) to avoid being fooled by tiny artifacts.
    const chars = String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/[^A-Za-z0-9]+/g, "")
      .length;

    perPageChars.push(chars);
    sumChars += chars;
    if (chars >= minCharsPerPage) pagesWithText++;
  }

  const avgChars = perPageChars.length ? sumChars / perPageChars.length : 0;
  return {
    numPages,
    samplePages: samplePages.length,
    pagesWithText,
    avgChars,
    perPageChars
  };
}
