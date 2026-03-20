import fs from "fs";
import path from "path";
import { VENDOR_CSV_PATH } from "../config.js";
import { normalizeVendorName } from "./normalize.js";

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function parseCsv(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function loadVendors() {
  ensureDirFor(VENDOR_CSV_PATH);

  if (!fs.existsSync(VENDOR_CSV_PATH)) {
    fs.writeFileSync(VENDOR_CSV_PATH, "Vendor\n", "utf8");
  }

  const lines = parseCsv(fs.readFileSync(VENDOR_CSV_PATH, "utf8"));

  const vendors = [];
  for (const line of lines) {
    if (line.toLowerCase() === "vendor") continue;
    vendors.push(line);
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


