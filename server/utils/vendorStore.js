import fs from "fs";
import path from "path";
import xlsx from "xlsx";
import { VENDOR_XLSX_PATH } from "../config.js";
import { normalizeVendorName } from "./normalize.js";

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function loadVendors() {
  ensureDirFor(VENDOR_XLSX_PATH);

  if (!fs.existsSync(VENDOR_XLSX_PATH)) {
    // Create empty workbook
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([["Vendor"]]);
    xlsx.utils.book_append_sheet(wb, ws, "Vendors");
    xlsx.writeFile(wb, VENDOR_XLSX_PATH);
  }

  const wb = xlsx.readFile(VENDOR_XLSX_PATH);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false });

  const vendors = [];
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    if (!cell) continue;
    const raw = String(cell).trim();
    if (!raw || raw.toLowerCase() === "vendor") continue;
    vendors.push(raw);
  }

  // Map normalized -> original
  const map = new Map();
  for (const v of vendors) {
    const n = normalizeVendorName(v);
    if (n && !map.has(n)) map.set(n, v);
  }
  return map;
}


/**
 * Loads vendors and returns:
 * {
 *   map: Map<vendorNorm, vendorRaw>,
 *   entries: Array<{ norm: string, raw: string }>
 * }
 */
export function loadVendorIndex() {
  const map = loadVendors();
  const entries = [];
  for (const [norm, raw] of map.entries()) {
    if (!norm) continue;
    entries.push({ norm, raw: raw || norm });
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return { map, entries };
}


export function appendVendorIfMissing(vendorRaw) {
  const vendor = String(vendorRaw || "").trim();
  if (!vendor) return { added: false };

  const existing = loadVendors();
  const norm = normalizeVendorName(vendor);
  if (existing.has(norm)) return { added: false, normalized: norm };

  const wb = xlsx.readFile(VENDOR_XLSX_PATH);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false });

  // Ensure header
  if (!rows.length) rows.push(["Vendor"]);
  if (String(rows[0]?.[0] || "").toLowerCase() !== "vendor") {
    rows.unshift(["Vendor"]);
  }

  rows.push([vendor]);
  const newWs = xlsx.utils.aoa_to_sheet(rows);
  wb.Sheets[sheetName] = newWs;
  xlsx.writeFile(wb, VENDOR_XLSX_PATH);

  return { added: true, normalized: norm };
}
