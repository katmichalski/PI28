import fs from "fs";
import path from "path";
import XLSX from "xlsx";

export function normalizeVendorName(input = "") {
  return String(input)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\bTHE\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeVendorLoose(input = "") {
  return normalizeVendorName(input)
    .replace(
      /\b(INC|INCORPORATED|LLC|L\s*L\s*C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|LP|LLP|PLC)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function buildVendorRecord(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return null;

  const normalized = normalizeVendorName(cleaned);
  const loose = normalizeVendorLoose(cleaned);
  if (!normalized || normalized.length < 3) return null;

  return {
    raw: cleaned,
    normalized,
    loose,
    tokens: loose.split(/\s+/).filter((token) => token.length >= 2),
  };
}

function shouldSkipCellValue(value) {
  const s = String(value || "").trim();
  if (!s) return true;
  if (s.length < 3) return true;
  if (/^vendor(\s*name)?$/i.test(s)) return true;
  if (/^invoice(\s*(number|no|#))?$/i.test(s)) return true;
  if (/^page$/i.test(s)) return true;
  if (/^date$/i.test(s)) return true;
  if (/^account(\s*number)?$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return true;
  return false;
}

function pushVendor(dedup, value) {
  if (shouldSkipCellValue(value)) return;

  const record = buildVendorRecord(value);
  if (!record) return;

  if (!dedup.has(record.normalized)) {
    dedup.set(record.normalized, record);
  }
}

function findVendorColumnIndex(row) {
  return row.findIndex((cell) =>
    /^vendor(\s*name)?$/i.test(String(cell || "").trim())
  );
}

export function extractVendorNamesFromWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const dedup = new Map();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    let vendorColumnIndex = -1;

    for (const row of rows) {
      const cells = Array.isArray(row)
        ? row.map((cell) => String(cell || "").trim())
        : [];

      if (!cells.length) continue;

      if (vendorColumnIndex < 0) {
        const detectedIndex = findVendorColumnIndex(cells);
        if (detectedIndex >= 0) {
          vendorColumnIndex = detectedIndex;
          continue;
        }
      }

      if (vendorColumnIndex >= 0) {
        pushVendor(dedup, cells[vendorColumnIndex]);
        continue;
      }

      for (const cell of cells) {
        pushVendor(dedup, cell);
      }
    }
  }

  return [...dedup.values()];
}

export function getVendorListCandidates(baseDir) {
  return [
    process.env.VENDOR_LIST_PATH,
    path.join(baseDir, "Vendor List.xlsx"),
    path.join(baseDir, "Vendor List.xls"),
    path.join(baseDir, "..", "Vendor List.xlsx"),
    path.join(baseDir, "..", "Vendor List.xls"),
    path.join(process.cwd(), "Vendor List.xlsx"),
    path.join(process.cwd(), "Vendor List.xls"),
    path.join(process.cwd(), "server", "Vendor List.xlsx"),
    path.join(process.cwd(), "server", "Vendor List.xls"),
  ].filter(Boolean);
}

export function loadVendorCatalog(options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const candidates = getVendorListCandidates(baseDir);

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;

      const catalog = extractVendorNamesFromWorkbook(candidate);
      if (!catalog.length) continue;

      return {
        catalog,
        source: "xlsx",
        path: candidate,
      };
    } catch (error) {
      console.error(`[vendors] failed to load ${candidate}: ${error.message}`);
    }
  }

  return {
    catalog: [],
    source: "not-loaded",
    path: null,
  };
}

export default {
  normalizeVendorName,
  normalizeVendorLoose,
  extractVendorNamesFromWorkbook,
  getVendorListCandidates,
  loadVendorCatalog,
};