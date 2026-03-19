import React, { useMemo, useRef, useState } from "react";
// Long-running OCR can take many minutes on scanned PDFs.
// You can override these in .env as VITE_BATCH_WAIT_MS / VITE_PDF_OCR_WAIT_MS.
const MAX_BATCH_WAIT_MS = (() => {
  const v = Number(import.meta?.env?.VITE_BATCH_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 2 * 60 * 60 * 1000; // 2 hours
})();
const MAX_PDF_OCR_WAIT_MS = (() => {
  const v = Number(import.meta?.env?.VITE_PDF_OCR_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20 * 60 * 1000; // 20 min
})();


/**
 * End user flow (supports single OR batch PDFs):
 * 1) Upload PDF(s) -> /api/batch/plan (shows progress)
 * 2) Edit suggested output names (default is "Vendor Name" + "_" + invoiceNumber; vendor keeps spaces)
 * 3) Export -> /api/batch/split (downloads one ZIP with folders per input file)
 */

function formatPct(n) {
  const v = Math.max(0, Math.min(100, Number(n) || 0));
  return `${v.toFixed(0)}%`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildPreviewUrl(jobId, pages) {
  const p = Array.isArray(pages) ? pages.join(",") : String(pages || "");
  return `/api/preview?jobId=${encodeURIComponent(jobId)}&pages=${encodeURIComponent(p)}&t=${Date.now()}`;
}

function buildOutputDownloadUrl(jobId, pages, name) {
  const p = Array.isArray(pages) ? pages.join(",") : String(pages || "");
  const n = String(name || "OUTPUT");
  return `/api/output?jobId=${encodeURIComponent(jobId)}&pages=${encodeURIComponent(p)}&name=${encodeURIComponent(n)}&t=${Date.now()}`;
}

function baseName(name) {
  const b = String(name || "FILE").replace(/\.[^.]+$/, "");
  const stripped = stripUnitedCorporatePhrase(b)
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || "FILE";
}

function stripUnitedCorporatePhrase(s) {
  // "United Corporate Services" is a valid vendor; do not strip it.
  return String(s || "");
}

// Invoice number rules (client mirror of server):
// - digits only, with optional single hyphen '-'
// - MAY include a single letter (A-Z) in total (common formats: 1V, 123A, A123, 12-345A)
// - if hyphen exists, it appears AFTER at least 2 digits (e.g., 12-3456)
// - at most 16 digits total (hyphen not counted)
function normalizeInvoiceNumber(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  let cleaned = s.toUpperCase().replace(/[^A-Z0-9\-]+/g, "");

  const firstHyphen = cleaned.indexOf("-");
  if (firstHyphen !== -1) {
    cleaned = cleaned.slice(0, firstHyphen + 1) + cleaned.slice(firstHyphen + 1).replace(/-/g, "");
  }

  cleaned = cleaned.replace(/^-+/, "").replace(/-+$/, "");

  const letters = cleaned.replace(/[^A-Z]+/g, "");
  if (letters.length > 1) return "";
  if (letters.length === 1) {
    const L = letters;
    const starts = cleaned.startsWith(L);
    const ends = cleaned.endsWith(L);
    if (cleaned === L) return L;
    if (!(starts || ends)) return "";
  }

  if (cleaned.includes("-")) {
    const [a, b] = cleaned.split("-", 2);
    const aDigits = String(a || "").replace(/\D+/g, "");
    const bDigits = String(b || "").replace(/\D+/g, "");
    if (!aDigits || aDigits.length < 2 || !bDigits || bDigits.length < 1) cleaned = (a || "") + (b || "");
  }

  const digits = cleaned.replace(/\D+/g, "");
  const letterCount = (cleaned.replace(/[^A-Z]+/g, "") || "").length;
  if (digits.length === 0) {
    const lone = cleaned.replace(/-/g, "");
    return /^[A-Z]$/.test(lone) ? lone : "";
  }
  if (letterCount === 0 && digits.length < 2) return "";
  if (letterCount === 1 && digits.length < 1) return "";
  if (digits.length > 16) {
    const L = letters.length === 1 ? letters : "";
    const keepLeading = L && cleaned.startsWith(L);
    const keepTrailing = L && cleaned.endsWith(L);
    const d = digits.slice(0, 16);
    return `${keepLeading ? L : ""}${d}${keepTrailing ? L : ""}`;
  }
  if (cleaned.length > 18) {
    const L = letters.length === 1 ? letters : "";
    const keepLeading = L && cleaned.startsWith(L);
    const keepTrailing = L && cleaned.endsWith(L);
    return `${keepLeading ? L : ""}${digits}${keepTrailing ? L : ""}`;
  }
  return cleaned;
}

// Convert a vendor-like string into a readable vendor name that keeps SPACES.
// If the string already has lowercase letters, keep casing (assume user-edited).
function toVendorDisplayName(vendorLike) {
  const s0 = stripUnitedCorporatePhrase(String(vendorLike || "")).trim();
  if (!s0) return "";

  const s = s0
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";

  if (/[a-z]/.test(s)) return s;

  const tokens = s.split(" ").filter(Boolean);
  const out = tokens.map((tok) => {
    if (/^\d+$/.test(tok)) return tok;
    if (/^[A-Z]{1,3}$/.test(tok)) return tok;
    if (/^[0-9A-Z]{1,5}$/.test(tok) && /[0-9]/.test(tok) && /[A-Z]/.test(tok)) return tok;

    const lower = tok.toLowerCase();
    const m = lower.match(/[a-z]/);
    if (!m) return tok;
    const i = m.index ?? 0;
    return lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
  });

  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Convert a stem (which may contain spaces/underscores/hyphens) into lowerCamelCase.
// Examples: "ACME_SUPPLY_123" -> "acmeSupply123", "7_ELEVEN" -> "7Eleven".
function toLowerCamelCaseStem(stem) {
  const s0 = String(stem || "");
  const s = stripUnitedCorporatePhrase(s0).trim();
  if (!s) return "";

  const tokens = s
    .replace(/[\/_\-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
  if (!tokens.length) return "";

  // If the user already typed a single-token camelCase/PascalCase stem, keep internal caps.
  if (tokens.length === 1) {
    const tok = tokens[0];
    if (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) {
      return tok.charAt(0).toLowerCase() + tok.slice(1);
    }
  }


  const capAfterDigits = (tokLower) => {
    const m = tokLower.match(/[a-z]/);
    if (!m) return tokLower;
    const idx = m.index ?? 0;
    return tokLower.slice(0, idx) + tokLower[idx].toUpperCase() + tokLower.slice(idx + 1);
  };

  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const lower = String(tokens[i]).toLowerCase();
    if (i === 0) out.push(lower);
    else out.push(capAfterDigits(lower));
  }
  return out.join("");
}
function extractPageVendorNamesFromItem(item) {
  const byPage = new Map();

  const put = (pageLike, pageIndex, fallback = "", source = "derived") => {
    const page = Number(pageIndex);
    if (!Number.isFinite(page) || page < 1) return;

    const name = resolveVendorName(pageLike, fallback) || "Unknown Vendor";
    const current = byPage.get(page);
    const next = { page, name, source };

    const currentUnknown = !current || /^unknown vendor$/i.test(String(current.name || ""));
    const nextUnknown = /^unknown vendor$/i.test(String(next.name || ""));

    if (!current || (currentUnknown && !nextUnknown) || source === "group") {
      byPage.set(page, next);
    }
  };

  for (const page of item?.plan?.pageVendors || []) {
    put(page, page?.page || page?.pageIndex, page?.vendorName || page?.vendorNorm || "", page?.source || "pageVendors");
  }

  for (const page of item?.plan?.pages || []) {
    put(page, page?.pageIndex, page?.vendorName || page?.vendorNorm || "", "page");
  }

  for (const group of item?.groups || []) {
    for (const pageNumber of Array.isArray(group?.pages) ? group.pages : []) {
      put(group, pageNumber, group?.vendorName || group?.vendorNorm || "", "group");
    }
  }

  return Array.from(byPage.values()).sort((a, b) => (a.page || 0) - (b.page || 0));
}
// Normalize an output stem so it follows <Vendor Name>_<InvoiceNumber>.
// - Vendor keeps SPACES (no underscores between words)
// - Separator between vendor and invoice is a SINGLE underscore
// - Invoice keeps digits with an optional single hyphen
function toVendorInvoiceStem(stem) {
  const s0 = stripUnitedCorporatePhrase(String(stem || ""))
    .replace(/\.pdf$/i, "")
    .trim();

  const cleaned = s0
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let vendorPart = cleaned;
  let invPart = "";

  // Allow invoice numbers that include a single letter (e.g., 1V, 123A, A123, 12-345A)
  const m2 = cleaned.match(/([A-Za-z0-9][A-Za-z0-9\-]{0,24})\s*$/);
  if (m2) {
    const inv = normalizeInvoiceNumber(m2[1]);
    if (inv) {
      invPart = inv;
      vendorPart = cleaned.slice(0, m2.index).trim();
    }
  }

  if (!invPart && cleaned.includes("_")) {
    const parts = cleaned.split(/_+/g).filter(Boolean);
    if (parts.length >= 2) {
      const inv = normalizeInvoiceNumber(parts[parts.length - 1]);
      if (inv) {
        invPart = inv;
        vendorPart = parts.slice(0, -1).join(" ").trim();
      }
    }
  }

  const vendorName = toVendorDisplayName(vendorPart) || "Output";
  const invFinal = invPart || "unknownInvoice";
  return `${vendorName}_${invFinal}`;
}


// Remove address-like tokens from a normalized vendor string when building output stems.
// This keeps short leading digits (e.g., 7_ELEVEN) but strips street numbers/zip codes/etc.
function cleanVendorForStem(vendorNormLike) {
  const raw = String(vendorNormLike || "").toUpperCase();
  if (!raw) return "";

  const STREET = new Set([
    "STREET","ST","ROAD","RD","AVENUE","AVE","BOULEVARD","BLVD","DRIVE","DR","LANE","LN",
    "COURT","CT","CIRCLE","CIR","HIGHWAY","HWY","PARKWAY","PKWY","PLACE","PL","WAY",
    "TERRACE","TER","TRAIL","TRL","PIKE","PLAZA","PLZ","SQUARE","SQ","LOOP"
  ]);
  const UNIT = new Set(["SUITE","STE","APT","UNIT","FLOOR","FL","BLDG","BUILDING","RM","ROOM"]);
  const STOP = new Set([
    // Contact / metadata
    "FAX","PHONE","TEL","TELEPHONE","PH","PHN","EMAIL","WEB","WWW",
    "MOBILE","CELL","CEL","CALL","EXT","EXTN","EXTENSION",
    // Common doc labels
    "REMIT","REMITTANCE","BILL","BILLTO","SHIP","SHIPTO",
    "ATTN","ATTENTION","DEPARTMENT","DEPT",
    // Address-ish
    "PO","P_O","BOX","ZIP","USA"
  ]);
  const STATES = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
    "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
    "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
    "WI","WY","DC"
  ]);
  const DIR = new Set(["N","S","E","W","NE","NW","SE","SW","NORTH","SOUTH","EAST","WEST"]);

  const tokens = raw.split("_").filter(Boolean);
  const out = [];
  let sawAddress = false;

  const isNum = (s) => /^\d+$/.test(String(s || ""));
  const numLen = (s) => String(s || "").length;

  const looksLikePhoneRun = (i) => {
    if (
      tokens[i] === "1" &&
      isNum(tokens[i + 1]) &&
      isNum(tokens[i + 2]) &&
      isNum(tokens[i + 3]) &&
      numLen(tokens[i + 1]) === 3 &&
      numLen(tokens[i + 2]) === 3 &&
      numLen(tokens[i + 3]) === 4
    ) {
      return true;
    }
    if (tokens[i] === "1" && isNum(tokens[i + 1]) && numLen(tokens[i + 1]) === 10) return true;
    if ((tokens[i] === "T" || tokens[i] === "P") && isNum(tokens[i + 1]) && numLen(tokens[i + 1]) >= 3) return true;
    if (tokens[i] === "1") {
      for (let k = 1; k <= 3; k++) {
        const tk = tokens[i + k];
        if (isNum(tk) && numLen(tk) >= 3) return true;
      }
    }
    return false;
  };

  const hasStreetSuffixAhead = (fromIdx) => {
    for (let j = fromIdx; j < Math.min(tokens.length, fromIdx + 7); j++) {
      if (STREET.has(tokens[j])) return true;
    }
    return false;
  };

  const popTrailingCityish = () => {
    let popped = 0;
    while (popped < 2 && out.length > 2) {
      const last = out[out.length - 1];
      if (/^[A-Z]{2,}$/.test(last)) {
        out.pop();
        popped += 1;
      } else break;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1] || "";
    const prev = tokens[i - 1] || "";

    // Remove "UNITED STATES" country line when present
    if (t === "UNITED" && next === "STATES") {
      sawAddress = true;
      break;
    }

    if (looksLikePhoneRun(i)) {
      if (t === "1" && /^\d{3}$/.test(next) && /^\d{3}$/.test(tokens[i + 2] || "") && /^\d{4}$/.test(tokens[i + 3] || "")) {
        i += 3;
      } else if (t === "1" && /^\d{10}$/.test(next)) {
        i += 1;
      }
      continue;
    }

    if (STOP.has(t)) {
      sawAddress = true;
      if ((t === "PO" || t === "P_O") && next === "BOX") i++;
      break;
    }

    if (STATES.has(t) && /^\d{5}(?:\d{4})?$/.test(next)) {
      sawAddress = true;
      popTrailingCityish();
      break;
    }

    if (/^\d{5}(?:\d{4})?$/.test(t)) {
      sawAddress = true;
      popTrailingCityish();
      break;
    }

    if (STREET.has(t)) {
      sawAddress = true;
      if (out.length > 1) {
        const last = out[out.length - 1];
        if (/^[A-Z]{2,}$/.test(last)) out.pop();
      }
      break;
    }

    if (UNIT.has(t) && /^\d{1,5}$/.test(next)) {
      sawAddress = true;
      break;
    }

    if (DIR.has(t) && (hasStreetSuffixAhead(i + 1) || STREET.has(next))) {
      sawAddress = true;
      break;
    }

    if (isNum(t)) {
      if (i === 0 && numLen(t) <= 2) {
        out.push(t);
        continue;
      }
      if (out.length && (numLen(t) >= 3 || hasStreetSuffixAhead(i + 1))) {
        sawAddress = true;
        break;
      }
      continue;
    }

    if (/^\d{1,4}$/.test(t) && UNIT.has(prev)) continue;
    if (/^\d{3,}$/.test(t)) continue;

    out.push(t);
    if (out.length >= 8) break;
  }

  while (out.length && /^\d{1,4}$/.test(out[out.length - 1]) && out.length > 1) out.pop();

  const cleaned = out.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (sawAddress) return cleaned;
  return cleaned && cleaned.length >= 3 ? cleaned : raw;
}


function normalizeVendorKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectTextBits(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    if (s) out.push(s);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTextBits(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectTextBits(v, out);
  }
  return out;
}

function pageCandidateText(pageLike) {
  const preferred = [
    pageLike?.vendorName,
    pageLike?.vendorNorm,
    pageLike?.ocrText,
    pageLike?.text,
    pageLike?.rawText,
    pageLike?.pageText,
    pageLike?.fullText,
    pageLike?.headerText,
    pageLike?.topText,
    pageLike?.topThirdText,
    pageLike?.lines,
    pageLike?.blocks
  ];

  const extra = [];
  if (pageLike && typeof pageLike === "object") {
    for (const [k, v] of Object.entries(pageLike)) {
      if (/vendor|invoice|pageindex|pages?$/i.test(k)) continue;
      collectTextBits(v, extra);
    }
  }

  return [...collectTextBits(preferred), ...extra].join("\n").trim();
}

const VENDOR_BAD_LINE_PATTERNS = [
  /\binvoice\b/i,
  /\binvoice\s*(number|no|#)\b/i,
  /\bstatement\b/i,
  /\bbill\s+to\b/i,
  /\bship\s+to\b/i,
  /\bremit\b/i,
  /\bamount\s+due\b/i,
  /\btotal\b/i,
  /\bdate\b/i,
  /\bterms\b/i,
  /\bpage\s+\d+\b/i,
  /\bpo\s*(number|#)?\b/i,
  /@/,
  /\bwww\./i,
  /\bhttps?:\/\//i,
  /\d{3}[-.\s]\d{3}[-.\s]\d{4}/,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  /^\$?\d[\d,]*\.\d{2}$/
];

function looksLikeVendorLine(line) {
  const s = String(line || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (s.length < 4 || s.length > 80) return false;
  if (VENDOR_BAD_LINE_PATTERNS.some((rx) => rx.test(s))) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^\d+\s+[A-Z]/i.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const alphaCount = (s.match(/[A-Za-z]/g) || []).length;
  if (alphaCount < 4) return false;
  return true;
}

function vendorFromText(text) {
  const raw = String(text || "");
  if (!raw) return "";

  for (const vendor of KNOWN_VENDOR_PATTERNS) {
    if (vendor.patterns.some((rx) => rx.test(raw))) return vendor.name;
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 16);

  for (const line of lines) {
    if (!looksLikeVendorLine(line)) continue;
    const cleaned = line
      .replace(/^from\s+/i, "")
      .replace(/^vendor\s*[:\-]\s*/i, "")
      .replace(/[|]+/g, " ")
      .trim();
    const canonical = canonicalVendorName(cleaned);
    if (canonical && normalizeVendorKey(canonical) !== "UNKNOWN VENDOR") return canonical;
  }

  return "";
}

function resolveVendorName(pageLike, fallback = "") {
  const direct = canonicalVendorName(
    pageLike?.VENDORNAME || pageLike?.vendorName || pageLike?.vendorNorm || pageLike?.vendor || fallback || ""
  );
  if (direct && normalizeVendorKey(direct) !== "UNKNOWN VENDOR") return direct;

  const candidates = [
    pageLike?.vendorRaw,
    pageLike?.matchedFrom,
    pageLike?.vendorMatchedFrom,
    pageLike?.headerText,
    pageLike?.topText,
    pageLike?.ocrText,
    fallback
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const canonical = canonicalVendorName(candidate);
    if (canonical && normalizeVendorKey(canonical) !== "UNKNOWN VENDOR") {
      return canonical;
    }

    const normalized = normalizeVendorKey(candidate);

    if (/\bWWW\s+CLASINFO\b/.test(normalized) || /\bCLASINFO\b/.test(normalized) || /\bCLAS\b/.test(normalized)) {
      return "Clas Information Services";
    }

    if (/\bRASI[\s_]+NCSI\b/.test(normalized)) {
      return "Rasi_NCSI";
    }

    if (/\bDOC[\s-]*U[\s-]*SEARCH\b/.test(normalized)) {
      return "Doc-U-Search";
    }
  }

  return canonicalVendorName(fallback || "") || "Unknown Vendor";
}
  // existing fallback logic continues...

const KNOWN_VENDOR_PATTERNS = [
  {
    name: "PST Abstracting, Inc.",
    patterns: [/\bPST\s+ABSTRACT/i, /\bPST\b.*\bINC\b/i]
  },
  {
    name: "CT Filing & Search Services, LLC",
    patterns: [/\bCT\s+FILING\b/i, /\bSEARCH\s+SERVICES\b.*\bLLC\b/i]
  },
  {
    name: "CLAS Information Services",
    patterns: [/\bCLAS\s+INFORMATION\s+SERVICES\b/i, /\bCLAS\b.*\bINFORMATION\b/i]
  },
  {
    name: "United Corporate Services, Inc.",
    patterns: [/\bUNITED\s+CORPORATE\s+SERVICES\b/i, /\bUCS\b.*\bCORPORATE\b/i]
  },
  {
    name: "Pioneer Corporate Services",
    patterns: [/\bPIONEER\s+CORPORATE\s+SERVICES\b/i, /\bPIONEER\b.*\bCORPORATE\b/i]
  }
];

function canonicalVendorName(raw) {
  const key = normalizeVendorKey(raw);
  if (!key) return "";

  for (const vendor of KNOWN_VENDOR_PATTERNS) {
    if (vendor.patterns.some((rx) => rx.test(key))) return vendor.name;
  }

  return toVendorDisplayName(raw);
}

function extractVendorNamesFromItem(item) {
  const seen = new Set();
  const out = [];

  const addVendor = (pageLike, pageIndex, fallback = "") => {
    const name = resolveVendorName(pageLike, fallback);
    if (!name || /^unknown vendor$/i.test(name)) return;
    const k = `${pageIndex || "?"}__${name}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({
      page: Number(pageIndex) || null,
      name
    });
  };

  for (const page of item?.plan?.pages || []) {
    addVendor(page, page?.pageIndex, page?.vendorName || page?.vendorNorm || "");
  }

  if (!out.length) {
    for (const group of item?.groups || []) {
      const firstPage = Array.isArray(group?.pages) ? group.pages[0] : null;
      addVendor(group, firstPage, group?.vendorName || group?.vendorNorm || "");
    }
  }

  return out.sort((a, b) => (a.page || 0) - (b.page || 0));
}

function defaultStem(vendorNorm, invoiceNumber) {
  // Guard against common header labels accidentally being detected as vendor.
  const isBadVendorLabel = (s) => {
    const n0 = String(s || "")
      .replace(/_/g, " ")
      .replace(/[#:]+/g, " ")
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!n0) return true;

    // Common OCR swaps: l/1/|/! -> i, 0 -> o. Only used for label checks.
    const n = n0
      .replace(/^l(?=nvoice\b)/, "i")
      .replace(/[|!]/g, "i")
      .replace(/1/g, "i")
      .replace(/0/g, "o")
      .replace(/\s+/g, " ")
      .trim();
    const exact = new Set([
      "invoice date",
      "invoice",
      "invoice number",
      "invoice no",
      "invoice #",
      "inv #",
      "due date",
      "bill to",
      "ship to",
      "sold to",
      "remit to",
      "remittance",
      "purchase order",
      "po number",
      "terms",
      "subtotal",
      "tax",
      "total",
      "amount due",
      "balance due"
    ]);
    if (exact.has(n)) return true;
    if (/^(invoice\s*(date|number|no|#)|inv\s*#|due\s*date|bill\s*to|ship\s*to|remit\s*to)\b/.test(n)) return true;
    if (/^invoicedate\b/.test(n.replace(/\s+/g, ""))) return true;
    return false;
  };

  const safeVendorNorm = isBadVendorLabel(vendorNorm) ? "UNKNOWN_VENDOR" : vendorNorm;

  const v0 = String(safeVendorNorm || "UNKNOWN_VENDOR")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const vClean = cleanVendorForStem(v0) || "UNKNOWN_VENDOR";
  const vendorName = toVendorDisplayName(vClean) || "Unknown Vendor";

  const inv = normalizeInvoiceNumber(invoiceNumber || "");
  const invPart = inv || "unknownInvoice";

  return `${vendorName}_${invPart}`;
}


function dedupeStems(groups) {
  const used = new Map();
  return (groups || []).map((g) => {
    const stem = String(g.suggestedStem || g.stem || "OUTPUT");
    // Keep vendor names reusable. If two outputs have the same stem,
    // add a numeric suffix AFTER the invoice portion (e.g. "Vendor_123_2")
    // instead of altering the vendor name (e.g. "Copy2").
    const base = stem;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    if (count === 1) return g;

    const hasPdfExt = /\.pdf$/i.test(base);
    const b = hasPdfExt ? base.replace(/\.pdf$/i, "") : base;
    return { ...g, suggestedStem: `${b}_${count}${hasPdfExt ? ".pdf" : ""}` };
  });
}

function parsePages(value) {
  const nums = String(value || "")
    .split(/[^0-9]+/g)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 1);
  // de-dupe while keeping order
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  // cap to 2 pages per invoice as per rules
  return out.slice(0, 2);
}

async function xhrUpload({ url, formData, onProgress }) {
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "json";

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        const pct = (evt.loaded / evt.total) * 100;
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(formData);
  });
}

function useDragActive() {
  const counter = useRef(0);
  const [active, setActive] = useState(false);

  const onDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    counter.current += 1;
    setActive(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    counter.current -= 1;
    if (counter.current <= 0) {
      counter.current = 0;
      setActive(false);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const reset = () => {
    counter.current = 0;
    setActive(false);
  };

  return { active, onDragEnter, onDragLeave, onDragOver, reset };
}


export default function App() {
  const fileInputRef = useRef(null);
  const outputRef = useRef(null);

  // Prevent multiple overlapping polling loops / EventSource streams
  const pollTokensRef = useRef({ batch: 0, pdf: 0 });
  const streamClosersRef = useRef({ batch: null, pdf: null, export: null });

  const batchDnD = useDragActive();

  const [files, setFiles] = useState([]); // File[]
  const [uploadPct, setUploadPct] = useState(0);

  const [batchJobId, setBatchJobId] = useState("");
  const [progress, setProgress] = useState(null);

  // items: [{ sourceName, jobId, plan, groups }]
  const [items, setItems] = useState([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [preview, setPreview] = useState({ open: false, url: "", title: "" });
  // splitSelection: { [jobId]: { [groupIndex]: true } }
  const [splitSelection, setSplitSelection] = useState({});

  const canAnalyze = useMemo(() => files.length > 0 && !busy, [files, busy]);
  const canExport = useMemo(
    () =>
      !!batchJobId &&
      items.some((it) => (it.groups || []).some((g) => Array.isArray(g.pages) && g.pages.length > 0)) &&
      !busy,
    [batchJobId, items, busy]
  );

const vendorResults = useMemo(
  () => items.map((it) => ({ jobId: it.jobId, sourceName: it.sourceName, vendors: extractPageVendorNamesFromItem(it) })),
  [items]
);

  const openPicker = () => fileInputRef.current?.click();

  const reset = () => {
    setError("");
    setItems([]);
    setBatchJobId("");
    setProgress(null);
    setUploadPct(0);
  };

  const onPickFiles = (fileList) => {
    reset();
    const arr = Array.from(fileList || []).filter((f) => f && /pdf$/i.test(f.name));
    setFiles(arr);
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    batchDnD.reset();
    onPickFiles(e.dataTransfer.files);
  };


  const listenProgress = (jid, opts = {}) => {
    const setter = typeof opts?.setState === "function" ? opts.setState : setProgress;
    const onDone = typeof opts?.onDone === "function" ? opts.onDone : null;
    const onError = typeof opts?.onError === "function" ? opts.onError : null;

    const ctl = { stopped: false };

    (async function pollProgress() {
      while (!ctl.stopped) {
        try {
          const r = await fetch(`/api/progress/${encodeURIComponent(jid)}?once=1&t=${Date.now()}`, {
            cache: "no-store"
          });

          if (!r.ok) {
            throw new Error(`Progress request failed (${r.status})`);
          }

          const data = await r.json().catch(() => null);
          if (data) setter(data);

          if (data?.done) {
            ctl.stopped = true;
            try {
              onDone?.(data);
            } catch {}
            break;
          }
        } catch (err) {
          ctl.stopped = true;
          try {
            onError?.(err);
          } catch {}
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    })();

    return () => {
      ctl.stopped = true;
    };
  };


  const hydrateBatchItems = (rawItems) => {
    return (rawItems || []).map((it) => {
      const plan = it.plan || null;
      const groups = (plan?.groups || []).map((g) => ({
        ...g,
        suggestedStem: g.suggestedStem || g.stem || "OUTPUT"
      }));
      return {
        sourceName: it.sourceName,
        jobId: it.jobId,
        ocrApplied: it.ocrApplied,
        ocrError: it.ocrError,
        itemError: it.error || "",
        plan,
        groups
      };
    });
  };

  const fetchBatchPlanResults = async (jid) => {
    // Avoid HTTP cache revalidation returning 304 (which has no body and breaks r.json())
    const r = await fetch('/api/batch/plan/' + encodeURIComponent(jid), { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  };

  const runBatchPlan = async () => {
    if (!files.length) return;
    setBusy(true);
    setError("");
    setUploadPct(0);
    setProgress(null);

    let waitingAsync = false;

    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);

      // Use async batch planning so the upload request returns quickly.
      // Sync mode can sit in DevTools as “pending” for minutes while OCR/analysis runs.
      // Async mode returns { batchJobId } immediately, then we stream progress + poll results.
      const planUrl = "/api/batch/plan";

      const resp = await xhrUpload({
        url: planUrl,
        formData: fd,
        onProgress: (pct) => setUploadPct(pct)
      });

      if (!resp?.batchJobId) throw new Error(resp?.error || "No batchJobId returned.");
      const jid = resp.batchJobId;

      setBatchJobId(jid);

      // cancel any prior listeners/polls
      pollTokensRef.current.batch += 1;
      const myBatchToken = pollTokensRef.current.batch;
      if (typeof streamClosersRef.current.batch === 'function') {
        try { streamClosersRef.current.batch(); } catch {}
      }

      const initialItems = hydrateBatchItems(resp.items || []);
      setItems(initialItems);

      // Help users find the Output Files section (it's below the uploader).
      setTimeout(() => {
        try {
          outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {}
      }, 0);

      // If the server ran synchronously, we already have plans.
      const hasPlanNow = initialItems.some((x) => x.plan && (x.groups || []).length);
      if (hasPlanNow) {
        const failed = initialItems.filter((x) => !x.plan);
        if (failed.length) {
          setError(`${failed.length} file(s) could not be analyzed. Scroll down to see the per-file error details.`);
        }
        return;
      }

      // Async mode: keep UI busy, stream progress, then fetch results when done.
      waitingAsync = true;

      const pollCtl = { stopped: false };
      const finishBatch = (fullItems) => {
        const failed = (fullItems || []).filter((x) => !x.plan);
        if (failed.length) {
          setError(`${failed.length} file(s) could not be analyzed. Scroll down to see the per-file error details.`);
        }
      };

      streamClosersRef.current.batch = listenProgress(jid, {
        setState: setProgress,
        onDone: async () => {
          pollCtl.stopped = true;
          try {
            const doneSnap = await fetchBatchPlanResults(jid);
            if (!doneSnap.ok) throw new Error(doneSnap.data?.error || ('Failed to fetch batch results (' + doneSnap.status + ')'));
            const fullItems = hydrateBatchItems(doneSnap.data?.items || []);
            setItems(fullItems);
            finishBatch(fullItems);
          } catch (e) {
            setError(String(e?.message || e));
          } finally {
            setBusy(false);
          }
        }
      });

      // Fallback polling (covers environments where EventSource/proxy doesn't stream)
      (async function pollBatch() {
        let tries = 0;
        let consecutiveErrors = 0;
        const startedAt = Date.now();
        let warnedLong = false;
        while (!pollCtl.stopped) {
          if (myBatchToken !== pollTokensRef.current.batch) break;
          tries++;
          try {
            const snap = await fetchBatchPlanResults(jid);
            if (!snap.ok) {
              consecutiveErrors++;
              // If server says job is missing or failed, stop immediately.
              if (snap.status >= 400 && snap.status !== 202) {
                pollCtl.stopped = true;
                setError(snap.data?.error || ('Batch analysis failed (' + snap.status + ')'));
                setBusy(false);
                break;
              }
              if (consecutiveErrors >= 8) {
                pollCtl.stopped = true;
                setError(snap.data?.error || 'Batch analysis is not reachable right now.');
                setBusy(false);
                break;
              }
            } else {
              consecutiveErrors = 0;
              const payload = snap.data || {};
              if (payload?.progress) setProgress(payload.progress);
              const fullItems = hydrateBatchItems(payload.items || []);
              setItems(fullItems);
              if (payload?.done || payload?.progress?.done) {
                pollCtl.stopped = true;
                finishBatch(fullItems);
                setBusy(false);
                break;
              }
            }
          } catch {
            consecutiveErrors++;
            if (consecutiveErrors >= 8) {
              pollCtl.stopped = true;
              setError('Batch analysis failed due to repeated network errors.');
              setBusy(false);
              break;
            }
          }
          const elapsed = Date.now() - startedAt;
          if (!warnedLong && elapsed >= MAX_BATCH_WAIT_MS) {
            warnedLong = true;
            // Non-fatal: keep polling, but let the user know why it might be slow.
            setError(
              "Batch analysis is still running. If this never finishes, check /api/health for tessdataEng=true, try 1–2 files, and lower IMAGE_OCR_DPI (server). We'll keep checking for results…"
            );
          }
          const waitMs = Math.min(5000, 1000 + Math.floor(elapsed / 60000) * 500);
          await new Promise((r) => setTimeout(r, waitMs));
        }
        // No hard stop here: keep polling. The server will eventually mark progress.done.
      })();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      if (!waitingAsync) setBusy(false);
    }
  };

  // NOTE: The Output Name input is a controlled React input.
  // If we normalize on every keystroke, React constantly rewrites the value
  // (adding _unknownInvoice, stripping punctuation, etc.) and the cursor jumps.
  // That makes it feel like you "can't type".
  // So we keep a draft while typing and only normalize on blur / export / download.
  const updateStemDraft = (fileIdx, groupIdx, draft) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== fileIdx) return it;
        const groups = (it.groups || []).map((g, gi) => (gi === groupIdx ? { ...g, suggestedStemDraft: draft } : g));
        return { ...it, groups };
      })
    );
  };

  const commitStemDraft = (fileIdx, groupIdx) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== fileIdx) return it;
        const groups = (it.groups || []).map((g, gi) => {
          if (gi !== groupIdx) return g;
          const raw = String(g?.suggestedStemDraft ?? g?.suggestedStem ?? "").trim();
          const normalized = toVendorInvoiceStem(raw) || "output_unknownInvoice";
          const { suggestedStemDraft, ...rest } = g || {};
          return { ...rest, suggestedStem: normalized };
        });
        return { ...it, groups };
      })
    );
  };


const openPreview = (jobId, pages, title) => {
  const p = Array.isArray(pages) ? pages.join(",") : String(pages || "");
  const url = `/api/preview?jobId=${encodeURIComponent(jobId)}&pages=${encodeURIComponent(p)}&t=${Date.now()}`;
  setPreview({ open: true, url, title: title || "Preview" });
};

const downloadSingleOutput = async (jobId, group) => {
  try {
    const pages = Array.isArray(group?.pages) ? group.pages : [];
    if (!pages.length) return;
    const stem0 = String(group?.suggestedStemDraft ?? group?.suggestedStem ?? group?.stem ?? "OUTPUT").trim() || "OUTPUT";
    const stem = toVendorInvoiceStem(stem0) || "output_unknownInvoice";
    const filename = stem.toLowerCase().endsWith(".pdf") ? stem : `${stem}.pdf`;

    const url = buildOutputDownloadUrl(jobId, pages, stem);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      let msg = `Download failed (${r.status})`;
      try {
        const j = JSON.parse(text);
        msg = j?.error || msg;
      } catch {
        if (text) msg = text.slice(0, 240);
      }
      throw new Error(msg);
    }

    const blob = await r.blob();
    downloadBlob(blob, filename);
  } catch (e) {
    setError(String(e?.message || e));
  }
};

const closePreview = () => setPreview({ open: false, url: "", title: "" });
const updatePages = (fileIdx, groupIdx, pagesText) => {
  const pages = parsePages(pagesText);
  setItems((prev) =>
    prev.map((it, i) => {
      if (i !== fileIdx) return it;
      const groups = (it.groups || []).map((g, gi) => (gi === groupIdx ? { ...g, pages } : g));
      return { ...it, groups };
    })
  );
};


const resetFileToOcrPlan = (fileIdx) => {
  setItems((prev) =>
    prev.map((it, i) => {
      if (i !== fileIdx) return it;
      const plan = it.plan || null;
      const groups = dedupeStems((plan?.groups || []).map((g) => ({ ...g, suggestedStem: g.suggestedStem || g.stem || "OUTPUT" })));
      return { ...it, groups };
    })
  );
};

const resplitFileToSingles = (fileIdx) => {
  setItems((prev) =>
    prev.map((it, i) => {
      if (i !== fileIdx) return it;
      const pages = it.plan?.pages || [];
const groups = pages.map((p, idx) => {
const vendorNorm =
  resolveVendorName(g, g.VENDORNAME || g.vendorNorm || g.vendorName || "") ||
  g.VENDORNAME ||
  g.vendorNorm ||
  "UNKNOWN_VENDOR";
    return {
    groupIndex: idx + 1,
    vendorNorm: resolvedVendor || p.vendorNorm || "UNKNOWN_VENDOR",
    // rest unchanged
  };
});
      return { ...it, groups: dedupeStems(groups) };
    })
  );
};

const splitGroupIntoSingles = (fileIdx, groupIdx) => {
  setItems((prev) =>
    prev.map((it, i) => {
      if (i !== fileIdx) return it;
      const groups = Array.isArray(it.groups) ? [...it.groups] : [];
      const g = groups[groupIdx];
      if (!g || !Array.isArray(g.pages) || g.pages.length < 2) return it;
      const vendorNorm = resolveVendorName(g, g.vendorNorm || g.vendorName || "") || g.vendorNorm || "UNKNOWN_VENDOR";
      const invoiceNumber = g.invoiceNumber || "";
      const [p1, p2] = g.pages;
      const g1 = { ...g, vendorNorm, pages: [p1], suggestedStem: defaultStem(vendorNorm, invoiceNumber) };
      const g2 = { ...g, vendorNorm, pages: [p2], suggestedStem: defaultStem(vendorNorm, invoiceNumber) };
      groups.splice(groupIdx, 1, g1, g2);
      return { ...it, groups: dedupeStems(groups) };
    })
  );
};


  const exportBatchZip = async () => {
    if (!canExport) return;
    setBusy(true);
    setError("");

    try {
      listenProgress(batchJobId);

      const payload = {
        batchJobId,
        items: items.map((it) => ({
          jobId: it.jobId,
          sourceName: it.sourceName,
          folderName: baseName(it.sourceName),
          groups: (it.groups || []).map((g) => {
            const raw = String(g?.suggestedStemDraft ?? g?.suggestedStem ?? g?.stem ?? "").trim();
            const suggestedStem = toVendorInvoiceStem(raw) || "output_unknownInvoice";
            const { suggestedStemDraft, ...rest } = g || {};
            return { ...rest, suggestedStem };
          })
        }))
      };

      const resp = await fetch("/api/batch/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data?.error || `Split failed (${resp.status})`);
      }

      const blob = await resp.blob();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = files.length === 1 ? `${baseName(files[0].name)}_OUTPUT.zip` : `BATCH_OUTPUT_${stamp}.zip`;
      downloadBlob(blob, name);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
      <div className="header">
        <div>
          <div className="title">Project Invoice</div>
          <div className="subtitle">Upload one or many PDFs → detect Vendor + Invoice # → split → download ZIP</div>
        </div>
        <div className="pill">
          <span>Backend:</span>
          <a href="/api/health" target="_blank" rel="noreferrer">
            /api/health
          </a>
        </div>
      </div>

      <div className="card">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => onPickFiles(e.target.files)}
        />

        <div
          className={`dropzone ${batchDnD.active ? "dropzoneActive" : ""}`}
          onClick={openPicker}
          onDrop={onDrop}
          onDragEnter={batchDnD.onDragEnter}
          onDragLeave={batchDnD.onDragLeave}
          onDragOver={batchDnD.onDragOver}
        >
          <div>
            <strong>
              {files.length === 0
                ? "Drag & drop PDF(s) here"
                : files.length === 1
                ? files[0].name
                : `${files.length} files selected`}
            </strong>
            <div className="hint">or click to choose file(s)</div>
            {files.length > 0 && (
              <div className="hint small">
                Total size: {(files.reduce((sum, f) => sum + (f?.size || 0), 0) / 1024).toFixed(0)} KB
              </div>
            )}
          </div>
        </div>

        {files.length > 1 && (
          <div className="footer" style={{ marginTop: 10 }}>
            {files.slice(0, 6).map((f) => (
              <div key={f.name} className="small">
                • {f.name}
              </div>
            ))}
            {files.length > 6 && <div className="small">…and {files.length - 6} more</div>}
          </div>
        )}

        <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
          <button className="btn btnPrimary" onClick={runBatchPlan} disabled={!canAnalyze}>
            {busy ? "Working…" : "Analyze & Suggest Splits"}
          </button>
          <button className="btn" onClick={exportBatchZip} disabled={!canExport}>
            Download ZIP
          </button>

          {progress && (
            <span className="pill">
              {progress.stage || "…"}
              {progress.doneGroups && progress.totalGroups ? ` • ${progress.doneGroups}/${progress.totalGroups}` : ""}
            </span>
          )}
        </div>

        {(busy || uploadPct > 0) && (
          <div className="progressWrap" aria-label="progress">
            <div className="progressBar" style={{ width: formatPct(uploadPct) }} />
          </div>
        )}
        {(busy || uploadPct > 0) && (
          <div className="small" style={{ marginTop: 8 }}>
            Upload: {formatPct(uploadPct)}
            {progress?.message ? ` • ${progress.message}` : ""}
          </div>
        )}

        {error && <div className="error">Error: {error}</div>}

        {vendorResults.some((it) => it.vendors.length > 0) && (
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Detected Vendors</div>
            <div className="small" style={{ marginTop: 6 }}>
              These vendor names are generated from the analyzed invoice data using repeatable pattern matching, so the same vendor names can be surfaced again on future uploads.
            </div>

            {vendorResults.map((it) =>
              it.vendors.length ? (
                <div key={`vendors_${it.jobId}`} style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 700 }}>{it.sourceName}</div>
                  <div className="small" style={{ marginTop: 6 }}>
                    {it.vendors.map((v) => `p.${v.page || "?"}: ${v.name}`).join(" • ")}
                  </div>
                </div>
              ) : null
            )}
          </div>
        )}

        {items.length > 0 && (
          <div className="footer">
Files analyzed: {items.length} • Total suggested invoices:{" "}
{(() => {
  const pending = items.some((it) => !it.plan && !it.itemError);
  if (pending) return <b>calculating…</b>;
  return items.reduce((sum, it) => sum + ((it.plan?.groups || []).length || 0), 0);
})()}
{items.reduce((sum, it) => sum + (Number(it.plan?.vendorsAdded || 0) || 0), 0) > 0 && (
  <>
    {" "}
    • <b>New vendors added:</b>{" "}
    {items.reduce((sum, it) => sum + (Number(it.plan?.vendorsAdded || 0) || 0), 0)}
  </>
)}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }} ref={outputRef}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Output Files</div>
              <div className="small">
                Default format is <b>Vendor Name_InvoiceNumber</b> (vendor keeps spaces, one underscore before invoice #; invoice keeps an optional hyphen). You can edit stems below. Batch ZIP will include a folder per input PDF.
              </div>
            </div>
            <div className="pill">Tip: Keep invoice numbers digits-only</div>
          </div>

          {items.length === 0 && (
            <div className="footer" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700 }}>No output files yet.</div>
              <div className="small" style={{ marginTop: 6 }}>
                To generate outputs: upload PDF(s) in the <b>Drag &amp; drop PDF(s)</b> section above, click <b>Analyze &amp; Suggest Splits</b>, then come back here to <b>Preview</b> or <b>Download</b>.
              </div>
            </div>
          )}

          {items.map((it, fileIdx) => (
            <div key={it.jobId} style={{ marginTop: 14 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 800 }}>
                  {it.sourceName}{" "}
                  <span className="small" style={{ fontWeight: 600 }}>
                    (job: {it.jobId})
                  </span>
                </div>
                <div className="row" style={{ justifyContent: "flex-end", alignItems: "center" }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const total = Number(it?.plan?.pages?.length || 0);
                      const n = Math.max(1, Math.min(4, total || 1));
                      const pages = Array.from({ length: n }, (_, i) => i + 1);
                      openPreview(it.jobId, pages, `${it.sourceName} • Preview (first ${n})`);
                    }}
                    disabled={busy || !it.plan}
                    title="Preview the first few pages of the original PDF"
                  >
                    Preview PDF
                  </button>
                  <button className="btn" type="button" onClick={() => resetFileToOcrPlan(fileIdx)} disabled={busy}>
                    Reset
                  </button>
                  <button className="btn btnPrimary" type="button" onClick={() => resplitFileToSingles(fileIdx)} disabled={busy}>
                    Resplit (1/page)
                  </button>

                  <span className="pill">
                    {it.plan?.pages?.length || 0} pages • {it.groups?.length || 0} outputs {Number(it.plan?.vendorsAdded || 0) > 0 ? ` • new vendors: ${Number(it.plan?.vendorsAdded || 0)}` : ""}
                    {Object.keys(splitSelection?.[it.jobId] || {}).length ? ` • selected: ${Object.keys(splitSelection?.[it.jobId] || {}).length}` : ""}
                  </span>
                </div>
              </div>

              {(it.ocrApplied === false && it.ocrError) && (
                <div className="small" style={{ marginTop: 6 }}>
                  <b>OCRmyPDF:</b> not applied ({String(it.ocrError).slice(0, 180)})
                </div>
              )}

              {(() => {
                const warns = it.plan?.warnings || [];
                const critical = warns.find((w) =>
                  ["IMAGE_OCR_FAILED", "TESSDATA_MISSING", "TESSDATA_LOCAL_MISSING"].includes(String(w?.code || ""))
                );
                if (!critical) return null;
                return (
                  <div className="error" style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 800 }}>OCR could not read this PDF</div>
                    <div className="small" style={{ marginTop: 6 }}>
                      {critical.message}
                    </div>
                    <div className="small" style={{ marginTop: 6 }}>
                      Fix: open <a href="/api/health" target="_blank" rel="noreferrer">/api/health</a> and confirm <b>canvas=true</b> and <b>tessdataEng=true</b>. If tessdata is missing, run:
                      <div style={{ marginTop: 6 }}>
                        <code>server/scripts/download-eng-tessdata.ps1</code> (Windows) or <code>server/scripts/download-eng-tessdata.sh</code> (mac/linux)
                      </div>
                    </div>
                  </div>
                );
              })()}

              {it.plan?.warnings?.length ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="small">Show analysis warnings</summary>
                  <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(it.plan.warnings, null, 2)}</pre>
                </details>
              ) : null}

              {it.itemError && (
                <div className="error" style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 800 }}>This file could not be analyzed.</div>
                  <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{it.itemError}</pre>
                </div>
              )}

              {!it.itemError && !it.plan && (
                <div className="small" style={{ marginTop: 10 }}>
                  Processing… (waiting for analysis results)
                </div>
              )}

              {!it.itemError && it.plan && (it.groups || []).length === 0 && (
                <div className="error" style={{ marginTop: 10 }}>
                  No output groups were produced for this file. (This is unexpected — check the warnings above.)
                </div>
              )}

              {!it.itemError && (
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>#</th>
                      <th>Output name (vendor_invoiceNumber)</th>
                      <th style={{ width: 220 }}>Pages (editable)</th>
                      <th style={{ width: 300 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(it.groups || []).map((g, groupIdx) => (
                      <tr key={`${it.jobId}_${groupIdx}`}>
                        <td>{groupIdx + 1}</td>
                        <td>
                          <input
                            className="input"
                            value={g.suggestedStemDraft ?? g.suggestedStem ?? ""}
                            onChange={(e) => updateStemDraft(fileIdx, groupIdx, e.target.value)}
                            onBlur={() => commitStemDraft(fileIdx, groupIdx)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.currentTarget.blur();
                              }
                            }}
                            placeholder="e.g. PST Abstracting Inc 12345"
                          />
                          <div className="small" style={{ marginTop: 6 }}>
                            {(() => {
                              const raw = String(g?.suggestedStemDraft ?? g?.suggestedStem ?? "").trim();
                              const stem = toVendorInvoiceStem(raw) || "OUTPUT";
                              return (
                                <>
                                  Output: <code>{stem}.pdf</code> (in folder <code>{baseName(it.sourceName)}</code>)
                                </>
                              );
                            })()}
                          </div>
                        </td>
                        <td>
                          <input
                            className="input"
                            value={Array.isArray(g.pages) ? g.pages.join(",") : ""}
                            onChange={(e) => updatePages(fileIdx, groupIdx, e.target.value)}
                            placeholder="e.g. 5 or 5,6"
                          />
                          <div className="small" style={{ marginTop: 6 }}>
                            Current: {Array.isArray(g.pages) ? g.pages.join(", ") : ""} • ({Array.isArray(g.pages) ? g.pages.length : 0} page(s), max 2)
                          </div>
                        </td>
                        <td>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => openPreview(it.jobId, g.pages, `${it.sourceName} • #${groupIdx + 1}`)}
                          >
                            Preview
                          </button>
                          <button
                            className="btn btnPrimary"
                            type="button"
                            onClick={() => downloadSingleOutput(it.jobId, g)}
                            disabled={!Array.isArray(g.pages) || !g.pages.length}
                            title="Download this output PDF only"
                          >
                            Download
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

<div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
  <button className="btn btnPrimary" onClick={exportBatchZip} disabled={!canExport}>
    Mass Download (ZIP)
  </button>
</div>

        </div>
{preview.open && (
  <div className="modalOverlay" role="dialog" aria-modal="true" onMouseDown={closePreview}>
    <div className="modalCard" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modalHeader">
        <div className="modalTitle">{preview.title || "Preview"}</div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <a className="btn" href={preview.url} target="_blank" rel="noreferrer">Open</a>
          <button className="btn btnPrimary" onClick={closePreview} type="button">Close</button>
        </div>
      </div>
      <div className="modalBody">
        <iframe title="PDF Preview" src={preview.url} className="modalFrame" />
      </div>
      <div className="small" style={{ marginTop: 10 }}>
        If grouping looks wrong: check **Split** for the rows you want to separate, then click **Okay** for that file. You can also use **Resplit (1/page)** or edit pages manually (max 2).
      </div>
    </div>
  </div>
)}


    </div>
  );
}
