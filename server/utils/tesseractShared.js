import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWorker } from "tesseract.js";

/**
 * Shared Tesseract worker + a simple sequential queue.
 *
 * Why:
 * - Creating a new worker per request is slow and memory-heavy.
 * - Running multiple recognizes concurrently can spike memory.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const LOCAL_LANG_DIR = process.env.TESSERACT_LANG_PATH || path.join(SERVER_ROOT, "tessdata");

// If local tessdata isn't present, fall back to a remote tessdata host.
// This keeps OCR working for users who haven't downloaded eng.traineddata yet.
// You can override or disable by setting TESSERACT_REMOTE_LANG_PATH="".
const DEFAULT_REMOTE_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0_fast";
const REMOTE_LANG_PATH =
  process.env.TESSERACT_REMOTE_LANG_PATH === "" ? null : (process.env.TESSERACT_REMOTE_LANG_PATH || DEFAULT_REMOTE_LANG_PATH);

function hasLocalEng(dir) {
  try {
    return Boolean(dir) && fs.existsSync(path.join(dir, "eng.traineddata"));
  } catch {
    return false;
  }
}

const EFFECTIVE_LANG_PATH = hasLocalEng(LOCAL_LANG_DIR) ? LOCAL_LANG_DIR : (REMOTE_LANG_PATH || LOCAL_LANG_DIR);

// If neither local nor remote is usable, fail fast with a clear message.
function assertLangAvailable() {
  if (hasLocalEng(LOCAL_LANG_DIR)) return;
  if (REMOTE_LANG_PATH) return;
  throw new Error(
    "Tesseract language data missing: server/tessdata/eng.traineddata. " +
      "Run server/scripts/download-eng-tessdata.ps1 (Windows) or download eng.traineddata into server/tessdata."
  );
}

// Avoid a hung worker initialization (can happen if language downloads are blocked).
// Keep this fairly short so the UI can surface a clear warning instead of looking stuck.
const WORKER_INIT_TIMEOUT_MS = Number(process.env.TESSERACT_WORKER_INIT_TIMEOUT_MS || 30000);

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// IMPORTANT (tesseract.js v5+): corePath should be a DIRECTORY that contains all 4 builds
// (wasm, wasm+simd, lstm, lstm+simd). Setting corePath to a single file can be much slower.
// See: tesseract.js docs (performance/local-installation).
const REQUIRED_CORE_FILES = [
  "tesseract-core.wasm.js",
  "tesseract-core-simd.wasm.js",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js"
];

function hasAllCoreFiles(dir) {
  try {
    if (!dir) return false;
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return REQUIRED_CORE_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

function findCoreDir() {
  const env = process.env.TESSERACT_CORE_PATH;
  if (env && hasAllCoreFiles(env)) return env;

  const candidates = [
    path.join(SERVER_ROOT, "node_modules", "tesseract.js-core"),
    path.resolve(SERVER_ROOT, "..", "node_modules", "tesseract.js-core"),
    path.resolve(SERVER_ROOT, "..", "..", "node_modules", "tesseract.js-core")
  ];
  for (const c of candidates) {
    if (hasAllCoreFiles(c)) return c;
  }
  return null;
}

const CORE_DIR = findCoreDir();

const WORKER_PATH =
  process.env.TESSERACT_WORKER_PATH ||
  firstExisting([
    path.join(SERVER_ROOT, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    path.join(SERVER_ROOT, "node_modules", "tesseract.js", "dist", "worker.js"),
    path.resolve(SERVER_ROOT, "..", "node_modules", "tesseract.js", "dist", "worker.min.js"),
    path.resolve(SERVER_ROOT, "..", "node_modules", "tesseract.js", "dist", "worker.js")
  ]);

let workerPromise = null;
let queue = Promise.resolve();

async function getWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    assertLangAvailable();

    // tesseract.js v5+: recommended signature is createWorker(langs, oem, options)
    // so the worker is ready without separate loadLanguage/initialize calls.
    const worker = await withTimeout(
      createWorker("eng", 1, {
        // Prefer local assets to avoid HTTPS download failures on locked-down networks.
        // If local tessdata isn't present, we fall back to a remote tessdata host.
        langPath: EFFECTIVE_LANG_PATH,
        corePath: CORE_DIR || undefined,
        workerPath: WORKER_PATH || undefined,
        logger: () => {}
      }),
      WORKER_INIT_TIMEOUT_MS,
      "tesseract worker init"
    );

    // Reasonable defaults for invoices
    await worker.setParameters({
      tessedit_pageseg_mode: "6" // Assume a uniform block of text
    });

    return worker;
  })();

  return workerPromise;
}

export function getTessdataStatus() {
  return {
    localEng: hasLocalEng(LOCAL_LANG_DIR),
    effectiveLangPath: EFFECTIVE_LANG_PATH,
    usingRemote: !hasLocalEng(LOCAL_LANG_DIR) && Boolean(REMOTE_LANG_PATH)
  };
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/**
 * OCR a PNG buffer.
 * @param {Buffer|Uint8Array} pngBuffer
 * @param {{psm?: string|number, whitelist?: string}} opts
 */
export async function recognizePng(pngBuffer, opts = {}) {
  const run = async () => {
    const worker = await getWorker();

    const params = {};
    if (opts.psm != null) params.tessedit_pageseg_mode = String(opts.psm);
    if (opts.whitelist) params.tessedit_char_whitelist = String(opts.whitelist);
    if (Object.keys(params).length) {
      await worker.setParameters(params);
    }

    const result = await worker.recognize(pngBuffer);
    const raw = result?.data?.text || "";
    return {
      text: normalizeText(raw),
      raw
    };
  };

  // Simple mutex: chain onto the queue so calls run sequentially.
  const p = queue.then(run, run);
  queue = p.then(
    () => {},
    () => {}
  );
  return p;
}

export async function terminateWorker() {
  try {
    const w = await workerPromise;
    if (w) await w.terminate();
  } catch {}
  workerPromise = null;
  queue = Promise.resolve();
}
