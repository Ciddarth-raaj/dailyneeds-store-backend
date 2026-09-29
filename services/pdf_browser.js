/**
 * Puppeteer lifecycle for server-side PDF rendering.
 *
 * WHY THIS EXISTS (2026-09 incident): Chrome processes launched for the
 * stock-checker pending report survived for days and pinned the CPU. The old
 * code launched with `timeout: 0` (puppeteer 19.11.1 then waits FOREVER for
 * the DevTools endpoint and for the initial page target), closed the browser
 * only on the paths that remembered to, and chose the executable from
 * `IS_TEST === "false"`, which production does not set - so production ran
 * the bundled Chromium from ~/.cache/puppeteer instead of the system Chrome.
 *
 * Everything that touches Chrome goes through withBrowser():
 *  - every step (launch, newPage, setContent, pdf, close) is time-bounded;
 *  - cleanup lives in `finally`, so success, any exception, a disconnect and
 *    an abort (the caller's job timeout) all take the same path;
 *  - each launch gets its OWN --user-data-dir. puppeteer spawns Chrome as a
 *    process-group leader (`detached: true` on Linux), so after close we look
 *    for any process still carrying that exact directory on its command line
 *    and SIGKILL its process group. That catches the case where launch()
 *    rejects before handing back a Browser (so there is nothing to close),
 *    and it can only ever hit Chrome started by this invocation - never an
 *    unrelated Chrome on the host. No `pkill chrome`.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const logger = require("../utils/logger");

const SYSTEM_CHROME_PATH = "/usr/bin/google-chrome-stable";

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--disable-background-networking",
  "--disable-extensions",
  "--disable-software-rasterizer",
  "--disable-sync",
  "--disable-translate",
  "--disable-default-apps",
  "--disable-features=site-per-process,IsolateOrigins",
  "--js-flags=--lite-mode",
];

const USER_DATA_DIR_PREFIX = "dn-pdf-chrome-";

// logger.LEVEL.WARN is "warning", which winston's npm levels do not know, so
// such lines are silently dropped. These diagnostics must be seen.
const WARN = "warn";

function positiveIntFromEnv(name, fallback, env = process.env) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** All limits in ms. Every one is finite; env can tune but never disable them. */
function getTimeouts(env = process.env) {
  return {
    launch: positiveIntFromEnv("PDF_LAUNCH_TIMEOUT_MS", 30000, env),
    protocol: positiveIntFromEnv("PDF_PROTOCOL_TIMEOUT_MS", 60000, env),
    page: positiveIntFromEnv("PDF_PAGE_TIMEOUT_MS", 15000, env),
    // Budget for external assets (Google Fonts, the logo on dnds.co.in).
    // When it runs out the PDF is rendered anyway with what has loaded.
    assets: positiveIntFromEnv("PDF_ASSET_TIMEOUT_MS", 10000, env),
    pdf: positiveIntFromEnv("PDF_RENDER_TIMEOUT_MS", 60000, env),
    close: positiveIntFromEnv("PDF_CLOSE_TIMEOUT_MS", 10000, env),
  };
}

/**
 * Which Chrome to run. Deterministic for a given host + environment, and
 * independent of IS_TEST / NODE_ENV (production sets neither reliably):
 *   1. PUPPETEER_EXECUTABLE_PATH or CHROME_PATH, if set. A set-but-missing
 *      path is a configuration error and fails loudly - no silent fallback.
 *   2. /usr/bin/google-chrome-stable, if it exists (the production server).
 *   3. puppeteer's bundled Chromium (developer machines).
 *
 * @returns {{ executablePath: string | undefined, source: "env" | "system" | "bundled", display: string }}
 */
function resolveChromeExecutable(env = process.env, exists = fs.existsSync) {
  const fromEnv = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || "";
  if (fromEnv) {
    if (!exists(fromEnv)) {
      const err = new Error(
        `PUPPETEER_EXECUTABLE_PATH/CHROME_PATH is set to "${fromEnv}" but that file does not exist`
      );
      err.stage = "launch";
      throw err;
    }
    return { executablePath: fromEnv, source: "env", display: fromEnv };
  }
  if (exists(SYSTEM_CHROME_PATH)) {
    return {
      executablePath: SYSTEM_CHROME_PATH,
      source: "system",
      display: SYSTEM_CHROME_PATH,
    };
  }
  let bundled = "(puppeteer bundled chromium)";
  try {
    bundled = puppeteer.executablePath();
  } catch (_) {
    /* display only */
  }
  return { executablePath: undefined, source: "bundled", display: bundled };
}

let loggedSelection = null;

/** user-data-dirs of runs in progress, for killActiveBrowsers() at shutdown. */
const activeUserDataDirs = new Set();

/** Resolve once per process and log the choice once - not on every PDF. */
function getSelectedExecutable() {
  const sel = resolveChromeExecutable();
  const key = `${sel.source}:${sel.display}`;
  if (loggedSelection !== key) {
    loggedSelection = key;
    logger.Log({
      level: sel.source === "bundled" ? WARN : logger.LEVEL.INFO,
      component: "SERVICE.PDF",
      code: "SERVICE.PDF.CHROME_EXECUTABLE",
      description: `Chrome executable for PDFs: ${sel.display} (source: ${sel.source})`,
      category: "",
      ref: { source: sel.source, executable: sel.display },
    });
  }
  return sel;
}

function buildPuppeteerLaunchOptions({ userDataDir, env = process.env } = {}) {
  const sel = resolveChromeExecutable(env);
  const t = getTimeouts(env);
  const opts = {
    headless: "new",
    dumpio: true,
    args: PUPPETEER_ARGS,
    timeout: t.launch,
    protocolTimeout: t.protocol,
  };
  if (sel.executablePath) opts.executablePath = sel.executablePath;
  if (userDataDir) opts.userDataDir = userDataDir;
  return opts;
}

function withStage(err, stage) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!e.stage) e.stage = stage;
  return e;
}

/** Reject after `ms` - a backstop in case puppeteer's own timeout never fires. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms} ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * PIDs whose command line contains `--user-data-dir=<dir>` exactly. Linux
 * only (reads /proc); elsewhere returns [] and cleanup relies on puppeteer.
 */
function findProcessesUsingUserDataDir(dir, procRoot = "/proc") {
  const needle = `--user-data-dir=${dir}`;
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(path.join(procRoot, name, "cmdline"), "utf8");
    } catch (_) {
      continue; // exited meanwhile, or not ours to read
    }
    if (cmdline.split("\0").includes(needle)) out.push(pid);
  }
  return out;
}

function processGroupOf(pid, procRoot = "/proc") {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // pid (comm) state ppid pgrp ... ; comm may contain spaces/parens.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(rest[2]);
    return Number.isFinite(pgrp) && pgrp > 0 ? pgrp : null;
  } catch (_) {
    return null;
  }
}

/**
 * SIGKILL whatever is still running with this invocation's user-data-dir,
 * by process group when that group is Chrome's own (never our own group).
 * @returns {number[]} pids that were found (and signalled)
 */
function killLeftoverChrome(dir) {
  const pids = findProcessesUsingUserDataDir(dir);
  if (!pids.length) return [];
  const ownGroup = processGroupOf(process.pid);
  const groups = new Set();
  for (const pid of pids) {
    const pgrp = processGroupOf(pid);
    if (pgrp && pgrp !== ownGroup && pgrp !== 1) groups.add(pgrp);
    else {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {
        /* already gone */
      }
    }
  }
  for (const g of groups) {
    try {
      process.kill(-g, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
  }
  return pids;
}

function logCleanupProblem(code, description, ref = {}) {
  logger.Log({
    level: WARN,
    component: "SERVICE.PDF",
    code,
    description,
    category: "",
    ref,
  });
}

async function closePageQuietly(page, timeoutMs) {
  if (!page) return;
  try {
    await withTimeout(page.close(), timeoutMs, "page.close");
  } catch (err) {
    // The original error (if any) is what the caller sees; this is noise.
    logCleanupProblem("SERVICE.PDF.PAGE_CLOSE_FAILED", String(err && err.message));
  }
}

async function closeBrowserQuietly(browser, timeoutMs) {
  if (!browser) return;
  try {
    await withTimeout(browser.close(), timeoutMs, "browser.close");
  } catch (err) {
    logCleanupProblem("SERVICE.PDF.BROWSER_CLOSE_FAILED", String(err && err.message));
    try {
      const proc = typeof browser.process === "function" ? browser.process() : null;
      if (proc && proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch (_) {
          proc.kill("SIGKILL");
        }
      }
    } catch (_) {
      /* the user-data-dir sweep below is the last line */
    }
  }
}

/**
 * Render one HTML document to a PDF buffer on an open browser. The page is
 * always closed; a close failure never replaces the render error.
 */
async function renderPdfOnBrowser(browser, html, pdfOptions, ctx) {
  const t = ctx.timeouts;
  ctx.assertUsable();
  let page;
  try {
    ctx.onStage("page");
    try {
      page = await withTimeout(browser.newPage(), t.page, "newPage");
    } catch (err) {
      throw withStage(err, "page");
    }
    page.setDefaultTimeout(t.page);
    page.setDefaultNavigationTimeout(t.page);

    ctx.assertUsable();
    ctx.onStage("content");
    try {
      // "load" covers the logo <img> and the @import-ed stylesheet. It used to
      // be networkidle0 with no limit; now a slow or unreachable dnds.co.in /
      // Google Fonts costs at most the asset budget and the PDF is rendered
      // with whatever arrived (fallback fonts, no logo) instead of hanging.
      try {
        await withTimeout(
          page.setContent(html, { waitUntil: "load", timeout: t.assets }),
          t.assets + 2000,
          "setContent"
        );
      } catch (err) {
        if (!err || err.name !== "TimeoutError") throw err;
        ctx.assetsDegraded = true;
      }
      ctx.assertUsable();
      try {
        await withTimeout(
          page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)),
          t.assets,
          "fonts"
        );
      } catch (err) {
        if (!err || err.name !== "TimeoutError") throw err;
        ctx.assetsDegraded = true;
      }
    } catch (err) {
      throw withStage(err, "content");
    }

    ctx.assertUsable();
    ctx.onStage("pdf");
    try {
      return await withTimeout(
        page.pdf({ ...pdfOptions, timeout: t.pdf }),
        t.pdf + 2000,
        "page.pdf"
      );
    } catch (err) {
      throw withStage(err, "pdf");
    }
  } finally {
    await closePageQuietly(page, t.close);
  }
}

/**
 * Run `fn(session)` with one browser and guarantee it is gone afterwards.
 *
 *   await withBrowser(async (session) => {
 *     const a = await session.renderPdf(htmlA, opts);
 *     const b = await session.renderPdf(htmlB, opts);
 *   }, { signal });
 *
 * `signal` (AbortSignal, optional): aborting it - e.g. a job timeout - closes
 * the browser at once; in-flight and later renders reject.
 * `onStage` (optional): called with "launch" | "page" | "content" | "pdf" as
 * work moves on, so a caller's timeout can say where it was stuck.
 *
 * @template T
 * @param {(session: { renderPdf: (html: string, pdfOptions: object) => Promise<Buffer>, executable: object }) => Promise<T>} fn
 * @param {{ signal?: AbortSignal, onStage?: (stage: string) => void, launcher?: { launch: Function } }} [opts]
 * @returns {Promise<T>}
 */
async function withBrowser(fn, { signal, onStage = () => {}, launcher = puppeteer } = {}) {
  const timeouts = getTimeouts();
  const executable = getSelectedExecutable();
  if (signal && signal.aborted) throw withStage(abortReason(signal), "launch");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), USER_DATA_DIR_PREFIX));
  activeUserDataDirs.add(userDataDir);
  let browser = null;
  let disconnected = false;
  let onAbort = null;

  const ctx = {
    timeouts,
    onStage,
    assetsDegraded: false,
    assertUsable() {
      if (signal && signal.aborted) throw abortReason(signal);
      if (disconnected) {
        const err = new Error("Chrome disconnected");
        err.stage = "browser";
        throw err;
      }
    },
  };

  try {
    onStage("launch");
    const launchPromise = launcher.launch(buildPuppeteerLaunchOptions({ userDataDir }));
    const launchRace = [withTimeout(launchPromise, timeouts.launch + 5000, "puppeteer.launch")];
    if (signal) launchRace.push(abortPromise(signal));
    try {
      browser = await Promise.race(launchRace);
    } catch (err) {
      // We gave up on launch (backstop timeout or abort). A browser that
      // still turns up afterwards must not leak.
      launchPromise.then(
        (late) => closeBrowserQuietly(late, timeouts.close),
        () => {}
      );
      throw withStage(err, "launch");
    }

    browser.on("disconnected", () => {
      disconnected = true;
    });
    if (signal) {
      onAbort = () => {
        closeBrowserQuietly(browser, timeouts.close);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    return await fn({
      executable,
      get assetsDegraded() {
        return ctx.assetsDegraded;
      },
      renderPdf: (html, pdfOptions) => renderPdfOnBrowser(browser, html, pdfOptions, ctx),
    });
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await closeBrowserQuietly(browser, timeouts.close);
    const leftovers = killLeftoverChrome(userDataDir);
    if (leftovers.length) {
      logCleanupProblem(
        "SERVICE.PDF.LEFTOVER_CHROME_KILLED",
        `Killed ${leftovers.length} leftover Chrome process(es) for this PDF run`,
        { pids: leftovers }
      );
    }
    activeUserDataDirs.delete(userDataDir);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_) {
      /* tmp dir; best effort */
    }
  }
}

/**
 * Synchronously SIGKILL every Chrome this process started that is still
 * running. For the server's shutdown handler: server.js calls
 * process.removeAllListeners() on SIGINT/SIGTERM/exit, which also strips the
 * exit/signal handlers puppeteer installs to kill Chrome - and Chrome runs in
 * its own process group, so without this it outlives a PM2 reload.
 * @returns {number} processes signalled
 */
function killActiveBrowsers() {
  let n = 0;
  for (const dir of activeUserDataDirs) {
    try {
      n += killLeftoverChrome(dir).length;
    } catch (_) {
      /* shutting down; keep going */
    }
  }
  return n;
}

function abortReason(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error) return r;
  const err = new Error(r ? String(r) : "aborted");
  err.name = "AbortError";
  return err;
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortReason(signal));
    else signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

module.exports = {
  withBrowser,
  withTimeout,
  getTimeouts,
  resolveChromeExecutable,
  getSelectedExecutable,
  buildPuppeteerLaunchOptions,
  findProcessesUsingUserDataDir,
  killLeftoverChrome,
  killActiveBrowsers,
  SYSTEM_CHROME_PATH,
  USER_DATA_DIR_PREFIX,
  PUPPETEER_ARGS,
  _resetLoggedSelectionForTests() {
    loggedSelection = null;
  },
};
