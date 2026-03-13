import Jimp from "jimp";
import { recognizePng, terminateWorker } from "./tesseractShared.js";

// Logo OCR is a LAST RESORT before returning UNKNOWN_VENDOR.
// We try a few small top-band crops where logos commonly appear and OCR them with settings
// tuned for sparse text.

const LOGO_OCR_TIMEOUT_MS = Number(process.env.LOGO_OCR_TIMEOUT_MS || 90000);
const LOGO_OCR_MAX_DIM = Number(process.env.LOGO_OCR_MAX_DIM || 1400);

function withTimeout(promise, ms, label, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(async () => {
      try {
        await onTimeout?.();
      } catch {}
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function downscaleInPlace(jimpImg, maxDim) {
  if (!maxDim || maxDim <= 0) return jimpImg;
  const w = jimpImg.bitmap.width;
  const h = jimpImg.bitmap.height;
  const m = Math.max(w, h);
  if (m <= maxDim) return jimpImg;
  if (w >= h) return jimpImg.resize(maxDim, Jimp.AUTO);
  return jimpImg.resize(Jimp.AUTO, maxDim);
}

function estimateLuma(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const data = img.bitmap.data;
  const step = Math.max(4, Math.floor(Math.min(w, h) / 120));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const idx = (w * y + x) * 4;
      const r = data[idx] || 0;
      const g = data[idx + 1] || 0;
      const b = data[idx + 2] || 0;
      // ITU-R BT.709 luma
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return n ? sum / n : 255;
}

async function recognizeLogoPng(buf, psm) {
  // If OCR times out, reset the shared worker so the next job doesn't get stuck.
  const r = await withTimeout(
    recognizePng(buf, { psm }),
    LOGO_OCR_TIMEOUT_MS,
    "logo tesseract recognize",
    async () => terminateWorker()
  );
  return String(r?.text || "");
}

async function ocrCrop(img, x, y, w, h) {
  const c = img.clone().crop(x, y, w, h);
  try {
    c.greyscale();
    c.normalize();
    c.contrast(0.4);

    // If the crop is very dark, invert it (logos on dark headers).
    const luma = estimateLuma(c);
    if (Number.isFinite(luma) && luma < 85) c.invert();

    downscaleInPlace(c, LOGO_OCR_MAX_DIM);
  } catch {}

  const buf = await c.getBufferAsync(Jimp.MIME_PNG);

  // Sparse-text mode first; if it yields almost nothing, fall back to block mode.
  const t11 = (await recognizeLogoPng(buf, "11")).trim();
  const letters11 = (t11.match(/[A-Za-z]/g) || []).length;
  if (letters11 >= 3) return t11;
  const t6 = (await recognizeLogoPng(buf, "6")).trim();
  const letters6 = (t6.match(/[A-Za-z]/g) || []).length;
  return letters6 > letters11 ? t6 : t11;
}

/**
 * OCR likely logo regions from a full-page image (PNG buffer).
 * Returns { bestText, topLeftText, topCenterText, topRightText }.
 */
export async function ocrLogoTextFromPngBuffer(pngBuffer) {
  const img0 = await Jimp.read(pngBuffer);
  const img = img0.clone();

  const w = img.bitmap.width;
  const h = img.bitmap.height;

  // Logos usually live in the top band.
  const bandH = Math.max(120, Math.floor(h * 0.22));
  const boxW = Math.max(140, Math.floor(w * 0.4));

  const boxes = {
    topLeft: { x: 0, y: 0, w: Math.min(boxW, w), h: Math.min(bandH, h) },
    topCenter: { x: Math.max(0, Math.floor(w * 0.3)), y: 0, w: Math.min(boxW, w - Math.floor(w * 0.3)), h: Math.min(bandH, h) },
    topRight: { x: Math.max(0, w - boxW), y: 0, w: Math.min(boxW, w), h: Math.min(bandH, h) }
  };

  const topLeftText = await ocrCrop(img, boxes.topLeft.x, boxes.topLeft.y, boxes.topLeft.w, boxes.topLeft.h);
  const topCenterText = await ocrCrop(img, boxes.topCenter.x, boxes.topCenter.y, boxes.topCenter.w, boxes.topCenter.h);
  const topRightText = await ocrCrop(img, boxes.topRight.x, boxes.topRight.y, boxes.topRight.w, boxes.topRight.h);

  const pick = (a, b) => {
    const la = (String(a || "").match(/[A-Za-z]/g) || []).length;
    const lb = (String(b || "").match(/[A-Za-z]/g) || []).length;
    return lb > la ? b : a;
  };

  let bestText = "";
  bestText = pick(bestText, topLeftText);
  bestText = pick(bestText, topCenterText);
  bestText = pick(bestText, topRightText);

  // Keep it compact for downstream vendor matching.
  bestText = String(bestText || "").replace(/\s+\n/g, "\n").trim();

  return { bestText, topLeftText, topCenterText, topRightText };
}

/**
 * Convenience wrapper for raw image uploads (png/jpg converted by Jimp).
 */
export async function ocrLogoTextFromImageBuffer(imageBuffer) {
  // Jimp.read accepts jpg/png/etc and returns an image we can re-encode to PNG for OCR.
  const img0 = await Jimp.read(imageBuffer);
  const png = await img0.getBufferAsync(Jimp.MIME_PNG);
  return ocrLogoTextFromPngBuffer(png);
}
