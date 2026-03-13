import fs from "fs";
import { PDFDocument } from "pdf-lib";
import archiver from "archiver";
import { sanitizeFilenameStem, stripUnitedCorporatePhrase } from "./normalize.js";

function sanitizeFolderName(name) {
  const cleaned = stripUnitedCorporatePhrase(name).trim();
  return String(cleaned || "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function uniqueFilename(stem, used) {
  // IMPORTANT: Do NOT re-normalize into digits-only invoice tokens here.
  // If the invoice number differs, we want the base filename to differ too.
  // (Previously, normalizeVendorInvoiceStem() could collapse distinct invoice IDs into "unknownInvoice".)
  const raw = stripUnitedCorporatePhrase(String(stem || "OUTPUT")).replace(/\.pdf$/i, "").trim();
  const base = sanitizeFilenameStem(raw) || "output_unknownInvoice";

  let name = `${base}.pdf`;
  let n = 2;

  // Windows is case-insensitive; track used names in a case-insensitive way to avoid collisions on unzip.
  const key = (s) => String(s || "").toLowerCase();

  while (used.has(key(name))) {
    name = `${base}_${n}.pdf`;
    n++;
  }
  used.add(key(name));
  return name;
}



/**
 * Split ONE PDF based on groups: [{ pages:[1,2], suggestedStem:"VENDOR_123" }]
 * Streams a ZIP to the response.
 */
export async function streamSplitZip({ pdfPath, groups, res, zipName = "split_invoices.zip", folderPrefix = "" }) {
  const srcBytes = fs.readFileSync(pdfPath);
  const srcPdf = await PDFDocument.load(srcBytes);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    try { res.status(500).end(String(err?.message || err)); } catch {}
  });
  archive.pipe(res);

  const folder = folderPrefix ? sanitizeFolderName(folderPrefix) : "";
  const used = new Set();

  for (const g of groups) {
    const pages = (g.pages || [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= srcPdf.getPageCount());
    if (!pages.length) continue;

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, pages.map((p) => p - 1));
    copied.forEach((pg) => outPdf.addPage(pg));

    const stem = g.suggestedStem || g.stem || "OUTPUT";
    const filename = uniqueFilename(stem, used);

    const bytes = await outPdf.save();
    const entryName = folder ? `${folder}/${filename}` : filename;
    archive.append(Buffer.from(bytes), { name: entryName });
  }

  await archive.finalize();
}


/**
 * Split MANY PDFs and package everything into one ZIP.
 * items: [{ pdfPath, groups, folderName, sourceName }]
 */
export async function streamBatchZip({ items, res, zipName = "batch_split_invoices.zip", onProgress }) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    try { res.status(500).end(String(err?.message || err)); } catch {}
  });
  archive.pipe(res);

  let totalGroups = 0;
  for (const it of items) totalGroups += Array.isArray(it.groups) ? it.groups.length : 0;

  let doneGroups = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const folder = sanitizeFolderName(it.folderName || it.sourceName || `FILE_${i + 1}`) || `FILE_${i + 1}`;
    const used = new Set();

    const srcBytes = fs.readFileSync(it.pdfPath);
    const srcPdf = await PDFDocument.load(srcBytes);

    const groups = Array.isArray(it.groups) ? it.groups : [];
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const g = groups[gIdx];
      const pages = (g.pages || [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= srcPdf.getPageCount());
      if (!pages.length) continue;

      const outPdf = await PDFDocument.create();
      const copied = await outPdf.copyPages(srcPdf, pages.map((p) => p - 1));
      copied.forEach((pg) => outPdf.addPage(pg));

      const stem = g.suggestedStem || g.stem || "OUTPUT";
      const filename = uniqueFilename(stem, used);
      const bytes = await outPdf.save();

      archive.append(Buffer.from(bytes), { name: `${folder}/${filename}` });

      doneGroups++;
      if (onProgress) {
        onProgress({
          doneGroups,
          totalGroups,
          fileIndex: i + 1,
          fileTotal: items.length,
          fileName: it.sourceName || folder,
          groupIndex: gIdx + 1,
          groupTotal: groups.length,
          outputName: filename
        });
      }
    }
  }

  await archive.finalize();
}
