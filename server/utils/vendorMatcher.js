import {
  normalizeVendorName,
  normalizeVendorLoose,
} from "./vendorCatalog.js";

function splitLines(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getHeaderLines(pageText = "") {
  return splitLines(pageText).slice(0, 18);
}

export function getVendorSearchText(pageText = "") {
  const headerLines = getHeaderLines(pageText);
  const firstChars = String(pageText || "").slice(0, 1800);
  return `${headerLines.join("\n")}\n${firstChars}`.trim();
}

export function looksLikePotentialVendorLine(line = "") {
  const s = String(line || "").trim();
  if (!s) return false;
  if (s.length < 3 || s.length > 80) return false;
  if (/^\d/.test(s)) return false;
  if (/@|\bwww\b|https?:|\.com\b|\.net\b|\.org\b/i.test(s)) return false;

  if (
    /\b(invoice|statement|bill\s*to|ship\s*to|remit|remittance|page|date|account|customer|purchase\s*order|sold\s*to|service\s*address|mailing\s*address)\b/i.test(
      s
    )
  ) {
    return false;
  }

  if (
    /\b(street|st\.?|avenue|ave\.?|road|rd\.?|suite|ste\.?|floor|fl\.?|box|po\s*box|zip|phone|fax)\b/i.test(
      s
    )
  ) {
    return false;
  }

  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;

  if (/\b(INC|LLC|LTD|CORP|CORPORATION|COMPANY|CO\b|LP|LLP|PLC)\b/i.test(s)) {
    return true;
  }

  const upperishCount = words.filter((word) => word === word.toUpperCase()).length;
  return upperishCount / words.length >= 0.6;
}

function scoreVendorAgainstLine(line, vendor) {
  const normalizedLine = normalizeVendorName(line);
  const looseLine = normalizeVendorLoose(line);

  if (!normalizedLine || !vendor) return 0;

  if (normalizedLine === vendor.normalized) return 120;
  if (vendor.loose && looseLine === vendor.loose) return 115;
  if (normalizedLine.includes(vendor.normalized)) return 105;
  if (vendor.loose && looseLine.includes(vendor.loose) && vendor.loose.length >= 4) {
    return 95;
  }

  if (!vendor.tokens?.length) return 0;

  let tokenHits = 0;
  for (const token of vendor.tokens) {
    if (token.length < 3) continue;
    if (looseLine.includes(token)) tokenHits += 1;
  }

  if (!tokenHits) return 0;

  const coverage = tokenHits / vendor.tokens.length;
  if (coverage >= 1) return 90;
  if (coverage >= 0.8) return 80;
  if (coverage >= 0.6) return 68;
  if (coverage >= 0.5) return 60;

  return 0;
}

export function matchVendorFromText(text, vendorCatalog = []) {
  if (!text || !vendorCatalog.length) return null;

  const lines = getHeaderLines(text);
  const fullSearchText = getVendorSearchText(text);

  let bestVendor = null;
  let bestScore = 0;
  let bestLine = "";

  for (const vendor of vendorCatalog) {
    for (const line of lines) {
      const lineScore = scoreVendorAgainstLine(line, vendor);
      if (lineScore > bestScore) {
        bestVendor = vendor;
        bestScore = lineScore;
        bestLine = line;
      }
    }

    if (bestScore < 95) {
      const fullTextScore = scoreVendorAgainstLine(fullSearchText, vendor);
      if (fullTextScore > bestScore) {
        bestVendor = vendor;
        bestScore = fullTextScore;
        bestLine = fullSearchText.slice(0, 160);
      }
    }
  }

  if (!bestVendor || bestScore < 60) return null;

  return {
    vendor: bestVendor,
    score: bestScore,
    matchedLine: bestLine,
  };
}

export function guessVendorNameFromHeader(pageText = "") {
  const headerLines = getHeaderLines(pageText);

  for (const line of headerLines) {
    if (looksLikePotentialVendorLine(line)) {
      return line.replace(/\s+/g, " ").trim();
    }
  }

  return null;
}

export function detectVendorForPage(pageText, vendorCatalog = [], options = {}) {
  const pageNumber = options.pageNumber || 0;
  const logger = options.logger || console;

  const match = matchVendorFromText(pageText, vendorCatalog);
  if (match) {
    logger.log(
      `[vendor] page ${pageNumber}: matched "${match.vendor.raw}" score=${match.score}`
    );

    return {
      vendorName: match.vendor.raw,
      score: match.score,
      source: "catalog",
      matchedLine: match.matchedLine,
    };
  }

  const guessedVendor = guessVendorNameFromHeader(pageText);
  if (guessedVendor) {
    logger.log(`[vendor] page ${pageNumber}: header fallback "${guessedVendor}"`);
    return {
      vendorName: guessedVendor,
      score: 0,
      source: "header-fallback",
      matchedLine: guessedVendor,
    };
  }

  const sample = getVendorSearchText(pageText).slice(0, 250).replace(/\s+/g, " ");
  logger.log(`[vendor] page ${pageNumber}: UNKNOWN_VENDOR sample="${sample}"`);

  return {
    vendorName: "UNKNOWN_VENDOR",
    score: 0,
    source: "unknown",
    matchedLine: "",
  };
}

export function detectVendorsForPages(pageTexts = [], vendorCatalog = [], options = {}) {
  return pageTexts.map((pageText, index) => {
    const result = detectVendorForPage(pageText, vendorCatalog, {
      ...options,
      pageNumber: index + 1,
    });

    return {
      page: index + 1,
      vendorName: result.vendorName,
      vendorScore: result.score,
      vendorSource: result.source,
      matchedLine: result.matchedLine,
      text: pageText,
    };
  });
}

export default {
  getHeaderLines,
  getVendorSearchText,
  looksLikePotentialVendorLine,
  matchVendorFromText,
  guessVendorNameFromHeader,
  detectVendorForPage,
  detectVendorsForPages,
};