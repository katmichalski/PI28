import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWorker } from "tesseract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOCAL_LANG_DIR = process.env.TESSERACT_LANG_PATH || path.join(SERVER_ROOT, "tessdata");
const DEFAULT_REMOTE_LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0_fast";
const REMOTE_LANG_PATH =
  process.env.TESSERACT_REMOTE_LANG_PATH === ""
    ? null
    : (process.env.TESSERACT_REMOTE_LANG_PATH || DEFAULT_REMOTE_LANG_PATH);

function hasLocalEng(dir) {
  try {
    return Boolean(dir) && fs.existsSync(path.join(dir, "eng.traineddata"));
  } catch {
    return false;
  }
}

const USING_LOCAL_ENG = hasLocalEng(LOCAL_LANG_DIR);
const EFFECTIVE_LANG_PATH = USING_LOCAL_ENG ? LOCAL_LANG_DIR : (REMOTE_LANG_PATH || LOCAL_LANG_DIR);

function assertLangAvailable() {
  if (USING_LOCAL_ENG) return;
  if (REMOTE_LANG_PATH) return;
  throw new Error(
    "Tesseract language data missing: server/tessdata/eng.traineddata. " +
      "Put eng.traineddata into server/tessdata or set TESSERACT_REMOTE_LANG_PATH."
  );
}

const WORKER_INIT_TIMEOUT_MS = toPositiveInt(process.env.TESSERACT_WORKER_INIT_TIMEOUT_MS, 120000);
const WORKER_INIT_RETRIES = toPositiveInt(process.env.TESSERACT_WORKER_INIT_RETRIES, 1);
const WORKER_RETRY_DELAY_MS = toPositiveInt(process.env.TESSERACT_WORKER_RETRY_DELAY_MS, 1500);
const WORKER_IDLE_TERMINATE_MS = toPositiveInt(process.env.TESSERACT_WORKER_IDLE_TERMINATE_MS, 10 * 60 * 1000);

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

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

let workerPromise = null;
let workerInstance = null;
let queue = Promise.resolve();
let idleTimer = null;
let lastUsedAt = 0;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function clearWorkerRefs() {
  workerPromise = null;
  workerInstance = null;
  clearIdleTimer();
}

async function safelyTerminate(worker) {
  try {
    if (worker) await worker.terminate();
  } catch {}
}

function markWorkerUsed() {
  lastUsedAt = Date.now();
  clearIdleTimer();

  if (!WORKER_IDLE_TERMINATE_MS || WORKER_IDLE_TERMINATE_MS <= 0) return;

  idleTimer = setTimeout(async () => {
    const idleFor = Date.now() - lastUsedAt;
    if (idleFor < WORKER_IDLE_TERMINATE_MS) return;
    await terminateWorker();
  }, WORKER_IDLE_TERMINATE_MS + 50);
}

function buildInitError(err, attempt, timeoutMs) {
  const base = String(err?.message || err || "Unknown Tesseract initialization error");
  const remoteNote = !USING_LOCAL_ENG && REMOTE_LANG_PATH
    ? ` Local eng.traineddata was not found, so OCR is using remote language data (${EFFECTIVE_LANG_PATH}).`
    : "";

  return new Error(
    `Tesseract worker init failed on attempt ${attempt + 1}/${WORKER_INIT_RETRIES + 1} ` +
      `(timeout ${timeoutMs}ms). ${base}.${remoteNote}`
  );
}

async function createWorkerOnce(timeoutMs) {
  const options = {
    langPath: EFFECTIVE_LANG_PATH,
    corePath: CORE_DIR || undefined,
    logger: () => {},
    gzip: USING_LOCAL_ENG ? false : true
  };

  const worker = await withTimeout(
    createWorker("eng", 1, options),
    timeoutMs,
    "tesseract worker init"
  );

  await worker.setParameters({
    tessedit_pageseg_mode: "6"
  });

  workerInstance = worker;
  markWorkerUsed();
  return worker;
}

async function initializeWorker() {
  assertLangAvailable();

  let lastError;

  for (let attempt = 0; attempt <= WORKER_INIT_RETRIES; attempt++) {
    const timeoutMs = WORKER_INIT_TIMEOUT_MS * (attempt + 1);
    try {
      return await createWorkerOnce(timeoutMs);
    } catch (err) {
      lastError = buildInitError(err, attempt, timeoutMs);
      await safelyTerminate(workerInstance);
      workerInstance = null;

      if (attempt < WORKER_INIT_RETRIES) {
        await sleep(WORKER_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError;
}

async function getWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = initializeWorker().catch((err) => {
    clearWorkerRefs();
    throw err;
  });

  return workerPromise;
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function runRecognize(pngBuffer, opts = {}) {
  const worker = await getWorker();

  const params = {};
  if (opts.psm != null) params.tessedit_pageseg_mode = String(opts.psm);
  if (opts.whitelist) params.tessedit_char_whitelist = String(opts.whitelist);
  if (Object.keys(params).length) {
    await worker.setParameters(params);
  }

  markWorkerUsed();
  const result = await worker.recognize(pngBuffer);
  const raw = result?.data?.text || "";
  markWorkerUsed();

  return {
    text: normalizeText(raw),
    raw
  };
}

export async function recognizePng(pngBuffer, opts = {}) {
  const run = async () => {
    try {
      return await runRecognize(pngBuffer, opts);
    } catch (err) {
      const msg = String(err?.message || err || "");
      const looksRecoverable = /timed out|terminated|worker|network|fetch|load|EPIPE|ECONN|ENOENT/i.test(msg);
      if (!looksRecoverable) throw err;

      await terminateWorker();
      return await runRecognize(pngBuffer, opts);
    }
  };

  const p = queue.then(run, run);
  queue = p.then(
    () => {},
    () => {}
  );
  return p;
}

export function getTessdataStatus() {
  return {
    localEng: USING_LOCAL_ENG,
    effectiveLangPath: EFFECTIVE_LANG_PATH,
    usingRemote: !USING_LOCAL_ENG && Boolean(REMOTE_LANG_PATH),
    workerInitTimeoutMs: WORKER_INIT_TIMEOUT_MS,
    workerInitRetries: WORKER_INIT_RETRIES,
    workerRetryDelayMs: WORKER_RETRY_DELAY_MS,
    workerIdleTerminateMs: WORKER_IDLE_TERMINATE_MS,
    coreDir: CORE_DIR || null,
    workerPath: null
  };
}

export async function warmTesseractWorker() {
  const worker = await getWorker();
  markWorkerUsed();
  return Boolean(worker);
}

export async function terminateWorker() {
  const w = workerInstance;
  clearWorkerRefs();
  queue = Promise.resolve();
  await safelyTerminate(w);
}