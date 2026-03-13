import { loadVendorIndex } from "./vendorStore.js";
import { findInvoiceNumber, findVendor } from "./detect.js";
import { getTopThirdTextRegions, ocrTopThirdRegions, ocrTopThirdVendorHintsLightGrey, ocrLogoTextFromPdfPage, ocrPdfPageAddressHints } from "./imageRegionOcr.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * Extract vendor + invoice number from a specific PDF page.
 *
 * Strategy:
 * 1) If the PDF already has a text layer (native PDF or OCRmyPDF output), use that (very fast).
 * 2) Otherwise render+OCR only the minimal header regions (vendor + right side).
 * 3) If still missing, OCR the additional header regions (middle/left) as a fallback.
 */
export async function extractInvoiceFieldsFromPdfPage({ pdfPath, pageNumber }) {
  const vendorIndex = loadVendorIndex();

  // Keep any invoice number we find early so we can skip redundant OCR later.
  let invoiceNumber = "";
  let vendor = null;
  let logoDebug = null;

  // 1) Fast path: existing PDF text layer
  const textRegions = await getTopThirdTextRegions({ pdfPath, pageNumber });
  if (textRegions?.hasText) {
        const headerRightText = textRegions.aboveTableRightText || textRegions.topRightText;
    const headerMiddleText = textRegions.aboveTableMiddleText || textRegions.topMiddleText;
    const headerLeftText = textRegions.aboveTableLeftText || textRegions.topLeftText;
    const headerVendorText = textRegions.aboveTableVendorText || textRegions.topVendorText;
    const headerVendorBoldText = textRegions.aboveTableVendorBoldText || textRegions.topVendorBoldText;
    const headerLeftBoldText = textRegions.aboveTableLeftBoldText || textRegions.topLeftBoldText;
    const headerMiddleBoldText = textRegions.aboveTableMiddleBoldText || textRegions.topMiddleBoldText;
    const headerRightBoldText = textRegions.aboveTableRightBoldText || textRegions.topRightBoldText;

    // Reading-order header text (top-left -> top-right, then down), preferring "above table".
    const headerFullReadingText = textRegions.aboveTableFullText || textRegions.topFullText || textRegions.fullTopText || "";
    const headerFullReadingBoldText = textRegions.aboveTableFullBoldText || "";

    // Keep the old concatenation as a fallback, but prefer the reading-order text.
    // Legacy concatenation fallback: keep LEFT->MIDDLE->RIGHT order first so we follow
    // top-left -> top-right before continuing downward.
    const headerFullTextLegacy = [headerLeftText, headerMiddleText, headerRightText, headerVendorText]
      .filter(Boolean)
      .join("\n");
    const headerFullText = headerFullReadingText || headerFullTextLegacy || textRegions.fullTopText;

    invoiceNumber = findInvoiceNumber({
      right: headerRightText,
      middle: headerMiddleText,
      left: headerLeftText,
      full: headerFullText || textRegions.fullTopText
    });

    vendor = findVendor(
  {
    topVendorText: headerVendorText,
    topVendorBoldText: headerVendorBoldText,
    topLeftText: headerLeftText,
    topLeftBoldText: headerLeftBoldText,
    topMiddleText: headerMiddleText,
    topMiddleBoldText: headerMiddleBoldText,
    topRightText: headerRightText,
    topRightBoldText: headerRightBoldText,
    topFullText: headerFullText,
    topFullBoldText: headerFullReadingBoldText,
    full: headerFullText || textRegions.fullTopText,
    // Provide full-page text (when available) for address-based vendor overrides.
    fullRaw: textRegions.fullPageText || headerFullText || textRegions.fullTopText
  },
  vendorIndex
);

    // If we got a vendor, return immediately (text layer is best).
    if (vendor?.vendorNorm && vendor.vendorNorm !== "UNKNOWN_VENDOR") {
      const invDigits = (String(invoiceNumber || "").match(/\d/g) || []).length;
      const invoiceConf = clamp((invDigits / 8) * 0.7 + (invoiceNumber ? 0.3 : 0), 0, 1);
      const vendorConf = vendor?.matched
        ? 0.95
        : vendor?.vendorNorm && vendor.vendorNorm !== "UNKNOWN_VENDOR"
          ? 0.65
          : 0.0;

      return {
        pageIndex: pageNumber,
        vendorRaw: vendor?.vendorRaw || "UNKNOWN_VENDOR",
        vendorNorm: vendor?.vendorNorm || "UNKNOWN_VENDOR",
        vendorMatched: !!vendor?.matched,
        vendorConfidence: Number(vendorConf.toFixed(3)),
        invoiceNumber: invoiceNumber || "",
        invoiceConfidence: Number(invoiceConf.toFixed(3)),
        debug: {
          source: "pdf_text",
          topVendorText: headerVendorText,
          topLeftText: headerLeftText,
          topMiddleText: headerMiddleText,
          topRightText: headerRightText,
          topFullText: headerFullText
        }
      };
    }
  }
  // 2) Image OCR fast path: START TOP-LEFT (vendor) + TOP-RIGHT (invoice #)
  //    This reduces false vendor matches from mid-page tables and follows your rule to start at the top-left.
  const fastLeft = await ocrTopThirdRegions({
    pdfPath,
    pageNumber,
    needLeft: true,
    needMiddle: false,
    needRight: !invoiceNumber,
    needVendor: false
  });

  if (!invoiceNumber) {
    invoiceNumber = findInvoiceNumber({
      right: fastLeft.topRightText,
      middle: "",
      left: fastLeft.topLeftText,
      full: `${fastLeft.topLeftText}
${fastLeft.topRightText}`
    });
  }

  vendor = findVendor(
    {
      topLeftText: fastLeft.topLeftText,
      topRightText: fastLeft.topRightText,
      full: fastLeft.topLeftText
    },
    vendorIndex
  );

  // If vendor might be in the top-right (or spans the full header), take a full-width header OCR pass.
  // This enforces the reading-order rule: left -> right, then down.
  let fastFull = null;
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    fastFull = await ocrTopThirdRegions({
      pdfPath,
      pageNumber,
      needLeft: false,
      needMiddle: false,
      needRight: false,
      needVendor: false,
      needFull: true
    });

    const vFull = findVendor(
      {
        topFullText: fastFull.topFullText,
        topLeftText: fastLeft.topLeftText,
        topRightText: fastLeft.topRightText,
        full: fastFull.topFullText || `${fastLeft.topLeftText}\n${fastLeft.topRightText}`
      },
      vendorIndex
    );

    if (vFull?.vendorNorm && vFull.vendorNorm !== "UNKNOWN_VENDOR") vendor = vFull;
  }

  // If the vendor is printed in light grey, a targeted light-grey OCR pass often recovers it.
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const light = await ocrTopThirdVendorHintsLightGrey({
        pdfPath,
        pageNumber,
        needLeft: true,
        needVendor: false,
        needFull: true
      });

      const vLight = findVendor(
        {
          topLeftText: light.topLeftText,
          topFullText: light.topFullText,
          full: light.topFullText || `${light.topLeftText}\n${fastLeft.topLeftText}`
        },
        vendorIndex
      );

      if (vLight?.vendorNorm && vLight.vendorNorm !== "UNKNOWN_VENDOR") {
        vendor = vLight;
        const invDigits = (String(invoiceNumber || "").match(/\d/g) || []).length;
        const invoiceConf = clamp((invDigits / 8) * 0.7 + (invoiceNumber ? 0.3 : 0), 0, 1);
        const vendorConf = vendor?.matched ? 0.95 : 0.65;

        return {
          pageIndex: pageNumber,
          vendorRaw: vendor?.vendorRaw || "UNKNOWN_VENDOR",
          vendorNorm: vendor?.vendorNorm || "UNKNOWN_VENDOR",
          vendorMatched: !!vendor?.matched,
          vendorConfidence: Number(vendorConf.toFixed(3)),
          invoiceNumber: invoiceNumber || "",
          invoiceConfidence: Number(invoiceConf.toFixed(3)),
          debug: {
            source: "image_ocr_light_left",
            topVendorText: "",
            topLeftText: light.topLeftText,
            topMiddleText: "",
            topRightText: fastLeft.topRightText,
            topFullText: light.topFullText || ""
          }
        };
      }
    } catch {
      // ignore light-grey OCR failures
    }
  }

  // If vendor is still UNKNOWN, widen to the full top-left + top-middle header band (left 2/3).
  let fastWide = null;
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    fastWide = await ocrTopThirdRegions({
      pdfPath,
      pageNumber,
      needLeft: false,
      needMiddle: false,
      needRight: false,
      needVendor: true
    });

    vendor = findVendor(
      {
        topVendorText: fastWide.topVendorText,
        topLeftText: fastLeft.topLeftText,
        topRightText: fastLeft.topRightText,
        topFullText: fastFull?.topFullText || "",
        full: `${fastWide.topVendorText}
${fastLeft.topLeftText}`
      },
      vendorIndex
    );

    // If still unknown, try a light-grey enhanced OCR pass for the wide vendor band.
    if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
      try {
        const light = await ocrTopThirdVendorHintsLightGrey({
          pdfPath,
          pageNumber,
          needLeft: false,
          needVendor: true,
          needFull: true
        });
        const vLight = findVendor(
          {
            topVendorText: light.topVendorText,
            topLeftText: fastLeft.topLeftText,
            topRightText: fastLeft.topRightText,
            topFullText: light.topFullText,
            full: `${light.topVendorText}\n${fastLeft.topLeftText}`
          },
          vendorIndex
        );
        if (vLight?.vendorNorm && vLight.vendorNorm !== "UNKNOWN_VENDOR") vendor = vLight;
      } catch {
        // ignore light-grey OCR failures
      }
    }
  }

  // If we got a vendor (and invoice number maybe), return immediately.
  if (vendor?.vendorNorm && vendor.vendorNorm !== "UNKNOWN_VENDOR") {
    const invDigits = (String(invoiceNumber || "").match(/\d/g) || []).length;
    const invoiceConf = clamp((invDigits / 8) * 0.7 + (invoiceNumber ? 0.3 : 0), 0, 1);
    const vendorConf = vendor?.matched ? 0.95 : 0.65;

    return {
      pageIndex: pageNumber,
      vendorRaw: vendor?.vendorRaw || "UNKNOWN_VENDOR",
      vendorNorm: vendor?.vendorNorm || "UNKNOWN_VENDOR",
      vendorMatched: !!vendor?.matched,
      vendorConfidence: Number(vendorConf.toFixed(3)),
      invoiceNumber: invoiceNumber || "",
      invoiceConfidence: Number(invoiceConf.toFixed(3)),
      debug: {
        source: fastWide ? "image_ocr_fast_wide" : "image_ocr_fast_left",
        topVendorText: fastWide?.topVendorText || "",
        topLeftText: fastLeft.topLeftText,
        topMiddleText: "",
        topRightText: fastLeft.topRightText
      }
    };
  }

  // 3) Fallback: OCR all header regions (4 OCR calls)
  const regions = await ocrTopThirdRegions({ pdfPath, pageNumber, needFull: true });

  if (!invoiceNumber) {
    invoiceNumber = findInvoiceNumber({
      right: regions.topRightText,
      middle: regions.topMiddleText,
      left: regions.topLeftText,
      full: `${regions.topVendorText}\n${regions.topLeftText}\n${regions.topMiddleText}\n${regions.topRightText}`
    });
  }

  vendor = findVendor(
    {
      topVendorText: regions.topVendorText,
      topLeftText: regions.topLeftText,
      topMiddleText: regions.topMiddleText,
      topRightText: regions.topRightText,
      topFullText: regions.topFullText,
      full: regions.topFullText || `${regions.topVendorText}\n${regions.topLeftText}\n${regions.topMiddleText}\n${regions.topRightText}`
    },
    vendorIndex
  );

  // If still unknown, try light-grey enhanced header OCR before logo OCR.
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const light = await ocrTopThirdVendorHintsLightGrey({ pdfPath, pageNumber, needLeft: true, needVendor: true });
      const vLight = findVendor(
        {
          topVendorText: light.topVendorText || regions.topVendorText,
          topLeftText: light.topLeftText || regions.topLeftText,
          topMiddleText: regions.topMiddleText,
          topRightText: regions.topRightText,
          topFullText: light.topFullText || regions.topFullText,
          full: (light.topFullText || regions.topFullText) || `${light.topVendorText}\n${light.topLeftText}\n${regions.topMiddleText}\n${regions.topRightText}`
        },
        vendorIndex
      );
      if (vLight?.vendorNorm && vLight.vendorNorm !== "UNKNOWN_VENDOR") vendor = vLight;
    } catch {
      // ignore light-grey OCR failures
    }
  }

  // 4) LAST RESORT: OCR logo regions before returning UNKNOWN_VENDOR.
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const logo = await ocrLogoTextFromPdfPage({ pdfPath, pageNumber });
      logoDebug = logo;
      const v2 = findVendor({ topVendorText: logo.bestText, full: logo.bestText }, vendorIndex);
      if (v2?.vendorNorm && v2.vendorNorm !== "UNKNOWN_VENDOR") vendor = v2;
    } catch {
      // ignore logo OCR failures
    }
  }

  // 5) LAST-LAST RESORT: If vendor is still UNKNOWN, OCR below-header content to
  // trigger address-based overrides (e.g., remit-to blocks that appear below line items).
  if (!vendor?.vendorNorm || vendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const addressText = await ocrPdfPageAddressHints({ pdfPath, pageNumber });
      if (addressText && addressText.trim()) {
        const vAddr = findVendor(
          {
            // Keep header text for context, but keep "full" empty so we don't
            // accidentally pick an address line as a vendor.
            topFullText: regions?.topFullText || fastFull?.topFullText || "",
            topLeftText: regions?.topLeftText || fastLeft?.topLeftText || "",
            full: "",
            fullRaw: addressText
          },
          vendorIndex
        );
        if (vAddr?.vendorNorm && vAddr.vendorNorm !== "UNKNOWN_VENDOR") vendor = vAddr;
      }
    } catch {
      // ignore address OCR failures
    }
  }

  // Lightweight confidence proxies
  const invDigits = (String(invoiceNumber || "").match(/\d/g) || []).length;
  const invoiceConf = clamp((invDigits / 8) * 0.7 + (invoiceNumber ? 0.3 : 0), 0, 1);
  const vendorConf = vendor?.matched
    ? 0.95
    : vendor?.vendorNorm && vendor.vendorNorm !== "UNKNOWN_VENDOR"
      ? 0.65
      : 0.0;

  return {
    pageIndex: pageNumber,
    vendorRaw: vendor?.vendorRaw || "UNKNOWN_VENDOR",
    vendorNorm: vendor?.vendorNorm || "UNKNOWN_VENDOR",
    vendorMatched: !!vendor?.matched,
    vendorConfidence: Number(vendorConf.toFixed(3)),
    invoiceNumber: invoiceNumber || "",
    invoiceConfidence: Number(invoiceConf.toFixed(3)),
    debug: {
      source: "image_ocr_full",
      topVendorText: regions.topVendorText,
      topLeftText: regions.topLeftText,
      topMiddleText: regions.topMiddleText,
      topRightText: regions.topRightText,
      logoBestText: logoDebug?.bestText || "",
      logoTopLeftText: logoDebug?.topLeftText || "",
      logoTopCenterText: logoDebug?.topCenterText || "",
      logoTopRightText: logoDebug?.topRightText || ""
    }
  };
}

/**
 * Batch variant: extract fields for multiple pages (sequential to keep memory stable).
 */
export async function extractInvoiceFieldsFromPdfPages({ pdfPath, pageNumbers }) {
  const out = [];
  for (const p of pageNumbers || []) {
    out.push(await extractInvoiceFieldsFromPdfPage({ pdfPath, pageNumber: p }));
  }
  return out;
}
