import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const OCR_TIMEOUT_MS = Number(process.env.OCRMYPDF_TIMEOUT_MS || 30 * 60 * 1000);
const OCR_LANGUAGE = String(process.env.OCRMYPDF_LANGUAGE || "eng").trim();
const OCR_JOBS = Number(process.env.OCRMYPDF_JOBS || 2);

function toPlainUint8Array(data) {
  if (!data) {
    throw new Error("No PDF data was provided.");
  }

  if (Buffer.isBuffer(data)) {
    return Uint8Array.from(data);
  }

  if (data instanceof Uint8Array) {
    return data.constructor === Uint8Array ? data : Uint8Array.from(data);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  throw new Error("Expected PDF data as Buffer, Uint8Array, or ArrayBuffer.");
}

function countAlphaNum(text = "") {
  const matches = String(text).match(/[A-Za-z0-9]/g);
  return matches ? matches.length : 0;
}

function hasUsableText(text = "") {
  return countAlphaNum(text) >= 20;
}

function shouldRunOcr(pageTexts = []) {
  if (!Array.isArray(pageTexts) || !pageTexts.length) return true;
  return pageTexts.some((text) => !hasUsableText(text));
}

function bucketY(y) {
  return Math.round(Number(y || 0) / 2) * 2;
}

function joinLineTokens(tokens) {
  if (!tokens.length) return "";

  const sorted = [...tokens].sort((a, b) => a.x - b.x);
  let out = "";
  let prev = null;

  for (const token of sorted) {
    const text = String(token.str || "").trim();
    if (!text) continue;

    if (!prev) {
      out = text;
      prev = token;
      continue;
    }

    const prevRight = prev.x + (prev.width || 0);
    const gap = token.x - prevRight;

    if (gap > 20) {
      out += "    ";
    } else if (
      !out.endsWith(" ") &&
      !/^[,.;:!?)}\]%]/.test(text) &&
      !/[({[/]$/.test(prev.str || "")
    ) {
      out += " ";
    }

    out += text;
    prev = token;
  }

  return out.replace(/[ \t]+/g, " ").trim();
}

async function extractPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);

  try {
    const textContent = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const items = (textContent.items || [])
      .map((item) => {
        const str = String(item?.str || "").trim();
        if (!str) return null;

        return {
          str,
          x: Number(item?.transform?.[4] || 0),
          y: Number(item?.transform?.[5] || 0),
          width: Number(item?.width || 0),
        };
      })
      .filter(Boolean);

    if (!items.length) return "";

    const linesMap = new Map();

    for (const item of items) {
      const key = bucketY(item.y);
      if (!linesMap.has(key)) linesMap.set(key, []);
      linesMap.get(key).push(item);
    }

    const sortedY = [...linesMap.keys()].sort((a, b) => b - a);
    const lines = sortedY
      .map((y) => joinLineTokens(linesMap.get(y)))
      .filter(Boolean);

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    try {
      page.cleanup();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function extractPageTextsFromPdfBuffer(pdfBuffer) {
  const data = toPlainUint8Array(pdfBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });

  const pdf = await loadingTask.promise;

  try {
    const pageTexts = [];

    for (let i = 1; i <= pdf.numPages; i += 1) {
      const text = await extractPageText(pdf, i);
      pageTexts.push(text);
    }

    return pageTexts;
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // ignore destroy errors
    }
  }
}

function buildChildEnv() {
  const env = { ...process.env };

  const prependPathEntry = (absoluteFilePath) => {
    if (!absoluteFilePath) return;
    const dir = path.dirname(absoluteFilePath);
    if (!dir) return;

    const current = env.PATH || "";
    const parts = current.split(path.delimiter).filter(Boolean);

    if (!parts.includes(dir)) {
      env.PATH = `${dir}${path.delimiter}${current}`;
    }
  };

  if (process.env.TESSERACT_PATH) {
    prependPathEntry(process.env.TESSERACT_PATH);
  }

  if (process.env.GHOSTSCRIPT_PATH) {
    prependPathEntry(process.env.GHOSTSCRIPT_PATH);
  }

  return env;
}

function getOcrRunner() {
  const raw = String(
    process.env.OCRMYPDF_RUNNER || process.env.OCR_MYPDF_RUNNER || ""
  ).trim();

  if (!raw || raw === "py -m ocrmypdf") {
    return {
      command: "py",
      baseArgs: ["-m", "ocrmypdf"],
    };
  }

  if (raw === "ocrmypdf") {
    return {
      command: "ocrmypdf",
      baseArgs: [],
    };
  }

  if (raw === "python -m ocrmypdf") {
    return {
      command: "python",
      baseArgs: ["-m", "ocrmypdf"],
    };
  }

  if (raw === "python3 -m ocrmypdf") {
    return {
      command: "python3",
      baseArgs: ["-m", "ocrmypdf"],
    };
  }

  return {
    command: "py",
    baseArgs: ["-m", "ocrmypdf"],
  };
}

function runProcess(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs || OCR_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}\n${stderr || stdout}`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${code}: ${command} ${args.join(" ")}\n${stderr || stdout}`
        )
      );
    });
  });
}

async function runOcrMyPdf(inputPdfPath, outputPdfPath) {
  const runner = getOcrRunner();

  const args = [
    ...runner.baseArgs,
    "--skip-text",
    "--rotate-pages",
    "--deskew",
    "--jobs",
    String(Number.isFinite(OCR_JOBS) && OCR_JOBS > 0 ? OCR_JOBS : 2),
    "--language",
    OCR_LANGUAGE,
    inputPdfPath,
    outputPdfPath,
  ];

  try {
    return await runProcess(runner.command, args, {
      cwd: path.dirname(inputPdfPath),
      env: buildChildEnv(),
      timeoutMs: OCR_TIMEOUT_MS,
    });
  } catch (error) {
    const message = String(error?.message || "");

    if (/\[WinError 2\]/i.test(message)) {
      throw new Error(
        `${message}\nOCRmyPDF is installed, but Windows could not find one or more external OCR dependencies from the Node process. Check that Tesseract OCR and Ghostscript are installed and visible on PATH in the same terminal where you start the server.`
      );
    }

    if (/language data/i.test(message) || /requested languages/i.test(message)) {
      throw new Error(
        `${message}\nOCRmyPDF could not find Tesseract language data for "${OCR_LANGUAGE}". Verify that your system Tesseract installation includes that language and that the same shell running Node can see it.`
      );
    }

    throw error;
  }
}

export async function cleanupDir(dirPath) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

export async function extractPageTexts(inputBuffer) {
  if (!inputBuffer || !Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
    throw new Error("extractPageTexts expected a non-empty PDF buffer.");
  }

  let rawPageTexts = [];
  let rawExtractError = null;

  try {
    rawPageTexts = await extractPageTextsFromPdfBuffer(inputBuffer);

    if (!shouldRunOcr(rawPageTexts)) {
      return rawPageTexts;
    }
  } catch (error) {
    rawExtractError = error;
  }

  const tempDir = path.join(os.tmpdir(), `project-invoice-${randomUUID()}`);
  const inputPdfPath = path.join(tempDir, "input.pdf");
  const ocrPdfPath = path.join(tempDir, "ocr.pdf");

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(inputPdfPath, inputBuffer);

    await runOcrMyPdf(inputPdfPath, ocrPdfPath);

    const ocrBuffer = await fs.readFile(ocrPdfPath);
    const ocrPageTexts = await extractPageTextsFromPdfBuffer(ocrBuffer);

    if (!rawPageTexts.length) {
      return ocrPageTexts;
    }

    const merged = [];
    const maxPages = Math.max(rawPageTexts.length, ocrPageTexts.length);

    for (let i = 0; i < maxPages; i += 1) {
      const rawText = rawPageTexts[i] || "";
      const ocrText = ocrPageTexts[i] || "";

      merged.push(hasUsableText(rawText) ? rawText : ocrText || rawText);
    }

    return merged;
  } catch (ocrError) {
    if (rawPageTexts.length) {
      return rawPageTexts;
    }

    const rawReason = rawExtractError
      ? ` Raw extract error: ${rawExtractError.message}`
      : "";

    throw new Error(
      `Failed to extract text from PDF. OCR fallback also failed: ${ocrError.message}${rawReason}`
    );
  } finally {
    await cleanupDir(tempDir);
  }
}

export default extractPageTexts;