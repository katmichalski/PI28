import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || "pdftoppm";
const TESSERACT_BIN = process.env.TESSERACT_BIN || "tesseract";

async function run(bin, args) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    return stdout;
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err);
    throw new Error(`${bin} failed: ${detail}`);
  }
}

async function loadVendorNamesFromXlsx(xlsxPath) {
  if (!xlsxPath) return [];
  try {
    const xlsx = await import("xlsx");
    const workbook = xlsx.readFile(xlsxPath);
    const firstSheet = workbook.SheetNames?.[0];
    const sheet = firstSheet ? workbook.Sheets[firstSheet] : null;
    const rows = sheet ? xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" }) : [];
    return rows
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);
  } catch {
    return [];
  }
}

function normalizeVendorText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|INCORPORATED|INC|LLC|LTD|LIMITED|CO|COMPANY|CORP|CORPORATION|SERVICES|SERVICE|GROUP|PA|PC|PLLC)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildVendorAliases(name) {
  const raw = String(name || "").trim();
  const aliases = new Set([raw, normalizeVendorText(raw)]);

  if (/\bCLAS\b|\bCLASINFO\b|CLAS INFORMATION/i.test(raw)) {
    aliases.add("CLAS");
    aliases.add("CLASINFO");
    aliases.add("WWW CLASINFO");
    aliases.add("CLAS INFORMATION SERVICES");
  }

  if (/RASI_NCSI/i.test(raw)) aliases.add("RASI NCSI");
  if (/DOC-U-SEARCH/i.test(raw)) aliases.add(raw.replace(/-/g, " "));

  return Array.from(aliases).map(normalizeVendorText).filter(Boolean);
}

function buildVendorCatalog(vendorNames) {
  return (Array.isArray(vendorNames) ? vendorNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .map((name) => ({
      canonical: name,
      aliases: buildVendorAliases(name)
    }));
}

async function renderPdfPageToPng(pdfPath, pageNumber) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "invoice-ocr-"));
  const prefix = path.join(dir, "page");

  await run(PDFTOPPM_BIN, [
    "-f", String(pageNumber),
    "-l", String(pageNumber),
    "-png",
    "-r", "220",
    pdfPath,
    prefix
  ]);

  return {
    dir,
    imagePath: `${prefix}-${pageNumber}.png`
  };
}

function parseTsv(tsv) {
  const lines = String(tsv || "").split(/\r?\n/).filter(Boolean);
  const header = lines.shift();
  if (!header) return [];

  const cols = header.split("\t");
  return lines
    .map((line) => {
      const parts = line.split("\t");
      const row = {};
      cols.forEach((col, index) => {
        row[col] = parts[index] ?? "";
      });
      return {
        level: Number(row.level || 0),
        page_num: Number(row.page_num || 0),
        block_num: Number(row.block_num || 0),
        par_num: Number(row.par_num || 0),
        line_num: Number(row.line_num || 0),
        word_num: Number(row.word_num || 0),
        left: Number(row.left || 0),
        top: Number(row.top || 0),
        width: Number(row.width || 0),
        height: Number(row.height || 0),
        conf: Number(row.conf || -1),
        text: String(row.text || "").trim()
      };
    })
    .filter((row) => row.level === 5 && row.text);
}

function groupWordsIntoLines(words) {
  const buckets = new Map();

  for (const word of words) {
    const key = `${word.page_num}:${word.block_num}:${word.par_num}:${word.line_num}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(word);
  }

  return Array.from(buckets.values())
    .map((lineWords) => {
      const sorted = lineWords.sort((a, b) => a.left - b.left);
      const left = Math.min(...sorted.map((w) => w.left));
      const top = Math.min(...sorted.map((w) => w.top));
      const right = Math.max(...sorted.map((w) => w.left + w.width));
      const bottom = Math.max(...sorted.map((w) => w.top + w.height));
      return {
        text: sorted.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim(),
        words: sorted,
        left,
        top,
        width: right - left,
        height: bottom - top,
        right,
        bottom
      };
    })
    .filter((line) => line.text)
    .sort((a, b) => (a.top - b.top) || (a.left - b.left));
}

async function ocrPage(imagePath) {
  const [rawText, rawTsv] = await Promise.all([
    run(TESSERACT_BIN, [imagePath, "stdout", "--psm", "6"]),
    run(TESSERACT_BIN, [imagePath, "stdout", "--psm", "6", "tsv"])
  ]);

  const words = parseTsv(rawTsv);
  const lines = groupWordsIntoLines(words);
  const pageWidth = Math.max(1, ...words.map((w) => w.left + w.width));
  const pageHeight = Math.max(1, ...words.map((w) => w.top + w.height));

  return {
    text: String(rawText || "").replace(/\r/g, "").trim(),
    words,
    lines,
    pageWidth,
    pageHeight
  };
}

function isNoiseLine(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (/^(date|due date|terms|bill to|ship to|debtor|account|attention|phone|tel|fax|email|www|http|qty|item|description|rate|county|amount|balance due|total)\b/i.test(s)) return true;
  if (/[@]|\b(road|rd\.?|street|st\.?|avenue|ave\.?|suite|ste\.?|box|po box)\b/i.test(s)) return true;
  if (/^\d+[\d\s\-\/.,]*$/.test(s)) return true;
  return false;
}

function scoreVendorCandidateText(candidate, catalog) {
  const normalized = normalizeVendorText(candidate);
  if (!normalized) return null;

  let best = null;
  for (const entry of catalog) {
    let score = 0;

    for (const alias of entry.aliases) {
      if (normalized === alias) score = Math.max(score, 1000 + alias.length);
      else if (normalized.includes(alias)) score = Math.max(score, 800 + alias.length);
      else {
        const cTokens = new Set(normalized.split(/\s+/));
        const aTokens = alias.split(/\s+/);
        const overlap = aTokens.filter((t) => cTokens.has(t)).length;
        const ratio = overlap / Math.max(1, aTokens.length);
        if (overlap >= 2 && ratio >= 0.66) score = Math.max(score, Math.round(ratio * 100));
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { vendorName: entry.canonical, score, matchedFrom: candidate };
    }
  }

  return best;
}

function extractVendorName(lines, pageWidth, pageHeight, vendorCatalog) {
  const topLines = lines.filter((line) => line.top <= pageHeight * 0.18);
  const vendorZone = topLines.filter((line) => line.left <= pageWidth * 0.75);

  let bestMatch = null;
  const windows = [];
  for (let i = 0; i < vendorZone.length; i += 1) {
    windows.push({ text: vendorZone[i].text, top: vendorZone[i].top });
    if (vendorZone[i + 1]) {
      windows.push({
        text: `${vendorZone[i].text} ${vendorZone[i + 1].text}`,
        top: vendorZone[i].top
      });
    }
  }

  for (const candidate of windows) {
    const matched = scoreVendorCandidateText(candidate.text, vendorCatalog);
    if (
      matched &&
      (
        !bestMatch ||
        matched.score > bestMatch.score ||
        (matched.score === bestMatch.score && candidate.top < bestMatch.top)
      )
    ) {
      bestMatch = { ...matched, top: candidate.top };
    }
  }

  if (bestMatch) {
    return {
      vendorName: bestMatch.vendorName,
      score: bestMatch.score,
      matchedFrom: bestMatch.matchedFrom
    };
  }

  const fallback = vendorZone.find((line) => {
    const cleaned = line.text.replace(/\bINVOICE\b.*$/i, "").trim();
    return cleaned && !isNoiseLine(cleaned);
  });

  if (fallback) {
    const cleaned = fallback.text.replace(/\bINVOICE\b.*$/i, "").trim();
    return {
      vendorName: cleaned || "UNKNOWN_VENDOR",
      score: 10,
      matchedFrom: fallback.text
    };
  }

  return { vendorName: "UNKNOWN_VENDOR", score: 0, matchedFrom: "" };
}

function cleanInvoiceNumber(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function pickBestHashNumber(text) {
  const hits = [...String(text || "").matchAll(/#\s*([A-Z0-9-]{4,})/gi)]
    .map((m) => cleanInvoiceNumber(m[1]));
  return hits.length ? hits[hits.length - 1] : "";
}

function extractInvoiceNumber(lines, pageWidth, pageHeight) {
  const topLines = lines.filter((line) => line.top <= pageHeight * 0.4);
  const rightOrLabeledLines = topLines.filter(
    (line) =>
      line.left >= pageWidth * 0.45 ||
      /invoice|inv\b|ref\b|project\b|order\/item/i.test(line.text)
  );

  const labelRegex =
    /\b(?:invoice(?:\s*(?:number|no\.?|num|#))?|inv\.?|ref\.?|project\s*#?|order\/item\s*#?)\b[^A-Z0-9\n\r]{0,20}[#:\s-]*([A-Z0-9-]{3,})\b/i;

  for (let i = 0; i < rightOrLabeledLines.length; i += 1) {
    const prev = rightOrLabeledLines[i - 1]?.text || "";
    const curr = rightOrLabeledLines[i].text || "";
    const next = rightOrLabeledLines[i + 1]?.text || "";
    const next2 = rightOrLabeledLines[i + 2]?.text || "";
    const windows = [curr, `${curr} ${next}`, `${prev} ${curr}`, `${curr} ${next} ${next2}`];

    for (const sample of windows) {
      const direct = sample.match(labelRegex);
      if (direct?.[1] && !/^PAG?E?$/i.test(direct[1])) {
        return cleanInvoiceNumber(direct[1]);
      }

      if (/invoice|inv\b/i.test(curr)) {
        const hashed = pickBestHashNumber(sample);
        if (hashed) return hashed;
      }
    }
  }

  const invoiceLines = topLines.filter((line) => /invoice|inv\b/i.test(line.text));
  for (const line of invoiceLines) {
    const idx = topLines.findIndex((item) => item === line);
    const window = [
      topLines[idx - 1]?.text || "",
      topLines[idx]?.text || "",
      topLines[idx + 1]?.text || "",
      topLines[idx + 2]?.text || ""
    ].join(" ");

    const direct = window.match(labelRegex);
    if (direct?.[1] && !/^PAG?E?$/i.test(direct[1])) {
      return cleanInvoiceNumber(direct[1]);
    }

    const hashed = pickBestHashNumber(window);
    if (hashed) return hashed;
  }

  const joined = topLines.map((line) => line.text).join(" \n ");
  const direct = joined.match(labelRegex);
  if (direct?.[1] && !/^PAG?E?$/i.test(direct[1])) {
    return cleanInvoiceNumber(direct[1]);
  }

  return pickBestHashNumber(joined);
}

export async function extractInvoiceFieldsFromPdfPage({
  pdfPath,
  pageNumber,
  vendorNames = [],
  vendorXlsxPath = ""
}) {
  const loadedVendorNames = vendorNames.length
    ? vendorNames
    : await loadVendorNamesFromXlsx(vendorXlsxPath);

  const vendorCatalog = buildVendorCatalog(loadedVendorNames);

  const { dir, imagePath } = await renderPdfPageToPng(pdfPath, pageNumber);

  try {
    const { text, lines, pageWidth, pageHeight } = await ocrPage(imagePath);
    const vendor = extractVendorName(lines, pageWidth, pageHeight, vendorCatalog);
    const invoiceNumber = extractInvoiceNumber(lines, pageWidth, pageHeight);

    return {
      pageNumber,
      text,
      words: text.split(/\s+/).filter(Boolean),
      vendorName: vendor.vendorName || "UNKNOWN_VENDOR",
      vendorMatchedFrom: vendor.matchedFrom || "",
      vendorScore: vendor.score || 0,
      invoiceNumber: invoiceNumber || "",
      rawLines: lines.map((line) => line.text)
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function extractInvoiceFieldsFromPdfPages({
  pdfPath,
  pageNumbers,
  vendorNames = [],
  vendorXlsxPath = ""
}) {
  const results = [];
  for (const pageNumber of pageNumbers || []) {
    results.push(
      await extractInvoiceFieldsFromPdfPage({
        pdfPath,
        pageNumber,
        vendorNames,
        vendorXlsxPath
      })
    );
  }
  return results;
}