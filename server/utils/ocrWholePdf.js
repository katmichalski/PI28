import fs from "fs";
import { spawnOcrmypdf } from "./ocrmypdfRunner.js";
import { quickPdfTextStatsFromPath } from "./pdfText.js";

/**
 * Tries to OCR the entire PDF using OCRmyPDF (if installed).
 * Returns { path, ocrApplied, ocrError }.
 *
 * If OCRmyPDF isn't installed or fails, returns the original path.
 */
export async function ensureSearchablePdf({ inputPath, outputPath, force }) {
  // If output already exists, reuse it.
  if (fs.existsSync(outputPath)) {
    return { path: outputPath, ocrApplied: true, ocrError: null, kind: "pdf_ocr_cached" };
  }

  // Determine what kind of PDF we have *before* running OCR, so we can avoid
  // expensive OCR on PDFs that are already searchable and tune behavior for mixed/scanned PDFs.
  let kind = "pdf_unknown";
  let stats = null;
  try {
    stats = await quickPdfTextStatsFromPath(inputPath, {
      maxPages: Number(process.env.PDF_TYPE_SAMPLE_PAGES || 3),
      minCharsPerPage: Number(process.env.PDF_TYPE_MIN_CHARS_PER_PAGE || 20)
    });

    const ratio = stats.samplePages ? stats.pagesWithText / stats.samplePages : 0;
    const avg = Number(stats.avgChars || 0);

    if (stats.pagesWithText === 0) {
      kind = "pdf_image"; // scanned/image-only
    } else if (ratio >= 0.8 && avg >= 60) {
      kind = "pdf_text"; // already searchable
    } else {
      kind = "pdf_mixed"; // some text, some scans
    }
  } catch {
    // If classification fails, fall back to OCRmyPDF attempt.
    kind = "pdf_unknown";
  }

  // If the PDF is already searchable, skip OCRmyPDF unless FORCE_OCR is set.
  if (!force && kind === "pdf_text") {
    return { path: inputPath, ocrApplied: false, ocrError: null, kind, stats };
  }

  // Build OCRmyPDF args based on file type.
  // - pdf_mixed: use --skip-text (default) so only non-searchable pages are OCR'd.
  // - pdf_image: same flags, plus optional cleanup.
  // - force: remove --skip-text to OCR everything.
  const args = [];
  if (!force) args.push("--skip-text");
  args.push("--rotate-pages", "--deskew");

  // Light cleanup that improves OCR on scans. Disable via env if it causes issues.
  const cleanFinal = String(process.env.OCRMYPDF_CLEAN_FINAL || "1") === "1";
  if (cleanFinal && (kind === "pdf_image" || kind === "pdf_mixed" || kind === "pdf_unknown")) {
    args.push("--clean-final");
  }

  const removeBg = String(process.env.OCRMYPDF_REMOVE_BACKGROUND || "0") === "1";
  if (removeBg && (kind === "pdf_image" || kind === "pdf_unknown")) {
    args.push("--remove-background");
  }

  const jobs = Number(process.env.OCRMYPDF_JOBS || 0);
  if (Number.isFinite(jobs) && jobs > 0) {
    args.push("--jobs", String(jobs));
  }

  args.push("--output-type", "pdf", inputPath, outputPath);

  const timeoutMs = Number(process.env.OCRMYPDF_TIMEOUT_MS || 20 * 60 * 1000);

  return await new Promise((resolve) => {
    let proc;
    try {
      proc = spawnOcrmypdf(args);
    } catch (err) {
      // Not installed / not available
      return resolve({ path: inputPath, ocrApplied: false, ocrError: String(err?.message || err), kind, stats });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ path: inputPath, ocrApplied: false, ocrError: String(err?.message || err), kind, stats });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // cleanup partial
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        return resolve({
          path: inputPath,
          ocrApplied: false,
          ocrError: `ocrmypdf timed out after ${timeoutMs}ms`,
          kind,
          stats
        });
      }
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ path: outputPath, ocrApplied: true, ocrError: null, kind: `${kind}_ocr_applied`, stats });
      } else {
        // cleanup partial
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        resolve({
          path: inputPath,
          ocrApplied: false,
          ocrError: stderr ? stderr.slice(0, 5000) : `ocrmypdf exit code ${code}`,
          kind,
          stats
        });
      }
    });
  });
}
