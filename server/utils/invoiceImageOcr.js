import Jimp from "jimp";
import { loadVendorIndex } from "./vendorStore.js";
import { findInvoiceNumber, findVendor } from "./detect.js";
import { recognizePng } from "./tesseractShared.js";
import { ocrLogoTextFromImageBuffer } from "./logoOcr.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// When vendor is UNKNOWN after header + logo OCR, OCR the remainder of the image to
// look for stable mailing addresses (used by address-to-vendor overrides).
const IMAGE_OCR_ADDRESS_START_FRACTION = Number(process.env.IMAGE_OCR_ADDRESS_START_FRACTION || 0.22);

async function preprocessRegion(jimpImg) {
  // Light, cheap preprocessing that works well across varied scans.
  // Avoid over-thresholding (can erase faint digits).
  const img = jimpImg.clone();
  try {
    img.greyscale();
    img.normalize();
    img.contrast(0.35);
  } catch {}

  // Upscale small crops (helps invoice number OCR)
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const maxDim = Math.max(w, h);
  if (maxDim && maxDim < 900) {
    const scale = 900 / maxDim;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    img.resize(nw, nh, Jimp.RESIZE_BICUBIC);
  }

  return img;
}

async function preprocessRegionLightGreyText(jimpImg) {
  // Stronger preprocessing to surface faint/light-grey header text.
  const img = jimpImg.clone();
  try {
    img.greyscale();
    img.normalize();
    img.contrast(0.6);
    img.brightness(-0.12);

    img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (_x, _y, idx) {
      const v = this.bitmap.data[idx] || 0;
      let nv = v;
      if (v >= 245) nv = 255;
      else if (v >= 210) nv = Math.max(0, v - 55);
      this.bitmap.data[idx] = nv;
      this.bitmap.data[idx + 1] = nv;
      this.bitmap.data[idx + 2] = nv;
    });
  } catch {}

  // Upscale small crops (helps OCR)
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const maxDim = Math.max(w, h);
  if (maxDim && maxDim < 900) {
    const scale = 900 / maxDim;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    img.resize(nw, nh, Jimp.RESIZE_BICUBIC);
  }

  return img;
}

/**
 * OCR top-third regions for a standalone image (png/jpg).
 * Mirrors the PDF page strategy (vendor is usually top-left/top-middle; invoice # top-right).
 */
export async function ocrTopThirdRegionsFromImageBuffer(imageBuffer) {
  const img0 = await Jimp.read(imageBuffer);
  const img = img0.clone();

  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const topH = Math.max(1, Math.floor(h / 3));
  const thirdW = Math.max(1, Math.floor(w / 3));

  const left = await preprocessRegion(img.clone().crop(0, 0, thirdW, topH));
  const mid = await preprocessRegion(img.clone().crop(thirdW, 0, thirdW, topH));
  const right = await preprocessRegion(img.clone().crop(thirdW * 2, 0, w - thirdW * 2, topH));
  const vendor = await preprocessRegion(img.clone().crop(0, 0, Math.max(1, Math.floor(w * (2 / 3))), topH));
  const full = await preprocessRegion(img.clone().crop(0, 0, w, topH));

  const leftBuf = await left.getBufferAsync(Jimp.MIME_PNG);
  const midBuf = await mid.getBufferAsync(Jimp.MIME_PNG);
  const rightBuf = await right.getBufferAsync(Jimp.MIME_PNG);
  const vendorBuf = await vendor.getBufferAsync(Jimp.MIME_PNG);
  const fullBuf = await full.getBufferAsync(Jimp.MIME_PNG);

  // OCR sequentially via shared worker lock.
  const topLeftText = (await recognizePng(leftBuf, { psm: "6" })).text;
  const topMiddleText = (await recognizePng(midBuf, { psm: "6" })).text;

  // Invoice numbers are commonly digits-only. Tight whitelist + psm 7 improves accuracy.
  const topRight = await recognizePng(rightBuf, { psm: "7", whitelist: "0123456789-" });
  const topRightText = topRight.text;

  // Vendor header is often multiple short lines; sparse-text mode works well.
  const topVendorText = (await recognizePng(vendorBuf, { psm: "11" })).text;

  // Full-width header text (reading order: left -> right, then down).
  const topFullText = (await recognizePng(fullBuf, { psm: "6" })).text;

  return {
    width: w,
    height: h,
    topLeftText,
    topMiddleText,
    topRightText,
    topVendorText,
    topFullText
  };
}

/**
 * Extract invoice number + vendor name from a standalone image buffer.
 * Returns both raw and normalized vendor along with simple confidence signals.
 */
export async function extractInvoiceFieldsFromImageBuffer(imageBuffer) {
  const vendorIndex = loadVendorIndex();

  const regions = await ocrTopThirdRegionsFromImageBuffer(imageBuffer);

  const invoiceNumber = findInvoiceNumber({
    right: regions.topRightText,
    middle: regions.topMiddleText,
    left: regions.topLeftText,
    full: regions.topFullText || `${regions.topVendorText}\n${regions.topLeftText}\n${regions.topMiddleText}\n${regions.topRightText}`
  });

  const vendor = findVendor(
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

  // If vendor is still unknown, try a light-grey enhanced OCR pass for top-left + vendor band.
  let finalVendor = vendor;
  let lightGreyDebug = { topLeftText: "", topVendorText: "" };
  if (!finalVendor?.vendorNorm || finalVendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const img0 = await Jimp.read(imageBuffer);
      const img = img0.clone();

      const w = img.bitmap.width;
      const h = img.bitmap.height;
      const topH = Math.max(1, Math.floor(h / 3));
      const thirdW = Math.max(1, Math.floor(w / 3));

      const left = await preprocessRegionLightGreyText(img.clone().crop(0, 0, thirdW, topH));
      const vendorBand = await preprocessRegionLightGreyText(img.clone().crop(0, 0, Math.max(1, Math.floor(w * (2 / 3))), topH));
      const fullBand = await preprocessRegionLightGreyText(img.clone().crop(0, 0, w, topH));

      const leftBuf = await left.getBufferAsync(Jimp.MIME_PNG);
      const vendorBuf = await vendorBand.getBufferAsync(Jimp.MIME_PNG);
      const fullBuf = await fullBand.getBufferAsync(Jimp.MIME_PNG);

      const topLeftText = (await recognizePng(leftBuf, { psm: "6" })).text;
      const topVendorText = (await recognizePng(vendorBuf, { psm: "11" })).text;
      const topFullText = (await recognizePng(fullBuf, { psm: "6" })).text;
      lightGreyDebug = { topLeftText, topVendorText, topFullText };

      const v2 = findVendor(
        {
          topVendorText,
          topLeftText,
          topFullText,
          full: topFullText || `${topVendorText}\n${topLeftText}`
        },
        vendorIndex
      );

      if (v2?.vendorNorm && v2.vendorNorm !== "UNKNOWN_VENDOR") finalVendor = v2;
    } catch {
      // ignore light-grey OCR failures
    }
  }

  // Last resort: try OCR on likely logo regions (top band) before giving up.
  let logoDebug = null;
  if (!finalVendor?.vendorNorm || finalVendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const logo = await ocrLogoTextFromImageBuffer(imageBuffer);
      logoDebug = logo;
      const v2 = findVendor({ topVendorText: logo.bestText, full: logo.bestText }, vendorIndex);
      if (v2?.vendorNorm && v2.vendorNorm !== "UNKNOWN_VENDOR") finalVendor = v2;
    } catch {
      // ignore logo OCR failures
    }
  }

  // LAST-LAST resort: OCR below-header content to trigger address-based overrides.
  if (!finalVendor?.vendorNorm || finalVendor.vendorNorm === "UNKNOWN_VENDOR") {
    try {
      const img0 = await Jimp.read(imageBuffer);
      const img = img0.clone();
      const w = img.bitmap.width;
      const h = img.bitmap.height;

      const frac = Math.max(0.12, Math.min(0.65, Number(IMAGE_OCR_ADDRESS_START_FRACTION) || 0.22));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(h * frac)));
      const hh = Math.max(1, h - y0);

      const below = await preprocessRegion(img.clone().crop(0, y0, w, hh));
      const belowBuf = await below.getBufferAsync(Jimp.MIME_PNG);
      const addressText = (await recognizePng(belowBuf, { psm: "6" })).text;

      if (addressText && addressText.trim()) {
        const vAddr = findVendor(
          {
            topFullText: regions.topFullText,
            topLeftText: regions.topLeftText,
            full: "",
            fullRaw: addressText
          },
          vendorIndex
        );
        if (vAddr?.vendorNorm && vAddr.vendorNorm !== "UNKNOWN_VENDOR") finalVendor = vAddr;
      }
    } catch {
      // ignore address OCR failures
    }
  }

  // Very lightweight confidence proxy:
  // - invoice confidence: based on length and digits
  // - vendor confidence: matched vendor list is high confidence
  const invDigits = (String(invoiceNumber || "").match(/\d/g) || []).length;
  const invoiceConf = clamp((invDigits / 8) * 0.7 + (invoiceNumber ? 0.3 : 0), 0, 1);
  const vendorConf = finalVendor?.matched
    ? 0.95
    : finalVendor?.vendorNorm && finalVendor.vendorNorm !== "UNKNOWN_VENDOR"
      ? 0.65
      : 0.0;

  return {
    vendorRaw: finalVendor?.vendorRaw || "UNKNOWN_VENDOR",
    vendorNorm: finalVendor?.vendorNorm || "UNKNOWN_VENDOR",
    vendorMatched: !!finalVendor?.matched,
    vendorConfidence: Number(vendorConf.toFixed(3)),
    invoiceNumber: invoiceNumber || "",
    invoiceConfidence: Number(invoiceConf.toFixed(3)),
    debug: {
      topVendorText: regions.topVendorText,
      topLeftText: regions.topLeftText,
      topMiddleText: regions.topMiddleText,
      topRightText: regions.topRightText,
      lightGreyTopVendorText: lightGreyDebug.topVendorText,
      lightGreyTopLeftText: lightGreyDebug.topLeftText,
      lightGreyTopFullText: lightGreyDebug.topFullText,
      logoBestText: logoDebug?.bestText || "",
      logoTopLeftText: logoDebug?.topLeftText || "",
      logoTopCenterText: logoDebug?.topCenterText || "",
      logoTopRightText: logoDebug?.topRightText || ""
    }
  };
}
