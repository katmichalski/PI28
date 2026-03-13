import { normalizeVendorName, normalizeInvoiceNumber, cleanVendorForStem, toVendorDisplayName, isBlacklistedVendorCandidate } from "./normalize.js";
import { diceCoefficient } from "./similarity.js";
import { vendorOverrideFromAddress } from "./vendorAddressOverrides.js";

// Hardened label detection so header fields like "Invoice Date" are NEVER treated as vendor names.
// Handles common OCR confusions (l/1/| -> i, 0 -> o) and fuzzy similarity.
const _BAD_VENDOR_LABELS = [
  "date",
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
  "balance due",
  "customer",
  "account",
  "account number"
];

// If an invoice includes a line-items table with a "Description" column, ignore everything
// under it when extracting *header* fields (vendor + invoice number).
// Some formats start the table very high; line-item numbers/text can confuse detection.
function stripAfterDescriptionHeader(text) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;

  const lines = raw
    .replace(/\r/g, "\n")
    .replace(/[|·•]/g, "\n")
    .split(/\n/)
    .map((l) => String(l || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!lines.length) return raw;

  const otherCols = [
    "qty",
    "quantity",
    "unit",
    "price",
    "rate",
    "amount",
    "total",
    "extended",
    "ext",
    "item",
    "part",
    "sku",
    "product",
    "tax"
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = _normalizeLabelCandidate(line);
    if (!n) continue;

    const hasDesc = /\b(description|desc)\b/.test(n);
    if (!hasDesc) continue;

    const hasOther = otherCols.some((w) => new RegExp(`\\b${w}\\b`, "i").test(n));
    const isBare = /^description\b/.test(n) || /^desc\b/.test(n);

    // If we see a description header (alone or alongside other column words), drop everything after it.
    if (hasOther || isBare) {
      return lines.slice(0, i).join("\n").trim();
    }
  }

  return raw;
}

// More general table header cutoff: if a line looks like a column-header row (even without "Description"),
// ignore everything under it when extracting header fields.
function stripAfterTableHeader(text) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;

  const lines = raw
    .replace(/\r/g, "\n")
    .replace(/[|·•]/g, "\n")
    .split(/\n/)
    .map((l) => String(l || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!lines.length) return raw;

  const colWords = [
    "description",
    "desc",
    "qty",
    "quantity",
    "unit",
    "unit price",
    "price",
    "rate",
    "amount",
    "item",
    "part",
    "sku",
    "product",
    "tax",
    "extended",
    "ext",
    "hours",
    "hrs",
    "service",
    "charge"
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = _normalizeLabelCandidate(line);
    if (!n) continue;

    // Count distinct column-ish hits in the line
    let hits = 0;
    for (const w of colWords) {
      if (w.includes(" ")) {
        if (n.includes(w)) hits += 1;
      } else {
        if (new RegExp(`\\b${w}\\b`, "i").test(n)) hits += 1;
      }
    }

    // Heuristic: accept if DESCRIPTION/DESC is present, or if there are >=2 column-ish tokens.
    const hasDesc = /\b(description|desc)\b/.test(n);
    if (hasDesc || hits >= 2) {
      return lines.slice(0, i).join("\n").trim();
    }
  }

  return raw;
}

// Remove contact/fax/phone lines and strip any trailing "TEL ..."/"FAX ..." tails from lines.
// This prevents phone/fax numbers from being mistaken as invoice numbers or vendors.
function stripContactTail(text) {
  const raw = String(text || "");
  if (!raw.trim()) return raw;

  const lines = raw
    .replace(/\r/g, "\n")
    .split(/\n/)
    .map((l) => String(l || "").trim())
    .filter(Boolean);

  const out = [];
  let prevWasContact = false;

  for (const line of lines) {
    const key = line.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();

    // If OCR splits "TEL" / "FAX" onto its own line, we should also ignore the next line
    // when it looks like a phone/fax number.
    if (/^(TEL|FAX|PHONE|TELEPHONE)\b/.test(key)) {
      prevWasContact = true;
      continue;
    }

    const digitsOnly = line.replace(/[^0-9]+/g, "");
    const lettersOnly = line.replace(/[^A-Za-z]+/g, "");
    const looksLikePhoneNumber = !lettersOnly && digitsOnly.length >= 7 && digitsOnly.length <= 15;

    if (prevWasContact && looksLikePhoneNumber) {
      prevWasContact = false;
      continue;
    }
    prevWasContact = false;

    // If TEL/FAX appears later in the line, drop the tail after it.
    const stripped = line.replace(/\b(?:TEL|FAX|PHONE|TELEPHONE)\b[\s\S]*$/i, "").trim();
    if (stripped) out.push(stripped);
  }

  return out.join("\n").trim();
}


// Last-resort vendor hint: extract a website/domain from text (e.g., "www.acme.com", "https://acme.co", "ACME.COM")
// Returns a host like "acme.com" or "acme.co.uk" (no protocol/path, no www).
function extractWebsiteVendorCandidate(text) {
  const t = String(text || "");
  if (!t.trim()) return "";

  // Capture protocol or bare domains. Avoid picking emails (handled elsewhere) by rejecting '@' in the match.
  const re = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9\-]{0,62}(?:\.[a-z0-9][a-z0-9\-]{0,62})+)(?:\/[^\s]*)?\b/ig;

  const candidates = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const host = String(m[1] || "").toLowerCase().trim();
    if (!host) continue;
    if (host.includes("@")) continue;

    // Ignore obvious non-vendor tech/placeholder domains
    if (/\b(localhost|example\.com|example\.org|example\.net)\b/.test(host)) continue;

    candidates.push(host);
  }

  if (!candidates.length) return "";

  // Prefer the shortest plausible domain (often the real vendor), but not too short.
  candidates.sort((a, b) => a.length - b.length);
  const best = candidates.find((h) => h.length >= 6) || candidates[0];

  // Strip leading www (already) and trailing punctuation
  return best.replace(/\.+$/g, "");
}

function _normalizeLabelCandidate(line) {
  const n0 = String(line || "")
    .replace(/_/g, " ")
    .replace(/[#:]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!n0) return "";

  // Common OCR swaps: l/1/|/! -> i, 0 -> o. Keep this mapping ONLY for label checks.
  // Also fix leading "lnvoice" -> "invoice".
  return n0
    .replace(/^l(?=nvoice\b)/, "i")
    .replace(/[|!]/g, "i")
    .replace(/1/g, "i")
    .replace(/0/g, "o")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeVendorLabel(line) {
  const n = _normalizeLabelCandidate(line);
  if (!n) return true;

  // Exact labels
  if (_BAD_VENDOR_LABELS.includes(n)) return true;

  // Starts-with labels (often followed by a date/number)
  if (/^(invoice\s*(date|number|no|#)|inv\s*#|due\s*date|bill\s*to|ship\s*to|remit\s*to)\b/.test(n)) return true;

  // "InvoiceDate" without space (after normalization it becomes invoice date, but keep a guard)
  if (/^invoicedate\b/.test(n.replace(/\s+/g, ""))) return true;

  // Fuzzy match against label list to catch minor OCR typos (e.g., "invoic date")
  const a = n.replace(/\s+/g, "");
  for (const lbl of _BAD_VENDOR_LABELS) {
    const b = lbl.replace(/\s+/g, "");
    const score = diceCoefficient(a, b);
    if (score >= 0.88) return true;
  }

  return false;
}

// If a header line contains an ampersand ("X & Y"), ensure we never return a vendor name
// that only includes one side (e.g., matching "X" from the vendor list when the header shows "X & Y").
// This prevents partial vendor matches on partnership-style names.
function _ampSideTokens(side) {
  const stop = new Set([
    "THE",
    "INCORPORATED",
    "INC",
    "LLC",
    "LTD",
    "LIMITED",
    "CORP",
    "CORPORATION",
    "CO",
    "COMPANY"
  ]);
  return String(side || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((t) => !stop.has(t));
}

function _buildAmpConstraints(text) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n|\||·|•/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40);

  const out = [];
  for (const l of lines) {
    if (!l.includes("&")) continue;
    const parts = l.split("&");
    if (parts.length < 2) continue;
    const left = _ampSideTokens(parts[0]);
    const right = _ampSideTokens(parts.slice(1).join("&"));
    // If either side becomes empty after stripping common suffixes, don't enforce the rule.
    if (!left.length || !right.length) continue;
    out.push({
      line: l,
      ampNorm: normalizeVendorName(l).replace(/_+/g, "_"),
      left: new Set(left),
      right: new Set(right)
    });
  }
  return out;
}

function _passesAmpersandRule(vendorNorm, normText, ampConstraints) {
  if (!vendorNorm || !ampConstraints || !ampConstraints.length) return true;
  const vToks = new Set(String(vendorNorm).split("_").filter(Boolean));

  for (const c of ampConstraints) {
    // Only enforce if this vendor match appears within the ampersand line segment.
    if (!c?.ampNorm) continue;
    if (!normText.includes(c.ampNorm)) continue;
    if (!c.ampNorm.includes(vendorNorm)) continue;

    let leftOk = false;
    let rightOk = false;
    for (const t of c.left) if (vToks.has(t)) { leftOk = true; break; }
    for (const t of c.right) if (vToks.has(t)) { rightOk = true; break; }

    if (!(leftOk && rightOk)) return false;
  }
  return true;
}

// Many scanned invoices OCR as a multi-line "company + address" block.
// The company name almost always appears BEFORE the street/city/state/zip.
// This extractor returns the best "company" line *without* any address lines.
function extractCompanyNameFromAddressBlock(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";

  const lines = raw
    .replace(/\r/g, "\n")
    .split(/\n|\||·|•/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((l) => !isBlacklistedVendorCandidate(l))
    .slice(0, 20);

  if (!lines.length) return "";

  // Address-ish detectors
  const phoneRe = /\b(?:\+?1[\s\-\.]*)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/;
  const emailWebRe = /@|\bwww\.|\.(com|net|org|io|co)\b/i;
  const poBoxRe = /\bP\.?\s*O\.?\s*BOX\b|\bPO\s*BOX\b/i;
  const zipRe = /\b\d{5}(?:-\d{4})?\b/;
  const stateZipRe = /\b[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/;
  const cityStateZipRe = /,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/;
  const streetSuffixRe = /\b(?:ST|ST\.|STREET|RD|RD\.|ROAD|AVE|AVE\.|AVENUE|BLVD|BLVD\.|BOULEVARD|DR|DR\.|DRIVE|LN|LN\.|LANE|CT|CT\.|COURT|CIR|CIR\.|CIRCLE|HWY|HWY\.|HIGHWAY|PKWY|PKWY\.|PARKWAY|PL|PL\.|PLACE|WAY|TER|TER\.|TERRACE|TRL|TRL\.|TRAIL|PIKE|PLAZA|PLZ|SQ|SQ\.|SQUARE)\b/i;
  const unitRe = /\b(?:SUITE|STE\.?|APT|UNIT|FLOOR|FL\.?|BLDG|BUILDING|RM|ROOM)\b/i;
  const startsWithStreetNumberRe = /^\d{1,6}\s+[A-Z0-9]/i;

  const looksAddressLine = (line) => {
    if (!line) return false;
    if (looksLikeVendorLabel(line)) return true;
    if (phoneRe.test(line)) return true;
    if (emailWebRe.test(line)) return true;
    if (poBoxRe.test(line)) return true;
    if (cityStateZipRe.test(line)) return true;
    if (stateZipRe.test(line)) return true;
    if (zipRe.test(line) && /\d/.test(line) && line.length <= 22) return true;

    // Street line heuristics: street number + suffix, or suffix + digits
    if (startsWithStreetNumberRe.test(line) && (streetSuffixRe.test(line) || unitRe.test(line))) return true;
    if (streetSuffixRe.test(line) && /\d{1,6}/.test(line)) return true;
    if (unitRe.test(line) && /\d{1,5}/.test(line)) return true;

    // Mostly digits/punct => not a vendor
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (digits >= 6 && digits >= letters) return true;

    return false;
  };

  // Find the first address-like line; everything before it is "company block".
  let addrStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (looksAddressLine(lines[i])) {
      addrStart = i;
      break;
    }
  }

  const head = lines.slice(0, addrStart);
  if (!head.length) return "";

  const good = head
    .filter((l) => !looksLikeVendorLabel(l))
    .filter((l) => !/\b(INVOICE|STATEMENT|PACKING\s*SLIP|PURCHASE\s*ORDER|ORDER\s*FORM)\b/i.test(l))
    .filter((l) => !phoneRe.test(l) && !emailWebRe.test(l))
    .filter((l) => (l.match(/[A-Za-z]/g) || []).length >= 2);

  if (!good.length) return "";

  // Prefer letters > digits and not overly long.
  const best =
    good.find((l) => {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      const digits = (l.match(/\d/g) || []).length;
      return letters >= 3 && digits < letters && l.length <= 60;
    }) || good[0];

  return best.trim();
}

// Address-to-vendor overrides now live in ./vendorAddressOverrides.js

/**
 * Invoice number rules from your spec:
 * - digits only (no letters, no '.')
 * - commonly found near "INVOICE #" / "Invoice #"
 */
/**
 * Invoice number rules from your spec:
 * - digits only, with optional single hyphen '-'
 * - at most 16 digits total (hyphen not counted)
 * - typically appears on the RIGHT side, top third of the page
 * - then check middle, then left; fallback to full page text
 * - commonly found near "INVOICE #" / "Invoice #"
 */
export function findInvoiceNumber(input) {
  // input can be a string OR an object with region texts.
  const regions =
    typeof input === "object" && input
      ? {
          right: input.right || input.aboveTableRightText || input.topRightText || "",
          middle: input.middle || input.aboveTableMiddleText || input.topMiddleText || "",
          left: input.left || input.aboveTableLeftText || input.topLeftText || "",
          full: input.full || input.text || ""
        }
      : { right: "", middle: "", left: "", full: String(input || "") };

  // Ignore line-items content under a Description column (table) if present.
  regions.right = stripAfterDescriptionHeader(regions.right);
  regions.right = stripAfterTableHeader(regions.right);
  regions.middle = stripAfterDescriptionHeader(regions.middle);
  regions.middle = stripAfterTableHeader(regions.middle);
  regions.left = stripAfterDescriptionHeader(regions.left);
  regions.left = stripAfterTableHeader(regions.left);
  regions.full = stripAfterDescriptionHeader(regions.full);
  regions.full = stripAfterTableHeader(regions.full);
// Remove TEL/FAX/PHONE lines so contact numbers are never treated as invoice numbers.
regions.right = stripContactTail(regions.right);
regions.middle = stripContactTail(regions.middle);
regions.left = stripContactTail(regions.left);
regions.full = stripContactTail(regions.full);

  const tryFind = (text) => {
    if (!text) return "";
    const t = String(text);

    // Prioritize labeled invoice number patterns
    const patterns = [
      // Common: "Invoice Number:", "Invoice Number No.:", "Invoice No.", "Invoice #", etc.
      // Accept variants where "No./#/Number" may appear after INVOICE or after INVOICE NUMBER.
      /\b(?:INVOICE\s+NUMBER(?:\s*(?:NO\.?|#|N°|Nº))?|INVOICE\s*(?:NO\.?|#|NUMBER|NUM(?:BER)?|N°|Nº)|INV(?:OICE)?\s*(?:NO\.?|#|NUMBER|NUM(?:BER)?|N°|Nº))\b\s*[:\-]?\s*([A-Z0-9][A-Z0-9\- ]{0,32})\b/i,

      // Also: "Invoice:" (label only) where number follows directly
      /\bINVOICE\b\s*[:\-]\s*([A-Z0-9][A-Z0-9\- ]{0,32})\b/i,

      // Also: "Invoice:" on one line and number on the next line
      /\bINVOICE\b\s*[:\-]?\s*(?:\r?\n\s*)([A-Z0-9][A-Z0-9\- ]{0,32})\b/i,

      // Sometimes label is split: "Invoice" ... "No." nearby
      /\bINVOICE\b(?:\s+NUMBER)?\s+(?:NO\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\- ]{0,32})\b/i
    ];

    for (const re of patterns) {
      const m = t.match(re);
      if (m?.[1]) {
        const normalized = normalizeInvoiceNumber(m[1]);
        if (normalized) return normalized;
      }
    }

    // Fallback: a clean digit/hyphen run (still normalized)
    const runs = t.match(/\b[0-9][0-9\-]{1,32}\b/g);
    if (runs?.length) {
      for (const r of runs) {
        const normalized = normalizeInvoiceNumber(r);
        if (normalized) return normalized;
      }
    }

    // Fallback (updated): allow a SINGLE letter attached to digits (e.g., 1V, 123A, A123, 12-345A)
    // Keep this after the digit-only scan to reduce false positives.
    const runsAlpha = t.match(/\b(?:[A-Z]\d{1,16}|\d{1,16}[A-Z]|[A-Z]\d{2,16}-\d{1,16}|\d{2,16}-\d{1,16}[A-Z])\b/gi);
    if (runsAlpha?.length) {
      for (const r of runsAlpha) {
        const normalized = normalizeInvoiceNumber(r);
        if (normalized) return normalized;
      }
    }

    return "";
  };

  // Search order per requirement: right -> middle -> left -> full
  return (
    tryFind(regions.right) ||
    tryFind(regions.middle) ||
    tryFind(regions.left) ||
    tryFind(regions.full)
  );
}

/**
 * Vendor:
 * - Prefer matching from vendor list (normalized contains).
 * - Otherwise guess from top lines.
 */
/**
 * Vendor:
 * - Prefer matching from vendor list (normalized contains).
 * - For scanned/image invoices: vendor is usually TOP LEFT or TOP MIDDLE of the top third.
 * - We also support "topVendorText" (wide crop over left 2/3 of top third).
 */
/**
 * Vendor:
 * - Prefer exact/contains match from vendor list (normalized contains).
 * - If OCR is messy, do fuzzy match against vendor list (Dice coefficient on bigrams).
 * - Vendor is usually TOP LEFT or TOP MIDDLE of the top third for scanned invoices.
 */

export function findVendor(input, vendorIndex) {
  const regions =
    typeof input === "object" && input
      ? {
          topFull: input.aboveTableFullText || input.topFullText || input.fullTopText || "",
          topFullBold: input.aboveTableFullBoldText || input.topFullBoldText || "",
          topVendor: input.aboveTableVendorText || input.topVendorText || "",
          topVendorBold: input.aboveTableVendorBoldText || input.topVendorBoldText || "",
          topLeft: input.aboveTableLeftText || input.topLeftText || input.left || "",
          topLeftBold: input.aboveTableLeftBoldText || input.topLeftBoldText || "",
          topMiddle: input.aboveTableMiddleText || input.topMiddleText || input.middle || "",
          topMiddleBold: input.aboveTableMiddleBoldText || input.topMiddleBoldText || "",
          topRight: input.aboveTableRightText || input.topRightText || input.right || "",
          topRightBold: input.aboveTableRightBoldText || input.topRightBoldText || "",
          // "full" is the text we use for normal header/vendor heuristics (often intentionally header-only).
          full: input.full || input.text || "",
          // "fullRaw" is *untrimmed* context (optionally includes lower-page text) used ONLY for
          // address-to-vendor overrides.
          fullRaw: input.fullRaw || input.full || input.text || ""
        }
      : {
          topFull: "",
          topFullBold: "",
          topVendor: "",
          topVendorBold: "",
          topLeft: "",
          topLeftBold: "",
          topMiddle: "",
          topMiddleBold: "",
          topRight: "",
          topRightBold: "",
          full: String(input || ""),
          fullRaw: String(input || "")
        };

  // Preserve a raw copy of full text BEFORE we strip table content.
  // This is critical for address-based vendor overrides, because mailing addresses
  // (e.g., remit-to blocks) often appear below the line-items table.
  regions.fullRaw = String(regions.fullRaw || "");
  // Ignore any table/line-items content when extracting header fields.
  // Prefer cutting at a Description column header; otherwise cut at any column-header row.
  regions.topVendor = stripAfterDescriptionHeader(regions.topVendor);
  regions.topVendor = stripAfterTableHeader(regions.topVendor);
  regions.topFull = stripAfterDescriptionHeader(regions.topFull);
  regions.topFull = stripAfterTableHeader(regions.topFull);
  regions.topLeft = stripAfterDescriptionHeader(regions.topLeft);
  regions.topLeft = stripAfterTableHeader(regions.topLeft);
  regions.topMiddle = stripAfterDescriptionHeader(regions.topMiddle);
  regions.topMiddle = stripAfterTableHeader(regions.topMiddle);
  regions.topRight = stripAfterDescriptionHeader(regions.topRight);
  regions.topRight = stripAfterTableHeader(regions.topRight);
  regions.full = stripAfterDescriptionHeader(regions.full);
  regions.full = stripAfterTableHeader(regions.full);

  regions.topVendorBold = stripAfterDescriptionHeader(regions.topVendorBold);
  regions.topVendorBold = stripAfterTableHeader(regions.topVendorBold);
  regions.topFullBold = stripAfterDescriptionHeader(regions.topFullBold);
  regions.topFullBold = stripAfterTableHeader(regions.topFullBold);
  regions.topLeftBold = stripAfterDescriptionHeader(regions.topLeftBold);
  regions.topLeftBold = stripAfterTableHeader(regions.topLeftBold);
  regions.topMiddleBold = stripAfterDescriptionHeader(regions.topMiddleBold);
  regions.topMiddleBold = stripAfterTableHeader(regions.topMiddleBold);
  regions.topRightBold = stripAfterDescriptionHeader(regions.topRightBold);
  regions.topRightBold = stripAfterTableHeader(regions.topRightBold);

  // Remove TEL/FAX/PHONE tails from header regions so contact numbers don't become candidates.
  regions.topVendor = stripContactTail(regions.topVendor);
  regions.topFull = stripContactTail(regions.topFull);
  regions.topLeft = stripContactTail(regions.topLeft);
  regions.topMiddle = stripContactTail(regions.topMiddle);
  regions.topRight = stripContactTail(regions.topRight);
  regions.full = stripContactTail(regions.full);

  regions.topVendorBold = stripContactTail(regions.topVendorBold);
  regions.topFullBold = stripContactTail(regions.topFullBold);
  regions.topLeftBold = stripContactTail(regions.topLeftBold);
  regions.topMiddleBold = stripContactTail(regions.topMiddleBold);
  regions.topRightBold = stripContactTail(regions.topRightBold);
  // NOTE: Bold/large-font lines can be helpful, but they are NOT automatically the vendor.
  // We treat bold as a weak signal (tie-breaker) and still require the line to look like a vendor.
  // IMPORTANT: start vendor search from TOP-LEFT first, then widen as needed.
  const boldTopLeftText = regions.topLeftBold || "";
  const boldTopVendorText = regions.topVendorBold || "";
  const boldTopMiddleText = regions.topMiddleBold || "";
  const boldTopRightText = regions.topRightBold || "";
  const boldTopFullText = regions.topFullBold || "";

  const topLeftText = regions.topLeft || "";
  const topVendorText = regions.topVendor || "";
  const topMiddleText = regions.topMiddle || "";
  const topRightText = regions.topRight || "";
  const topFullText = regions.topFull || "";

  // Prefer full-width header text when available: it preserves reading order.
  // Required scan order: TOP-LEFT -> TOP-RIGHT, then restart at the left on the next line down.
  // Avoid duplicating regions after topFull, because that can scramble the "earliest match" logic.
  const boldPrimaryText =
    (boldTopFullText || "").trim() ||
    [boldTopLeftText, boldTopMiddleText, boldTopRightText, boldTopVendorText].filter(Boolean).join("\n").trim();

  const primaryText =
    (topFullText || "").trim() ||
    [topLeftText, topMiddleText, topRightText, topVendorText].filter(Boolean).join("\n").trim();
  const fullText = regions.full || "";
  const fullRawText = regions.fullRaw || "";

  // Collect any ampersand partnership-style lines from the header regions (prefer bold), and fall back to full text.
  // Used to prevent partial vendor matches like returning only the left/right side of "X & Y".
  const ampConstraints = _buildAmpConstraints(boldPrimaryText || primaryText || fullText);

  // If a vendor name contains the word "services", ensure we don't return a truncated/over-generic
  // match like just "SERVICES" when the invoice header shows a longer name (e.g., "ACME PROFESSIONAL SERVICES").
  // Rule: if "SERVICES" appears, include all words that appear before it in the *same header line*.
  const _servicesToken = (tok) => tok === "SERVICES" || tok === "SERVICE";
  const _prefixToServices = (norm) => {
    const toks = String(norm || "").split("_").filter(Boolean);
    const idx = toks.findIndex(_servicesToken);
    if (idx < 0) return "";
    return toks.slice(0, idx + 1).join("_");
  };
  const _sliceLineToServicesWord = (line) => {
    const s = String(line || "");
    if (!s) return "";
    const re = /\bservices\b/i;
    const m = re.exec(s);
    if (!m) return "";
    const end = (m.index || 0) + m[0].length;
    return s.slice(0, end).replace(/[\s,.;:\-]+$/g, "").trim();
  };
  const _expandServicesPrefixFromText = (matchedNorm, sourceText) => {
    const basePrefix = _prefixToServices(matchedNorm);
    if (!basePrefix) return null;

    const baseToks = basePrefix.split("_").filter(Boolean);
    const baseSet = new Set(baseToks);
    const minExtra = baseToks.length === 1 ? 1 : 0; // If we only matched "SERVICES", require at least one word before it.

    const lines = String(sourceText || "")
      .replace(/\r/g, "\n")
      .split(/\n|\||·|•/)
      .map((x) => String(x || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 60);

    let best = null;
    for (const line of lines) {
      if (!/\bservices\b/i.test(line)) continue;
      if (looksLikeVendorLabel(line)) continue;
      if (isBlacklistedVendorCandidate(line)) continue;

      const normLine = normalizeVendorName(line).replace(/_+/g, "_");
      const prefix = _prefixToServices(normLine);
      if (!prefix) continue;

      const pToks = prefix.split("_").filter(Boolean);
      if (pToks.length < baseToks.length + minExtra) continue;

      // Require all tokens from the matched prefix to be present in the candidate prefix.
      const pSet = new Set(pToks);
      let ok = true;
      for (const t of baseSet) {
        if (!pSet.has(t)) { ok = false; break; }
      }
      if (!ok) continue;

      // Prefer the longest prefix (more words before SERVICES).
      const score = pToks.length * 10 + prefix.length;
      if (!best || score > best.score) {
        best = { line, prefix, score };
      }
    }

    if (!best) return null;
    const raw = _sliceLineToServicesWord(best.line) || best.line;
    const norm = best.prefix;
    if (!norm || norm.length < 3) return null;
    return { vendorRaw: raw, vendorNorm: norm, expandedServices: true };
  };


  const map = vendorIndex && vendorIndex.map ? vendorIndex.map : vendorIndex; // fallback Map
  const entries = vendorIndex && Array.isArray(vendorIndex.entries) ? vendorIndex.entries : null;

  // "United Corporate Services, Inc." should only be used as a LAST RESORT.
  const _UCS_TOKEN = "UNITED_CORPORATE_SERVICES";
  const _isUCS = (normOrRaw) => String(normOrRaw || "").includes(_UCS_TOKEN);

  const _canonicalUcsNorm = (() => {
    let best = "";
    if (map && map.size) {
      for (const [vn] of map.entries()) {
        if (!vn) continue;
        if (!_isUCS(vn)) continue;
        if (!best || vn.length < best.length) best = vn;
      }
    }
    return best || _UCS_TOKEN;
  })();

  let _ucsCandidate = null;
  const _rememberUCS = () => {
    if (_ucsCandidate) return;
    const has = !!(map && map.size && map.has(_canonicalUcsNorm));
    const raw = has ? (map.get(_canonicalUcsNorm) || "United Corporate Services, Inc.") : "United Corporate Services, Inc.";
    _ucsCandidate = { vendorRaw: raw, vendorNorm: _canonicalUcsNorm, matched: has, lastResortUCS: true };
  };

  // If the OCR/text contains a bulk address block, extract the company name from the leading lines.
  // Prefer bold/large-font lines first.
  let extractedCompany = extractCompanyNameFromAddressBlock(boldPrimaryText || primaryText || fullText);
  if (isBlacklistedVendorCandidate(extractedCompany)) extractedCompany = "";
  // UCS should be LAST RESORT: don't let it dominate extractedCompany.
  if (extractedCompany) {
    const nEC = normalizeVendorName(extractedCompany).replace(/_+/g, "_");
    if (_isUCS(nEC)) {
      _rememberUCS();
      extractedCompany = "";
    }
  }

  // Vendor-list match in *reading order*:
  // We pick the vendor whose normalized name appears earliest in the normalized text.
  // This aligns with "read from top-left to top-right, then down".
  const tryContains = (text, opts = {}) => {
    const allowUCS = !!opts.allowUCS;
    const normText = normalizeVendorName(text).replace(/_+/g, "_");

    // Remember UCS if it appears anywhere, but do not return it unless explicitly allowed.
    if (!allowUCS && normText.includes(_UCS_TOKEN)) _rememberUCS();

    let best = null; // { vendorNorm, idx }
    if (map && map.size) {
      for (const [vendorNorm] of map.entries()) {
        if (!vendorNorm) continue;
        const idx = normText.indexOf(vendorNorm);
        if (idx < 0) continue;

        // UCS is a LAST RESORT: record it, but keep searching for other vendors first.
        if (_isUCS(vendorNorm) && !allowUCS) {
          _rememberUCS();
          continue;
        }

        // If the match is within an ampersand name (e.g., "A & B"), require both sides.
        if (!_passesAmpersandRule(vendorNorm, normText, ampConstraints)) continue;

        if (!best || idx < best.idx || (idx === best.idx && vendorNorm.length > best.vendorNorm.length)) {
          best = { vendorNorm, idx };
        }
      }
      if (best?.vendorNorm) {
        const rawHit = map.get(best.vendorNorm) || best.vendorNorm;
        if (!isBlacklistedVendorCandidate(rawHit) && !isBlacklistedVendorCandidate(best.vendorNorm)) {
          // SERVICES rule: if the match contains SERVICES, expand to include all words before it
          // as shown on the invoice header line.
          const expanded = _expandServicesPrefixFromText(best.vendorNorm, text);
          if (expanded) return { ...expanded, matched: true };
          return { vendorRaw: rawHit, vendorNorm: best.vendorNorm, matched: true };
        }
      }
    }
    return null;
  };
  // 1) Strong contains match from list in reading order:
  //    full-width header (bold) -> full-width header -> top-left -> wide header -> middle -> right -> full page
  const c0 = boldTopFullText ? tryContains(boldTopFullText) : null;
  if (c0) return c0;

  const c1 = topFullText ? tryContains(topFullText) : null;
  if (c1) return c1;

  const c2 = boldTopLeftText ? tryContains(boldTopLeftText) : null;
  if (c2) return c2;

  const c3 = topLeftText ? tryContains(topLeftText) : null;
  if (c3) return c3;

  const c4 = boldTopVendorText ? tryContains(boldTopVendorText) : null;
  if (c4) return c4;

  const c5 = topVendorText ? tryContains(topVendorText) : null;
  if (c5) return c5;

  const c6 = boldTopMiddleText ? tryContains(boldTopMiddleText) : null;
  if (c6) return c6;

  const c7 = topMiddleText ? tryContains(topMiddleText) : null;
  if (c7) return c7;

  const c8 = boldTopRightText ? tryContains(boldTopRightText) : null;
  if (c8) return c8;

  const c9 = topRightText ? tryContains(topRightText) : null;
  if (c9) return c9;

  const c10 = fullText ? tryContains(fullText) : null;
  if (c10) return c10;

  // 1b) If we could extract a clean company line, try matching that too.
  if (extractedCompany) {
    const c3 = tryContains(extractedCompany);
    if (c3) return c3;
  }

  // 2) Fuzzy match against the vendor list
  const candidatesText = ([boldTopFullText, topFullText, boldTopLeftText, topLeftText, boldTopVendorText, topVendorText, boldTopMiddleText, topMiddleText, boldTopRightText, topRightText].filter(Boolean).join('\n')) || fullText;
  const parts = String(candidatesText || "")
    .replace(/\r/g, "\n")
    .split(/\n|\||·|•/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 40);

  // Put extracted company name first so it wins over city/state lines.
  if (extractedCompany && !parts.includes(extractedCompany)) parts.unshift(extractedCompany);

  const addressWords = /\b(PO\s*BOX|P\.?\s*O\.?\s*BOX|STREET|ST\.|ROAD|RD\.|AVE|AVENUE|BLVD|SUITE|STE\.|APT|UNIT|CITY|STATE|ZIP|USA|FAX|PHONE|TEL|REMIT|BILL\s*TO|SHIP\s*TO)\b|\b\d{5}(?:-\d{4})?\b|,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b|\b[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/i;
  const nonVendorWords = /\b(INVOICE|STATEMENT|PACKING\s*SLIP|PURCHASE\s*ORDER|ORDER|DATE|ACCOUNT)\b/i;

  const tryFuzzy = (line) => {
    if (!entries || !entries.length) return null;
    const candNorm = normalizeVendorName(line).replace(/_+/g, "_");
    if (!candNorm || candNorm.length < 4) return null;

    let best = null;
    let bestScore = 0;

    for (const e of entries) {
      const score = diceCoefficient(candNorm, e.norm);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }

    // Threshold tuned for OCR.
    if (best && bestScore >= 0.82) {
      // UCS is a LAST RESORT: if it wins fuzzy match, keep searching.
      if (_isUCS(best.norm)) {
        _rememberUCS();
        return null;
      }
      // If the candidate line is an ampersand name, require both sides in the selected vendor.
      if (line.includes("&")) {
        const local = _buildAmpConstraints(line);
        const normLine = normalizeVendorName(line).replace(/_+/g, "_");
        if (!_passesAmpersandRule(best.norm, normLine, local)) return null;
      }
      // SERVICES rule: prefer the invoice header line's prefix through "SERVICES" if it contains more words.
      const expanded = _expandServicesPrefixFromText(best.norm, line);
      if (expanded) return { ...expanded, matched: true, fuzzyScore: bestScore };
      return { vendorRaw: best.raw, vendorNorm: best.norm, matched: true, fuzzyScore: bestScore };
    }
    return null;
  };

  for (const part of parts) {
    const line = part.replace(/\s+/g, " ").trim();
    // If the line itself is UCS, record it but don't let it win early.
    const nLine = normalizeVendorName(line).replace(/_+/g, "_");
    if (_isUCS(nLine)) {
      _rememberUCS();
      continue;
    }
    if (line.length < 3) continue;
    if (looksLikeVendorLabel(line)) continue;
    if (isBlacklistedVendorCandidate(line)) continue;
    if (addressWords.test(line)) continue;

    const digits = (line.match(/\d/g) || []).length;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters < 2) continue;
    if (digits >= letters) continue;
    if (nonVendorWords.test(line) && line.length < 10) continue;

    const f = tryFuzzy(line);
    if (f) return f;
  }

  // 3) Heuristic guess if no list match
  // Build a ranked set of candidate header lines and pick the best-scoring one.
  let bestLine = "";

  // Prefer an ampersand partnership name (full line).
  if (ampConstraints && ampConstraints.length) {
    for (const c of ampConstraints) {
      const l = String(c?.line || "").trim();
      if (!l) continue;
      if (looksLikeVendorLabel(l)) continue;
      if (isBlacklistedVendorCandidate(l)) continue;
      bestLine = l;
      break;
    }
  }

  const candidateOk = (line) => {
    const l = String(line || "").replace(/\s+/g, " ").trim();
    if (l.length < 3) return false;
    if (looksLikeVendorLabel(l)) return false;
    if (isBlacklistedVendorCandidate(l)) return false;
    if (addressWords.test(l)) return false;

    const letters = (l.match(/[A-Za-z]/g) || []).length;
    const digits = (l.match(/\d/g) || []).length;
    if (letters < 2) return false;
    // A vendor name can contain digits (e.g., "Studio 54"), but if digits dominate, it's usually not the vendor.
    if (digits >= letters) return false;
    // Avoid short, generic all-caps headers that slip past label filters.
    if (l.length <= 6 && /^[A-Z\s]+$/.test(l) && nonVendorWords.test(l)) return false;
    return true;
  };

  const scoreLine = (line, meta) => {
    const l = String(line || "").replace(/\s+/g, " ").trim();
    if (!candidateOk(l)) return -1e9;

    let s = 0;
    // Positional/source weighting (top-left is most important).
    const src = meta?.src || "";
    if (src === "topLeft") s += 3.0;
    else if (src === "topFull") s += 2.6;
    else if (src === "topVendor") s += 2.2;
    else if (src === "topMiddle") s += 1.6;
    else if (src === "topRight") s += 1.1;
    else if (src === "parts") s += 1.0;
    else if (src === "full") s += 0.4;

    // Bold is only a weak positive signal.
    if (meta?.bold) s += 0.35;

    // Business-suffix signal.
    if (/\b(LLC|L\.L\.C\.|INC\.?|INCORPORATED|LTD\.?|LIMITED|CORP\.?|CORPORATION|CO\.?|COMPANY)\b/i.test(l)) s += 0.6;
    if (/\b(SERVICES|SUPPLY|SOLUTIONS|SYSTEMS|ELECTRIC|ELECTRICAL|PLUMBING|CONSTRUCTION|PROPERTIES|HOLDINGS|MANAGEMENT)\b/i.test(l)) s += 0.25;

    // Partnership names often include '&' and are frequently the true vendor line.
    if (l.includes("&")) s += 0.35;

    // Penalize overly long lines (often include slogans / addresses) and very short lines.
    if (l.length > 70) s -= 0.75;
    else if (l.length > 55) s -= 0.35;
    if (l.length < 5) s -= 0.5;

    // Prefer more letters than digits.
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    const digits = (l.match(/\d/g) || []).length;
    s += Math.min(0.6, Math.max(0, (letters - digits) / 40));

    return s;
  };

  // Candidate pools (ordered by where we expect the vendor to be) — bold is NOT auto-selected.
  const pools = [
    { text: topFullText, src: "topFull", bold: false },
    { text: topLeftText, src: "topLeft", bold: false },
    { text: topVendorText, src: "topVendor", bold: false },
    { text: topMiddleText, src: "topMiddle", bold: false },
    { text: topRightText, src: "topRight", bold: false },
    { text: boldTopFullText, src: "topFull", bold: true },
    { text: boldTopLeftText, src: "topLeft", bold: true },
    { text: boldTopVendorText, src: "topVendor", bold: true },
    { text: boldTopMiddleText, src: "topMiddle", bold: true },
    { text: boldTopRightText, src: "topRight", bold: true }
  ];

  // Seed candidates from the region pools.
  const scored = [];
  for (const p of pools) {
    const ls = String(p.text || "")
      .replace(/\r/g, "\n")
      .split(/\n|\||·|•/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 12);
    for (const line of ls) {
      scored.push({ line, score: scoreLine(line, { src: p.src, bold: p.bold }) });
    }
  }

  // Extracted company (from address block) is often correct; give it a strong source weight.
  if (extractedCompany && !looksLikeVendorLabel(extractedCompany)) {
    scored.push({ line: extractedCompany, score: scoreLine(extractedCompany, { src: "topLeft", bold: false }) + 0.4 });
  }

  // Include additional header-ish parts (already capped) as weaker candidates.
  for (const part of parts) {
    const line = String(part || "").replace(/\s+/g, " ").trim();
    scored.push({ line, score: scoreLine(line, { src: "parts", bold: false }) });
  }

  // Choose the best scoring line.
  scored.sort((a, b) => b.score - a.score);
  const topPick = scored.find((x) => x && x.score > -1e8);
  if (topPick?.line) {
    // If we already chose an ampersand partnership name, don't replace it with a non-ampersand line.
    if (!bestLine || bestLine.includes("&") === topPick.line.includes("&") || topPick.line.includes("&")) {
      bestLine = String(topPick.line).replace(/\s+/g, " ").trim();
    }
  }

  if (bestLine) {
    const n = normalizeVendorName(bestLine);
    // UCS is a LAST RESORT: record it, but keep searching for other vendor names.
    if (_isUCS(n)) {
      _rememberUCS();
    } else if (n && n.length >= 3) {
      // SERVICES rule: if we only ended up with a generic "SERVICES", try to expand from the header.
      const basePrefix = _prefixToServices(n);
      if (basePrefix === "SERVICES" || basePrefix === "SERVICE") {
        const expanded = _expandServicesPrefixFromText(n, boldPrimaryText || primaryText || fullText);
        if (expanded) return { ...expanded, matched: false };
      }
      return { vendorRaw: bestLine, vendorNorm: n, matched: false };
    }
  }

  // 3b) If vendor is still unknown, attempt a conservative address-to-vendor override.
  // This ONLY triggers when no vendor-list/fuzzy/heuristic header line was found.
  // 3b) Address overrides need to see the *raw* page context when available.
  // Use fullRawText first (may include below-table content), then fall back to header text.
  const overrideSource = [fullRawText, boldPrimaryText, primaryText, fullText].filter(Boolean).join("\n");
  const overrideRaw = vendorOverrideFromAddress(overrideSource);
  if (overrideRaw) {
    const n = normalizeVendorName(overrideRaw);
    // UCS is a LAST RESORT: record it but do not return it unless nothing else matches.
    if (_isUCS(n)) {
      _rememberUCS();
    } else if (n && n.length >= 3 && !isBlacklistedVendorCandidate(overrideRaw)) {
      const isMatched = !!(map && map.size && map.has(n));
      return { vendorRaw: overrideRaw, vendorNorm: n, matched: isMatched, fromAddress: true };
    }
  }


// 4) LAST RESORT: if still unknown, try extracting a website/domain and use that as vendor.
// This helps when the only clean vendor signal is a site printed near the header/logo.
const site = extractWebsiteVendorCandidate(boldPrimaryText || primaryText || fullText);
if (site) {
  // Use domain as raw vendor; normalization will sanitize.
  if (!looksLikeVendorLabel(site) && !isBlacklistedVendorCandidate(site)) {
    const nSite = normalizeVendorName(site);
    if (nSite && nSite.length >= 3) {
      return { vendorRaw: site, vendorNorm: nSite, matched: false, fromWebsite: true };
    }
  }
}
  // 5) ABSOLUTE LAST RESORT: if UCS appeared anywhere, use it only if nothing else matched.
  if (_ucsCandidate) return _ucsCandidate;

  return { vendorRaw: "UNKNOWN_VENDOR", vendorNorm: "UNKNOWN_VENDOR", matched: false };
}

export function buildDefaultStem(vendorNorm, invoiceNumber) {
  // Final safety check: never allow header labels (e.g., "Invoice Date") to become the vendor portion.
  const safeVendor = (looksLikeVendorLabel(vendorNorm) || isBlacklistedVendorCandidate(vendorNorm)) ? "UNKNOWN_VENDOR" : (vendorNorm || "UNKNOWN_VENDOR");

  const vClean = cleanVendorForStem(safeVendor) || "UNKNOWN_VENDOR";
  const vendorName = toVendorDisplayName(vClean) || "Unknown Vendor";

  // Keep an optional hyphen in the invoice number.
  const inv = normalizeInvoiceNumber(invoiceNumber || "");
  const invPart = inv || "unknownInvoice";

  return `${vendorName}_${invPart}`;
}