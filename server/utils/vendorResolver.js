import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { VENDOR_XLSX_PATH } from "../config.js";
import { extractInvoiceFieldsFromPdfPage } from "./invoicePdfOcr.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UNKNOWN_VENDOR_RE = /^(unknown|unknown_vendor|unknown vendor|vendor|n\/?a|na|null|undefined)$/i;

export function isUnknownVendor(value) {
  const s = String(value || "").trim();
  return !s || UNKNOWN_VENDOR_RE.test(s);
}

const FALLBACK_VENDOR_NAMES = [
  "Accusearch, Inc.",
  "ACE Global Business Services LLC",
  "ACF Search, LLC",
  "Advanced Nationwide Research, LLC.",
  "All American Document Services LLC",
  "All-Search & Inspection, Inc.",
  "ARC Information Services Inc.",
  "Axis Research, Inc",
  "Boomerang Information Services Inc",
  "Capital Filing Service, Inc.",
  "Clas Information Services",
  "Cogency Global Inc.",
  "Copeland, Franco, Screws & Gill, P.A.",
  "Corp1, Inc.",
  "Corpkit Legal Supplies",
  "Corporate Research and Analysis Centre",
  "CT Filing & Search Services, LLC",
  "Dart Legal Services, LLC",
  "Data Research, INC",
  "Delaney Corporate Services Ltd",
  "Doc-U-Search",
  "Doc-U-Search Hawaii",
  "First American Title Insurance Company",
  "Grant Morris Dodds PLLC",
  "Grayson & Grayson, LLC",
  "Griffith & Kelly, LLC",
  "Honolulu Information Service, Inc.",
  "Hudson Advertising Company",
  "IBCF",
  "Idealogic PDS Inc",
  "Incorporating Services, Ltd.",
  "Jeff City Filing",
  "John J. McManus & Associates, P.C.",
  "Joseph Lombardo",
  "JP&R Advertising Inc.",
  "Kaufman Information Resources Inc",
  "Kentucky Lenders Assistance, Inc.",
  "Liberty Corporate Services, INC.",
  "Loan Star Information Services",
  "Louisiana  Corporate & Registered Agent Services, Inc",
  "National Service Information, Inc",
  "NRAI, Inc.",
  "Paranet Corporate Services, Inc.",
  "Parasearch, Inc.",
  "Parasec",
  "Parcels, Inc.",
  "Penncorp ServiceGroup Inc.",
  "Person Enterprises",
  "Pioneer Corporate Services",
  "Pressey Corporate LLC",
  "Pro-File Document Solutions LLC",
  "PST Abstracting, Inc.",
  "Public Information Resource Inc",
  "Quest Research, Inc.",
  "Quick Data Services Incorporated",
  "RASi",
  "Rasi_NCSI",
  "Research & Retrieval Services, Inc.",
  "Search Network, Ltd.",
  "SPI Corporate Solutions, Inc.",
  "ST2, Inc. dba National Data Access Corp",
  "ST2, Inc. dba Searchtec, Inc.",
  "Statewide Corporate Research Company, Inc.",
  "Stites & Harbison, PLLC",
  "Strategic Research,LLC",
  "Sunshine State Corporate Compliance Company",
  "Synergy Corporate Services",
  "The Research Connection of N.H.",
  "Triumph Research Specialists",
  "UCC Retrievals, Inc.",
  "Wolz Corporate USA, Inc",
  "Wood Corporate Services, LLC",
  "Zook Search Inc."
];

let vendorCatalogCache = null;
let vendorCatalogLoadedFrom = null;

function squashVendorText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(
      /\b(THE|INCORPORATED|INC|LLC|L L C|LTD|LIMITED|CO|CO\.|COMPANY|CORP|CORPORATION|SERVICES|SERVICE|GROUP|P A|PA|P C|PC|PLL C|PLLC)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function buildVendorAliasSet(name) {
  const raw = String(name || "").trim();
  const squashed = squashVendorText(raw);
  const aliases = new Set([raw, squashed]);

  if (/\bCLAS\b/i.test(raw) || /\bCLASINFO\b/i.test(raw) || /CLAS INFORMATION SERVICES/i.test(raw)) {
    aliases.add("CLAS");
    aliases.add("CLASINFO");
    aliases.add("WWW CLASINFO");
    aliases.add("CLAS INFORMATION");
  }

  if (/RASI_NCSI/i.test(raw)) aliases.add("RASI NCSI");
  if (/DOC-U-SEARCH/i.test(raw)) aliases.add(raw.replace(/-/g, " "));

  return Array.from(aliases)
    .map((value) => squashVendorText(value))
    .filter(Boolean);
}

function buildVendorCatalog(names) {
  return (Array.isArray(names) ? names : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .map((name) => {
      const aliases = buildVendorAliasSet(name);
      const tokenSet = new Set(aliases.flatMap((alias) => alias.split(/\s+/g).filter(Boolean)));
      return {
        canonical: name,
        aliases,
        tokenSet
      };
    });
}

async function loadVendorCatalog() {
  if (vendorCatalogCache) return vendorCatalogCache;

  const candidates = [
    VENDOR_XLSX_PATH,
    process.env.VENDOR_LIST_PATH,
    path.join(__dirname, "Vendor List.xlsx"),
    path.resolve(__dirname, "..", "Vendor List.xlsx"),
    path.resolve(process.cwd(), "Vendor List.xlsx"),
    path.resolve(process.cwd(), "server", "Vendor List.xlsx"),
    path.resolve(process.cwd(), "data", "Vendor List.xlsx"),
    path.resolve(process.cwd(), "server", "data", "Vendor List.xlsx")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;

      const xlsx = await import("xlsx");
      const workbook = xlsx.readFile(candidate);
      const firstSheet = workbook.SheetNames?.[0];
      const sheet = firstSheet ? workbook.Sheets[firstSheet] : null;
      const rows = sheet ? xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" }) : [];
      const names = rows
        .slice(1)
        .map((row) => String(Array.isArray(row) ? row[0] || "" : "").trim())
        .filter(Boolean);

      if (names.length) {
        vendorCatalogLoadedFrom = candidate;
        vendorCatalogCache = buildVendorCatalog(names);
        return vendorCatalogCache;
      }
    } catch (err) {
      console.warn(`Vendor list load failed for ${candidate}: ${String(err?.message || err)}`);
    }
  }

  vendorCatalogLoadedFrom = "embedded-fallback";
  vendorCatalogCache = buildVendorCatalog(FALLBACK_VENDOR_NAMES);
  return vendorCatalogCache;
}

function collectVendorHints(group, ocr) {
  const out = [];

  const add = (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }

    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (/vendor|name|label|header|title|text/i.test(key)) add(entry);
      }
    }
  };

  add(group);
  add(ocr);
  return Array.from(new Set(out));
}

function scoreVendorCandidate(sample, entry) {
  const haystack = squashVendorText(sample);
  if (!haystack) return 0;

  for (const alias of entry.aliases) {
    if (haystack === alias) return 1000 + alias.length;
    if (haystack.includes(alias)) return 800 + alias.length;
  }

  const sampleTokens = new Set(haystack.split(/\s+/g).filter(Boolean));
  if (!sampleTokens.size) return 0;

  let overlap = 0;
  for (const token of entry.tokenSet) {
    if (sampleTokens.has(token)) overlap += 1;
  }

  if (!overlap) return 0;

  const ratio = overlap / Math.max(2, entry.tokenSet.size);
  if (overlap >= 2 && ratio >= 0.6) return Math.round(ratio * 100);
  return 0;
}

async function matchVendorFromHints(group, ocr = null) {
  const catalog = await loadVendorCatalog();
  const hints = collectVendorHints(group, ocr);

  let best = null;
  for (const hint of hints) {
    for (const entry of catalog) {
      const score = scoreVendorCandidate(hint, entry);
      if (!score) continue;
      if (!best || score > best.score) {
        best = {
          canonical: entry.canonical,
          matchedFrom: hint,
          score
        };
      }
    }
  }

  return best;
}

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
    const starts = cleaned.startsWith(letters);
    const ends = cleaned.endsWith(letters);
    if (cleaned === letters) return letters;
    if (!(starts || ends)) return "";
  }

  if (cleaned.includes("-")) {
    const [a, b] = cleaned.split("-", 2);
    const aDigits = String(a || "").replace(/\D+/g, "");
    const bDigits = String(b || "").replace(/\D+/g, "");
    if (!aDigits || aDigits.length < 2 || !bDigits || bDigits.length < 1) {
      cleaned = `${a || ""}${b || ""}`;
    }
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
    const keepLeading = letters && cleaned.startsWith(letters);
    const keepTrailing = letters && cleaned.endsWith(letters);
    const truncated = digits.slice(0, 16);
    return `${keepLeading ? letters : ""}${truncated}${keepTrailing ? letters : ""}`;
  }

  return cleaned.length > 18 ? digits : cleaned;
}

function toVendorDisplayName(vendorLike) {
  const s0 = String(vendorLike || "").trim();
  if (!s0) return "";

  const s = s0
    .replace(/[\/\?%*:|"<>]/g, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";
  if (/[a-z]/.test(s)) return s;

  return s
    .split(/\s+/g)
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) return token;
      if (/^[A-Z]{1,4}$/.test(token)) return token;
      return token.charAt(0) + token.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickInvoiceNumber(group) {
  const candidates = [
    group?.invoiceNumber,
    group?.invoiceNo,
    group?.invoiceNum,
    group?.invoice,
    group?.invoice_number,
    group?.INVOICENUMBER,
    group?.invoiceId
  ];

  for (const candidate of candidates) {
    const normalized = normalizeInvoiceNumber(candidate);
    if (normalized) return normalized;
  }

  return "";
}

function buildVendorOutputStem(group, vendorName) {
  const vendorDisplay = toVendorDisplayName(vendorName) || "Unknown Vendor";
  const invoiceNumber = pickInvoiceNumber(group);
  return `${vendorDisplay}_${invoiceNumber || "unknownInvoice"}`;
}

function applyVendorToGroup(group, vendorLike) {
  const next = { ...(group || {}) };
const vendorNorm = String(
  vendorLike?.vendorNorm ||
  vendorLike?.vendorName ||
  vendorLike?.vendorRaw ||
  vendorLike?.canonical ||
  ""
).trim();

const vendorRaw = String(
  vendorLike?.vendorRaw ||
  vendorLike?.matchedFrom ||
  vendorLike?.vendorMatchedFrom ||
  vendorLike?.vendorName ||
  vendorNorm ||
  ""
).trim();

  if (!vendorNorm) return next;

  const outputStem = buildVendorOutputStem(next, vendorNorm);

  next.vendorRaw = vendorRaw || next.vendorRaw || "";
  next.vendorNorm = vendorNorm;
  next.vendorName = vendorNorm;
  next.VENDORNAME = vendorNorm;
  next.vendor = vendorNorm;
  next.vendorMatched = Boolean(vendorLike?.vendorMatched ?? true);
  next.vendorConfidence = Number(vendorLike?.vendorConfidence ?? vendorLike?.score ?? next.vendorConfidence ?? 0);
  if (vendorLike?.matchedFrom) next.vendorMatchedFrom = vendorLike.matchedFrom;

  next.suggestedStem = outputStem;
  if (!next.stem || /UNKNOWN_VENDOR|Unknown Vendor/i.test(String(next.stem || ""))) next.stem = outputStem;
  if (!next.outputName || /UNKNOWN_VENDOR|Unknown Vendor/i.test(String(next.outputName || ""))) next.outputName = outputStem;
  if (!next.downloadName || /UNKNOWN_VENDOR|Unknown Vendor/i.test(String(next.downloadName || ""))) next.downloadName = outputStem;
  if (!next.suggestedName || /UNKNOWN_VENDOR|Unknown Vendor/i.test(String(next.suggestedName || ""))) next.suggestedName = outputStem;

  for (const key of ["name", "fileName", "filename"]) {
    const current = String(next?.[key] || "");
    if (!current || /UNKNOWN_VENDOR|Unknown Vendor/i.test(current)) {
      next[key] = outputStem;
    }
  }

  return next;
}

function buildPageVendorOutput(plan) {
  const byPage = new Map();

  const put = (pageNumber, vendorLike, source = "") => {
    const page = Number(pageNumber);
    if (!Number.isFinite(page) || page < 1) return;

    const vendorName = String(
      vendorLike?.vendorName || vendorLike?.vendorNorm || vendorLike?.vendorRaw || vendorLike?.vendor || ""
    ).trim();

    const current = byPage.get(page) || {
      page,
      pageIndex: page,
      vendorName: "Unknown Vendor",
      vendorNorm: "UNKNOWN_VENDOR",
      source: source || "derived"
    };

    const nextName = vendorName || current.vendorName || "Unknown Vendor";
    const nextNorm = String(
      vendorLike?.vendorNorm || vendorLike?.vendorName || vendorLike?.vendorRaw || current.vendorNorm || "UNKNOWN_VENDOR"
    ).trim() || "UNKNOWN_VENDOR";

    const next = {
      ...current,
      page,
      pageIndex: page,
      vendorName: nextName,
      vendorNorm: nextNorm,
      vendorRaw: String(vendorLike?.vendorRaw || current.vendorRaw || nextName || "").trim(),
      source: source || current.source || "derived"
    };

    const nextUnknown = isUnknownVendor(next.vendorName) && isUnknownVendor(next.vendorNorm);
    const curUnknown = isUnknownVendor(current.vendorName) && isUnknownVendor(current.vendorNorm);
    if (
      !byPage.has(page) ||
      (curUnknown && !nextUnknown) ||
      (current.source === "page" && source === "group" && !nextUnknown) ||
      source === "group"
    ) {
      byPage.set(page, next);
    }
  };

  for (const page of plan?.pages || []) put(page?.pageIndex, page, "page");
  for (const group of plan?.groups || []) {
    for (const pageNumber of Array.isArray(group?.pages) ? group.pages : []) {
      put(pageNumber, group, "group");
    }
  }

  return Array.from(byPage.values()).sort((a, b) => (a.page || 0) - (b.page || 0));
}

async function enrichPlanWithVendorOcr({ plan, pdfPath, jobId, onProgress }) {
  if (!plan || !Array.isArray(plan.groups)) return plan;

  await loadVendorCatalog();

  const groups = [];
  const total = plan.groups.length;

  for (let i = 0; i < total; i += 1) {
    let group = { ...(plan.groups[i] || {}) };
    const vendorSeed = group.vendorNorm || group.vendorName || group.vendorRaw || group.vendor || "";
    const firstPage = Array.isArray(group.pages) && group.pages.length ? Number(group.pages[0]) : null;

    if (!isUnknownVendor(vendorSeed) && vendorSeed) {
      const matchedExisting = await matchVendorFromHints({ vendorRaw: vendorSeed, vendorName: vendorSeed, ...group });
      if (matchedExisting?.canonical) {
        group = applyVendorToGroup(group, {
          vendorNorm: matchedExisting.canonical,
          vendorRaw: matchedExisting.matchedFrom || vendorSeed,
          vendorMatched: true,
          vendorConfidence: matchedExisting.score,
          matchedFrom: matchedExisting.matchedFrom
        });
      }
      groups.push(group);
      continue;
    }

    const matchedBeforeOcr = await matchVendorFromHints(group);
    if (matchedBeforeOcr?.canonical) {
      group = applyVendorToGroup(group, {
        vendorNorm: matchedBeforeOcr.canonical,
        vendorRaw: matchedBeforeOcr.matchedFrom,
        vendorMatched: true,
        vendorConfidence: matchedBeforeOcr.score,
        matchedFrom: matchedBeforeOcr.matchedFrom
      });
      groups.push(group);
      continue;
    }

    if (!pdfPath || !Number.isFinite(firstPage) || firstPage < 1) {
      groups.push(group);
      continue;
    }

    try {
      onProgress?.({
        current: i + 1,
        total,
        firstPage,
        message: `Resolving vendor for invoice ${i + 1}/${total} from page ${firstPage}`
      });

      const ocr = await extractInvoiceFieldsFromPdfPage({
        pdfPath,
        pageNumber: firstPage
      });

      const matchedAfterOcr = await matchVendorFromHints(group, ocr);
      if (matchedAfterOcr?.canonical) {
        group = applyVendorToGroup(group, {
          vendorNorm: matchedAfterOcr.canonical,
          vendorRaw: matchedAfterOcr.matchedFrom || ocr?.vendorRaw || ocr?.vendorNorm,
          vendorMatched: true,
          vendorConfidence: matchedAfterOcr.score,
          matchedFrom: matchedAfterOcr.matchedFrom
        });
      } else if (ocr?.vendorNorm || ocr?.vendorRaw || ocr?.vendorName) {
        group = applyVendorToGroup(group, {
          ...ocr,
          vendorNorm: ocr?.vendorNorm || ocr?.vendorName || "",
          vendorRaw: ocr?.vendorRaw || ocr?.vendorMatchedFrom || ocr?.vendorName || ""
        });
      }
    } catch (err) {
      console.error(
        `Vendor OCR enrich failed for job ${jobId || "(unknown)"} group ${i + 1} page ${firstPage}:`,
        err
      );
    }

    groups.push(group);
  }

  return {
    ...plan,
    vendorCatalogSource: vendorCatalogLoadedFrom,
    groups,
    pageVendors: buildPageVendorOutput({ ...plan, groups })
  };
}

export function getVendorCatalogSource() {
  return vendorCatalogLoadedFrom || "not-loaded";
}

export {
  enrichPlanWithVendorOcr,
  loadVendorCatalog,
  normalizeInvoiceNumber,
  toVendorDisplayName,
  applyVendorToGroup,
  buildPageVendorOutput
};