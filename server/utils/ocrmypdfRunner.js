import { spawn, spawnSync } from "child_process";

// Cache the detected runner so we don't re-probe every request.
let _cached = null;

function _splitCmdline(cmdline) {
  // Minimal parser: supports quoted segments, otherwise splits on whitespace.
  // Good enough for values like:  ocrmypdf  OR  "C:\\Path\\ocrmypdf.exe"  OR  py -m ocrmypdf
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmdline))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function _runnerOk(runner) {
  try {
    const r = spawnSync(runner.cmd, [...runner.prefixArgs, "--version"], {
      timeout: 1500,
      windowsHide: true
    });
    return r && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detects how to run OCRmyPDF on this machine.
 *
 * Returns a runner object:
 *   { cmd: string, prefixArgs: string[], display: string }
 * or null if not available.
 *
 * Supports:
 *   - "ocrmypdf" on PATH
 *   - "py -m ocrmypdf" (Windows python launcher)
 *   - "python -m ocrmypdf" / "python3 -m ocrmypdf"
 *   - env override: OCRMYPDF_CMDLINE (e.g. "py -m ocrmypdf")
 */
export function getOcrmypdfRunner() {
  if (_cached !== null) return _cached;

  // 1) Explicit override
  const override = String(process.env.OCRMYPDF_CMDLINE || "").trim();
  if (override) {
    const parts = _splitCmdline(override);
    if (parts.length) {
      const runner = { cmd: parts[0], prefixArgs: parts.slice(1), display: override };
      if (_runnerOk(runner)) {
        _cached = runner;
        return _cached;
      }
    }
  }

  // 2) Standard CLI
  const cli = { cmd: "ocrmypdf", prefixArgs: [], display: "ocrmypdf" };
  if (_runnerOk(cli)) {
    _cached = cli;
    return _cached;
  }

  // 3) Python module fallbacks (helps when installed via pip but entrypoint isn't on PATH)
  const pyRunner = { cmd: "py", prefixArgs: ["-m", "ocrmypdf"], display: "py -m ocrmypdf" };
  if (_runnerOk(pyRunner)) {
    _cached = pyRunner;
    return _cached;
  }

  const pythonRunner = { cmd: "python", prefixArgs: ["-m", "ocrmypdf"], display: "python -m ocrmypdf" };
  if (_runnerOk(pythonRunner)) {
    _cached = pythonRunner;
    return _cached;
  }

  const python3Runner = { cmd: "python3", prefixArgs: ["-m", "ocrmypdf"], display: "python3 -m ocrmypdf" };
  if (_runnerOk(python3Runner)) {
    _cached = python3Runner;
    return _cached;
  }

  _cached = null;
  return _cached;
}

/** Spawn OCRmyPDF using the detected runner. */
export function spawnOcrmypdf(args, options = {}) {
  const runner = getOcrmypdfRunner();
  if (!runner) {
    const err = new Error(
      "OCRmyPDF is not available. Install it or set OCRMYPDF_CMDLINE (e.g. 'py -m ocrmypdf')."
    );
    err.code = "ENOENT";
    throw err;
  }
  return spawn(runner.cmd, [...runner.prefixArgs, ...args], { windowsHide: true, ...options });
}
