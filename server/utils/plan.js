import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { loadVendorIndex } from "./vendorStore.js";
import { extractPageObjectsFromPath } from "./pdfText.js";
import { findInvoiceNumber, findVendor, buildDefaultStem } from "./detect.js";
import { ocrTopThirdRegions, ocrTopThirdVendorHintsLightGrey, ocrPdfPageAddressHints } from "./imageRegionOcr.js";
import { sanitizeFilenameStem, normalizeVendorName } from "./normalize.js";
import { getTessdataStatus } from "./tesseractShared.js";

/**
 * Produce a split plan based on OCR/text.
 *
 * Goal per your requirement:
 * - MAX 2 pages per invoice
 * - BUT most invoices should be 1 page
 * - Be cautious: if headers differ between pages, split into separate invoices
 *
 * Approach:
 * - Default: every page becomes its own invoice group.
 * - Only merge a page into the previous group (making a 2-page invoice) if strong continuation signals exist.
 */
function tokenSet(s) {
  return new Set(
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t && t.length >= 3)
  );
}

function overlapRatio(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

function looksLikeContinuation(text) {
  const t = String(text || "");
  return (
    /\bPAGE\s*2\b/i.test(t) ||
    /\b2\s*OF\s*2\b/i.test(t) ||
    /\bCONTINUED\b/i.test(t) ||
    /\bREMITTANCE\b/i.test(t) ||
    /\bREMIT\s+TO\b/i.test(t)
  );
}

function looksLikeNewStart(text) {
  const t = String(text || "");
  return /\bPAGE\s*1\b/i.test(t) || /\b1\s*OF\s*2\b/i.test(t);
}

export async function makePlan({ pdfPath, onProgress }) {
  const vendorIndex = loadVendorIndex();
  const vendorMap = vendorIndex.map;

  const warnings = [];

  // Surface common OCR environment pitfalls early so users understand why vendor/invoice may be blank.
  try {
    const tess = getTessdataStatus();
    if (!tess.localEng && tess.usingRemote) {
      warnings.push({
        code: "TESSDATA_LOCAL_MISSING",
        message:
          "Local eng.traineddata not found. Server will try remote tessdata. If OCR is blank or hangs (corporate networks often block this), download eng.traineddata into server/tessdata.",
        detail: `effectiveLangPath=${tess.effectiveLangPath}`
      });
    } else if (!tess.localEng && !tess.usingRemote) {
      warnings.push({
        code: "TESSDATA_MISSING",
        message:
          "Tesseract language data missing (server/tessdata/eng.traineddata). OCR cannot run until you download it.",
        detail: "Run server/scripts/download-eng-tessdata.ps1 (Windows) or server/scripts/download-eng-tessdata.sh"
      });
    }
  } catch {
    // non-fatal
  }

  let imageOcrFailures = 0;
  let imageOcrFirstError = "";
  let lightGreyOcrFailures = 0;
  let lightGreyOcrFirstError = "";
  let addressOcrFailures = 0;
  let addressOcrFirstError = "";

  let pageObjs = [];
  try {
    pageObjs = await extractPageObjectsFromPath(pdfPath, onProgress);
  } catch (err) {
    warnings.push({
      code: "PDF_TEXT_EXTRACT_FAILED",
      message: "Failed to extract text via pdfjs; falling back to page-count-only plan.",
      detail: String(err?.message || err)
    });
    pageObjs = [];
  }

  // Some PDFs may parse but return no text objects; still produce a usable plan.
  if (!Array.isArray(pageObjs) || pageObjs.length === 0) {
    try {
      const bytes = fs.readFileSync(pdfPath);
      const doc = await PDFDocument.load(bytes);
      const n = doc.getPageCount();
      if (n > 0) {
        warnings.push({
          code: "PDF_NO_TEXT_OBJECTS",
          message: "PDF contained no extractable text objects; using placeholder per-page plan (image OCR may still run).",
          detail: `pageCount=${n}`
        });
        pageObjs = Array.from({ length: n }, () => ({
          text: "",
          headerText: "",
          headerSig: "",
          topLeftText: "",
          topMiddleText: "",
          topRightText: ""
        }));
      } else {
        warnings.push({
          code: "PDF_ZERO_PAGES",
          message: "PDF appears to have 0 pages. This file may be corrupted or not a valid PDF.",
          detail: "pageCount=0"
        });
        throw new Error("PDF has 0 pages");
      }
    } catch (err) {
      warnings.push({
        code: "PDF_PAGECOUNT_FAILED",
        message: "Could not determine PDF page count for fallback plan.",
        detail: String(err?.message || err)
      });
      // If we can't even determine page count, let the caller surface the error.
      throw err;
    }
  }


// Build per-page detection info.
// If text extraction is weak (scanned PDFs without an OCR text layer), run IMAGE-focused OCR on top-third regions.

const pages = [];
for (let idx = 0; idx < pageObjs.length; idx++) {
  const pobj = pageObjs[idx] || {};
  const text = pobj?.text || "";
  const textChars = (text || "").length;

  // Region texts from OCR'd PDF text-layer (if present)
  let topLeftText = pobj?.topLeftText || "";
  let topMiddleText = pobj?.topMiddleText || "";
  let topRightText = pobj?.topRightText || "";
  let topVendorText = "";

  // NEW: Above-table (header-only) regions from PDF text layer (if present).
  // These stop at the first likely line-items table header and help ignore tables below titles.
  const aboveTableLeftText0 = pobj?.aboveTableLeftText || "";
  const aboveTableMiddleText0 = pobj?.aboveTableMiddleText || "";
  const aboveTableRightText0 = pobj?.aboveTableRightText || "";
  const aboveTableVendorText0 = pobj?.aboveTableVendorText || "";

  // Bold/large-font header lines (from PDF text layer). Used to prioritize vendor detection.
  let topLeftBoldText = pobj?.topLeftBoldText || "";
  let topMiddleBoldText = pobj?.topMiddleBoldText || "";
  let topRightBoldText = pobj?.topRightBoldText || "";

  const aboveTableLeftBoldText0 = pobj?.aboveTableLeftBoldText || "";
  const aboveTableMiddleBoldText0 = pobj?.aboveTableMiddleBoldText || "";
  const aboveTableRightBoldText0 = pobj?.aboveTableRightBoldText || "";
  const aboveTableVendorBoldText0 = pobj?.aboveTableVendorBoldText || "";

  let img = null;

  // If region text is missing or the page has almost no text, do image OCR up front.
  if ((topLeftText + topMiddleText + topRightText).trim() === "" || textChars < 20) {
    try {
      img = await ocrTopThirdRegions({ pdfPath, pageNumber: idx + 1 });
      topLeftText = topLeftText || img.topLeftText || "";
      topMiddleText = topMiddleText || img.topMiddleText || "";
      topRightText = topRightText || img.topRightText || "";
      topVendorText = img.topVendorText || "";
    } catch (err) {
      img = null;
      imageOcrFailures++;
      if (!imageOcrFirstError) imageOcrFirstError = String(err?.message || err);
    }
  }
  // Prefer above-table header-only regions when present.
  const headerLeftText = aboveTableLeftText0 || topLeftText;
  const headerMiddleText = aboveTableMiddleText0 || topMiddleText;
  const headerRightText = aboveTableRightText0 || topRightText;
  const headerVendorText = aboveTableVendorText0 || topVendorText;

  const headerLeftBoldText = aboveTableLeftBoldText0 || topLeftBoldText;
  const headerMiddleBoldText = aboveTableMiddleBoldText0 || topMiddleBoldText;
  const headerVendorBoldText = aboveTableVendorBoldText0 || "";

  // Reading-order header text: scan TOP-LEFT -> TOP-RIGHT, then restart at the left on the next line down.
  // Prefer the full-width line-ordered text regions (especially the above-table header-only region).
  const headerFullReadingText = pobj?.aboveTableFullText || pobj?.topFullText || pobj?.fullTopText || "";

  // Legacy concatenation as a fallback (kept for backwards compatibility).
  // NOTE: keep LEFT->MIDDLE->RIGHT order so we don't accidentally start at the right.
  const headerFullTextLegacy = [headerLeftText, headerMiddleText, headerRightText, headerVendorText]
    .filter(Boolean)
    .join("\n");

  const headerFullText = headerFullReadingText || headerFullTextLegacy;

  // First pass invoice/vendor
  let inv = findInvoiceNumber({
    right: headerRightText,
    middle: headerMiddleText,
    left: headerLeftText,
    full: headerFullText || text
  });

  let vendor = findVendor({ topVendorText: headerVendorText, topLeftText: headerLeftText, topMiddleText: headerMiddleText, topLeftBoldText: headerLeftBoldText, topMiddleBoldText: headerMiddleBoldText, topVendorBoldText: headerVendorBoldText, full: headerFullText || text }, vendorIndex);

  // If vendor is UNKNOWN (common when only footer text exists), run image OCR and retry.
  if ((vendor.vendorNorm === "UNKNOWN_VENDOR" || vendor.vendorRaw === "UNKNOWN_VENDOR") && !img) {
    try {
      img = await ocrTopThirdRegions({ pdfPath, pageNumber: idx + 1 });
      topLeftText = topLeftText || img.topLeftText || "";
      topMiddleText = topMiddleText || img.topMiddleText || "";
      topRightText = topRightText || img.topRightText || "";
      topVendorText = img.topVendorText || "";

      vendor = findVendor(
        { topVendorText, topLeftText: img.topLeftText, topMiddleText: img.topMiddleText, full: `${text}
${topVendorText}` },
        vendorMap
      );

      if (!inv) {
        inv = findInvoiceNumber({
          right: img.topRightText || topRightText,
          middle: img.topMiddleText || topMiddleText,
          left: img.topLeftText || topLeftText,
          full: `${text}\n${img.topLeftText}\n${img.topMiddleText}\n${img.topRightText}`
        });
      }
    } catch (err) {
      // missing tools -> keep UNKNOWN and allow UI edits
      imageOcrFailures++;
      if (!imageOcrFirstError) imageOcrFirstError = String(err?.message || err);
    }
  }

  // If still UNKNOWN, try a light-grey enhanced OCR pass (some invoices print the vendor name in faint grey).
  if (vendor.vendorNorm === "UNKNOWN_VENDOR" || vendor.vendorRaw === "UNKNOWN_VENDOR") {
    try {
      const light = await ocrTopThirdVendorHintsLightGrey({
        pdfPath,
        pageNumber: idx + 1,
        needLeft: true,
        needVendor: true
      });

      const v2 = findVendor(
        {
          topVendorText: light.topVendorText,
          topLeftText: light.topLeftText,
          full: `${light.topVendorText}\n${light.topLeftText}\n${text}`
        },
        vendorIndex
      );
      if (v2?.vendorNorm && v2.vendorNorm !== "UNKNOWN_VENDOR") vendor = v2;
    } catch (err) {
      // ignore light-grey OCR failures
      lightGreyOcrFailures++;
      if (!lightGreyOcrFirstError) lightGreyOcrFirstError = String(err?.message || err);
    }
  }

  // LAST-LAST resort (plan phase): OCR below-header content to trigger address-based overrides.
  // Only do this when vendor is still UNKNOWN.
  if (vendor.vendorNorm === "UNKNOWN_VENDOR" || vendor.vendorRaw === "UNKNOWN_VENDOR") {
    try {
      const addressText = await ocrPdfPageAddressHints({ pdfPath, pageNumber: idx + 1 });
      const v3 = findVendor(
        {
          topFullText: headerFullText,
          topLeftText: headerLeftText,
          full: "",
          fullRaw: addressText
        },
        vendorIndex
      );
      if (v3?.vendorNorm && v3.vendorNorm !== "UNKNOWN_VENDOR") vendor = v3;
    } catch (err) {
      // ignore address OCR failures
      addressOcrFailures++;
      if (!addressOcrFirstError) addressOcrFirstError = String(err?.message || err);
    }
  }

  const combinedTop = `${topVendorText}\n${topLeftText}\n${topMiddleText}\n${topRightText}`;
  const hasInvoiceWord = /\bINVOICE\b/i.test(text || combinedTop);

  pages.push({
    pageIndex: idx + 1,
    vendorRaw: vendor.vendorRaw,
    vendorNorm: vendor.vendorNorm,
    invoiceNumber: inv,
    matchedVendor: vendor.matched,
    hasInvoiceWord,
    headerSig: pobj?.headerSig || "",
    headerText: pobj?.headerText || "",
    topLeftText: headerLeftText,
    topMiddleText: headerMiddleText,
    topRightText: headerRightText,
    topVendorText: headerVendorText,
    textChars,
    looksLikeContinuation: looksLikeContinuation(text),
    looksLikeNewStart: looksLikeNewStart(text)
  });
}
// Default: 1 page per group. Optionally merge to 2 pages if strong continuation.
  const groups = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];

    // Start new group for this page.
    const g = {
      groupIndex: groups.length + 1,
      vendorNorm: p.vendorNorm || "UNKNOWN_VENDOR",
      invoiceNumber: p.invoiceNumber || "",
      pages: [p.pageIndex],
      headerSig: p.headerSig || ""
    };

    // Try to merge next page as page-2 (cautiously)
    const next = pages[i + 1];
    if (next) {
      const sameInvoiceNumber =
        !!g.invoiceNumber && !!next.invoiceNumber && g.invoiceNumber === next.invoiceNumber;

      const nextHasDifferentInvoiceNumber =
        !!g.invoiceNumber && !!next.invoiceNumber && g.invoiceNumber !== next.invoiceNumber;

      const vendorStrongDifferent =
        next.matchedVendor &&
        next.vendorNorm &&
        next.vendorNorm !== "UNKNOWN_VENDOR" &&
        g.vendorNorm &&
        g.vendorNorm !== "UNKNOWN_VENDOR" &&
        next.vendorNorm !== g.vendorNorm;

      // Header similarity: if headers differ a lot, treat as new invoice.
      const headerSim = overlapRatio(g.headerSig, next.headerSig);

      // Strong continuation signals: explicit page 2 / continued / remittance cues.
      const strongContinuation = next.looksLikeContinuation;

      // Guardrails to be cautious:
      const headerLooksDifferent = headerSim < 0.45;  // cautious threshold
      const nextLooksLikeNewInvoiceStart = next.looksLikeNewStart || (next.hasInvoiceWord && !!next.invoiceNumber && !sameInvoiceNumber);

      // Merge decision:
      // - Never merge if next looks like a new invoice start, vendor is strongly different, or invoice number conflicts.
      // - Otherwise merge ONLY if:
      //    a) strong continuation, OR
      //    b) same invoice number and header not different (OCR might repeat on page 2), OR
      //    c) next has no invoice number AND header is very similar AND vendor not strongly different
      const canMerge =
        !nextLooksLikeNewInvoiceStart &&
        !vendorStrongDifferent &&
        !nextHasDifferentInvoiceNumber &&
        !headerLooksDifferent &&
        (
          strongContinuation ||
          (sameInvoiceNumber) ||
          (!next.invoiceNumber && headerSim >= 0.65)
        );

      if (canMerge) {
        g.pages.push(next.pageIndex);
        // inherit invoice number if OCR missed it on page 1
        if (!g.invoiceNumber && next.invoiceNumber) g.invoiceNumber = next.invoiceNumber;
        // prefer known vendor
        if (g.vendorNorm === "UNKNOWN_VENDOR" && next.vendorNorm !== "UNKNOWN_VENDOR") g.vendorNorm = next.vendorNorm;
        i++; // consumed next page
      }
    }

    groups.push(g);
  }

  // Suggested filenames: VENDOR_INVOICENUMBER
  const planned = groups.map((g) => {
    const stem = sanitizeFilenameStem(buildDefaultStem(g.vendorNorm, g.invoiceNumber));
    return {
      groupIndex: g.groupIndex,
      vendorNorm: g.vendorNorm,
      invoiceNumber: g.invoiceNumber,
      pages: g.pages,
      suggestedStem: stem
    };
  });

  if (imageOcrFailures > 0) {
    warnings.push({
      code: "IMAGE_OCR_FAILED",
      message:
        "One or more pages required image OCR, but OCR failed. If vendor/invoice are blank, check /api/health for tessdataEng=true and canvas=true, then install eng.traineddata locally.",
      detail: `failures=${imageOcrFailures}; firstError=${imageOcrFirstError || "(unknown)"}`
    });
  }
  if (lightGreyOcrFailures > 0) {
    warnings.push({
      code: "IMAGE_OCR_LIGHTGREY_FAILED",
      message: "Light-grey vendor OCR pass failed on one or more pages (non-fatal).",
      detail: `failures=${lightGreyOcrFailures}; firstError=${lightGreyOcrFirstError || "(unknown)"}`
    });
  }
  if (addressOcrFailures > 0) {
    warnings.push({
      code: "IMAGE_OCR_ADDRESS_FAILED",
      message: "Address-based fallback OCR failed on one or more pages (non-fatal).",
      detail: `failures=${addressOcrFailures}; firstError=${addressOcrFirstError || "(unknown)"}`
    });
  }

  return { pages, groups: planned, warnings };
}
