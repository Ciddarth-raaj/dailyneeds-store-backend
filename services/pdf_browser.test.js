/**
 * CHROME MUST NEVER OUTLIVE A PDF RUN.
 *
 *   node --test services/pdf_browser.test.js
 *
 * 2026-09 incident: Chrome processes started for the stock-checker pending
 * report survived for days (Sep 25/27/28) and kept the server's CPU busy.
 * Causes this file pins down:
 *   - `timeout: 0` on launch (puppeteer 19.11.1 then waits forever);
 *   - cleanup only on the paths that remembered it (page/browser close was
 *     repeated by hand and skipped when newPage/setContent/pdf threw);
 *   - no cleanup at all when launch() rejects after Chrome was spawned;
 *   - executable chosen from `IS_TEST === "false"`, which production does not
 *     set, so production ran the bundled Chromium from ~/.cache/puppeteer.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const pdfBrowser = require("./pdf_browser");
const {
  withBrowser,
  buildPuppeteerLaunchOptions,
  resolveChromeExecutable,
  findProcessesUsingUserDataDir,
  SYSTEM_CHROME_PATH,
  USER_DATA_DIR_PREFIX,
} = pdfBrowser;
const { createFakeLauncher, hang } = require("../test_support/fake_puppeteer");

const PDF_OPTS = { format: "A4" };
const ENV_KEYS = [
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
  "PDF_LAUNCH_TIMEOUT_MS",
  "PDF_PROTOCOL_TIMEOUT_MS",
  "PDF_PAGE_TIMEOUT_MS",
  "PDF_ASSET_TIMEOUT_MS",
  "PDF_RENDER_TIMEOUT_MS",
  "PDF_CLOSE_TIMEOUT_MS",
  "IS_TEST",
  "NODE_ENV",
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Unit tests use the fake launcher; make executable resolution independent
  // of whatever is installed on the machine running them.
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const render = (session) => session.renderPdf("<p>x</p>", PDF_OPTS);

describe("lifecycle - cleanup on every path", () => {
  it("1. success closes the page and the browser", async () => {
    const fake = createFakeLauncher();
    const buf = await withBrowser(render, { launcher: fake });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(fake.pages.length, 1);
    assert.equal(fake.pages[0].closed, true);
    assert.equal(fake.browsers[0].closed, true);
  });

  it("2. newPage() failure still closes the browser (stage: page)", async () => {
    const fake = createFakeLauncher({
      newPage: () => {
        throw new Error("newPage exploded");
      },
    });
    await assert.rejects(withBrowser(render, { launcher: fake }), (err) => {
      assert.match(err.message, /newPage exploded/);
      assert.equal(err.stage, "page");
      return true;
    });
    assert.equal(fake.browsers[0].closed, true);
  });

  it("3. setContent() failure closes page and browser (stage: content)", async () => {
    const fake = createFakeLauncher({
      setContent: () => {
        throw new Error("setContent exploded");
      },
    });
    await assert.rejects(withBrowser(render, { launcher: fake }), (err) => {
      assert.equal(err.stage, "content");
      return true;
    });
    assert.equal(fake.pages[0].closed, true);
    assert.equal(fake.browsers[0].closed, true);
  });

  it("4. page.pdf() failure closes page and browser (stage: pdf)", async () => {
    const fake = createFakeLauncher({
      pdf: () => {
        throw new Error("pdf exploded");
      },
    });
    await assert.rejects(withBrowser(render, { launcher: fake }), (err) => {
      assert.equal(err.stage, "pdf");
      return true;
    });
    assert.equal(fake.pages[0].closed, true);
    assert.equal(fake.browsers[0].closed, true);
  });

  it("5. a browser.close() / page.close() failure does not hide the original error", async () => {
    const fake = createFakeLauncher({
      pdf: () => {
        throw new Error("the real problem");
      },
      pageClose: () => {
        throw new Error("page close also failed");
      },
      browserClose: () => {
        throw new Error("browser close also failed");
      },
    });
    await assert.rejects(withBrowser(render, { launcher: fake }), /the real problem/);
    assert.equal(fake.browsers[0].closeCalls, 1);
  });

  it("5b. a close failure after a successful render does not fail the render", async () => {
    const fake = createFakeLauncher({
      browserClose: () => {
        throw new Error("browser close failed");
      },
    });
    const buf = await withBrowser(render, { launcher: fake });
    assert.ok(Buffer.isBuffer(buf));
  });

  it("a hung page.close() / browser.close() is bounded", async () => {
    process.env.PDF_CLOSE_TIMEOUT_MS = "50";
    const fake = createFakeLauncher({ pageClose: hang, browserClose: hang });
    const t0 = Date.now();
    await withBrowser(render, { launcher: fake });
    assert.ok(Date.now() - t0 < 2000, "close waited on a hung Chrome");
  });

  it("a browser that disconnects mid-run fails later renders and is still closed", async () => {
    const fake = createFakeLauncher();
    await assert.rejects(
      withBrowser(
        async (session) => {
          await render(session);
          fake.browsers[0].emit("disconnected");
          return render(session);
        },
        { launcher: fake }
      ),
      (err) => {
        assert.equal(err.stage, "browser");
        return true;
      }
    );
    assert.equal(fake.browsers[0].closeCalls, 1);
  });

  it("one browser serves many PDFs", async () => {
    const fake = createFakeLauncher();
    await withBrowser(
      async (session) => {
        for (let i = 0; i < 4; i++) await render(session);
      },
      { launcher: fake }
    );
    assert.equal(fake.launchCalls.length, 1);
    assert.equal(fake.pages.length, 4);
    assert.ok(fake.pages.every((p) => p.closed));
    assert.equal(fake.browsers[0].closeCalls, 1);
  });

  it("each run gets its own user-data-dir, removed afterwards", async () => {
    const fake = createFakeLauncher();
    await withBrowser(render, { launcher: fake });
    await withBrowser(render, { launcher: fake });
    const [a, b] = fake.launchCalls.map((o) => o.userDataDir);
    assert.ok(a && b && a !== b);
    assert.ok(path.basename(a).startsWith(USER_DATA_DIR_PREFIX));
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
  });
});

describe("timeouts - nothing waits forever", () => {
  it("6. launch timeout is finite (30 s default) and cannot be set to 0", () => {
    delete process.env.PDF_LAUNCH_TIMEOUT_MS;
    const opts = buildPuppeteerLaunchOptions();
    assert.equal(opts.timeout, 30000);
    assert.ok(Number.isFinite(opts.protocolTimeout) && opts.protocolTimeout > 0);

    process.env.PDF_LAUNCH_TIMEOUT_MS = "0";
    assert.equal(buildPuppeteerLaunchOptions().timeout, 30000);
    process.env.PDF_LAUNCH_TIMEOUT_MS = "abc";
    assert.equal(buildPuppeteerLaunchOptions().timeout, 30000);
    process.env.PDF_LAUNCH_TIMEOUT_MS = "5000";
    assert.equal(buildPuppeteerLaunchOptions().timeout, 5000);
  });

  it("no longer waits on networkidle0; unreachable fonts/logo cost at most the asset budget", async () => {
    process.env.PDF_ASSET_TIMEOUT_MS = "50";
    const t0 = Date.now();
    const fake = createFakeLauncher({ setContent: hang, evaluate: hang });
    const buf = await withBrowser(
      async (session) => {
        const out = await render(session);
        assert.equal(session.assetsDegraded, true);
        return out;
      },
      { launcher: fake }
    );
    assert.ok(Buffer.isBuffer(buf), "PDF still produced with fallback assets");
    assert.ok(Date.now() - t0 < 5000);
    const { opts } = fake.pages[0].contents[0];
    assert.equal(opts.waitUntil, "load");
    assert.equal(opts.timeout, 50);
  });

  it("page.pdf gets an explicit finite timeout", async () => {
    const fake = createFakeLauncher();
    await withBrowser(render, { launcher: fake });
    assert.ok(Number.isFinite(fake.pages[0].pdfOptions.timeout));
    assert.ok(fake.pages[0].pdfOptions.timeout > 0);
  });

  it("10. aborting (job timeout) mid-render closes page and browser and rejects", async () => {
    const ac = new AbortController();
    const fake = createFakeLauncher({
      pdf: () => {
        setTimeout(() => ac.abort(new Error("job timed out")), 10);
        return hang();
      },
    });
    // The abort closes the browser; a real Chrome then fails the pending
    // page.pdf. The fake never settles it, so the render backstop is what
    // finally rejects - the browser must already be closed by then.
    process.env.PDF_RENDER_TIMEOUT_MS = "20";
    const run = withBrowser(render, { launcher: fake, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.browsers[0].closed, true, "abort must close the browser at once");
    await assert.rejects(run);
    assert.equal(fake.pages[0].closed, true);
  });

  it("an already-aborted signal never launches Chrome", async () => {
    const ac = new AbortController();
    ac.abort(new Error("too late"));
    const fake = createFakeLauncher();
    await assert.rejects(withBrowser(render, { launcher: fake, signal: ac.signal }), /too late/);
    assert.equal(fake.launchCalls.length, 0);
  });

  it("abort during a hung launch rejects, and a browser that arrives later is closed", async () => {
    const ac = new AbortController();
    let deliver;
    const fake = createFakeLauncher({
      launch: (_opts, makeBrowser) =>
        new Promise((resolve) => {
          deliver = () => resolve(makeBrowser());
        }),
    });
    const run = withBrowser(render, { launcher: fake, signal: ac.signal });
    setTimeout(() => ac.abort(new Error("job timed out")), 10);
    await assert.rejects(run, (err) => {
      assert.equal(err.stage, "launch");
      return true;
    });
    deliver();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.browsers[0].closed, true, "late browser leaked");
  });
});

describe("executable selection is deterministic and ignores IS_TEST / NODE_ENV", () => {
  const systemOnly = (p) => p === SYSTEM_CHROME_PATH;
  const nothing = () => false;

  // The three environments that matter: IS_TEST unset (what production
  // actually runs with - see docs/auth-stage0a-preproduction-readiness.md:
  // PM2 id 0 with NODE_ENV unset), IS_TEST=false (what the old code needed to
  // pick system Chrome), and ecosystem.config.js's NODE_ENV=production.
  const cases = [
    ["IS_TEST unset, NODE_ENV unset (production as run by PM2 today)", {}],
    ["IS_TEST=false", { IS_TEST: "false" }],
    ["NODE_ENV=production (ecosystem.config.js)", { NODE_ENV: "production" }],
    ["IS_TEST=true", { IS_TEST: "true" }],
  ];

  for (const [label, env] of cases) {
    it(`11. ${label}: system Chrome when it is installed`, () => {
      const sel = resolveChromeExecutable(env, systemOnly);
      assert.equal(sel.source, "system");
      assert.equal(sel.executablePath, SYSTEM_CHROME_PATH);
      const again = resolveChromeExecutable(env, systemOnly);
      assert.deepEqual(again, sel);
    });
  }

  it("the old rule would have picked bundled Chromium on production (the incident)", () => {
    const oldIsProd = (env) => env.IS_TEST === "false";
    assert.equal(oldIsProd({}), false, "IS_TEST unset => old code used bundled Chromium");
    assert.equal(resolveChromeExecutable({}, systemOnly).source, "system");
  });

  it("an explicit PUPPETEER_EXECUTABLE_PATH wins", () => {
    const sel = resolveChromeExecutable(
      { PUPPETEER_EXECUTABLE_PATH: "/opt/chrome" },
      (p) => p === "/opt/chrome" || p === SYSTEM_CHROME_PATH
    );
    assert.equal(sel.source, "env");
    assert.equal(sel.executablePath, "/opt/chrome");
  });

  it("CHROME_PATH is honoured too", () => {
    const sel = resolveChromeExecutable({ CHROME_PATH: "/opt/c" }, (p) => p === "/opt/c");
    assert.equal(sel.executablePath, "/opt/c");
  });

  it("a set-but-missing explicit path fails loudly instead of silently falling back", () => {
    assert.throws(
      () => resolveChromeExecutable({ PUPPETEER_EXECUTABLE_PATH: "/nope" }, systemOnly),
      (err) => err.stage === "launch" && /does not exist/.test(err.message)
    );
  });

  it("12. no system Chrome and nothing configured: bundled Chromium (developer machines)", () => {
    const sel = resolveChromeExecutable({}, nothing);
    assert.equal(sel.source, "bundled");
    assert.equal(sel.executablePath, undefined);
    assert.equal(buildPuppeteerLaunchOptions({ env: {} }).headless, "new");
  });

  it("the selection is logged once, not per PDF", async () => {
    const logger = require("../utils/logger");
    const real = logger.Log;
    const codes = [];
    logger.Log = (e) => codes.push(e.code);
    try {
      pdfBrowser._resetLoggedSelectionForTests();
      const fake = createFakeLauncher();
      for (let i = 0; i < 3; i++) await withBrowser(render, { launcher: fake });
    } finally {
      logger.Log = real;
    }
    assert.equal(codes.filter((c) => c === "SERVICE.PDF.CHROME_EXECUTABLE").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Real processes. Linux only (the sweep reads /proc, as production does).
// ---------------------------------------------------------------------------
const linux = process.platform === "linux" && fs.existsSync("/proc/self/cmdline");

function alive(pid) {
  try {
    process.kill(pid, 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/\) Z /.test(stat); // zombie = already dead, waiting to be reaped
  } catch (_) {
    return false;
  }
}

function groupMembers(pgid) {
  return fs
    .readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((pid) => {
      try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
        return Number(rest[2]) === pgid && !/^Z/.test(rest[0]);
      } catch (_) {
        return false;
      }
    });
}

describe("no orphaned Chrome after launch failure (real processes)", { skip: !linux }, () => {
  it("launch() rejects after spawning: the spawned process tree is killed by our sweep", async () => {
    let child;
    const fake = createFakeLauncher({
      // What puppeteer does: spawn Chrome detached (own process group) with
      // our --user-data-dir, then fail before handing back a Browser.
      launch: async (opts) => {
        child = spawn(
          "/bin/sh",
          ["-c", "sleep 300 & sleep 300; :", "fake-chrome", `--user-data-dir=${opts.userDataDir}`],
          { detached: true, stdio: "ignore" }
        );
        child.unref();
        await new Promise((r) => setTimeout(r, 100));
        throw new Error("Failed to launch the browser process!");
      },
    });
    await assert.rejects(withBrowser(render, { launcher: fake }), (err) => {
      assert.equal(err.stage, "launch");
      return true;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(child.pid), false, "fake Chrome survived a failed launch");
    assert.deepEqual(groupMembers(child.pid), [], "its children survived too");
  });

  it("the sweep never touches a process with a different user-data-dir", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), USER_DATA_DIR_PREFIX));
    const bystander = spawn(
      "/bin/sh",
      ["-c", "sleep 300; :", "other-chrome", `--user-data-dir=${other}`],
      { detached: true, stdio: "ignore" }
    );
    bystander.unref();
    try {
      await withBrowser(render, { launcher: createFakeLauncher() });
      assert.equal(alive(bystander.pid), true, "an unrelated Chrome was killed");
      assert.deepEqual(findProcessesUsingUserDataDir(other), [bystander.pid]);
    } finally {
      try {
        process.kill(-bystander.pid, "SIGKILL");
      } catch (_) {}
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("real puppeteer.launch with a Chrome that never answers: bounded, and nothing left", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-chrome-"));
    const exe = path.join(dir, "chrome");
    // Behaves like a wedged Chrome: starts children, never prints the
    // DevTools endpoint. The old `timeout: 0` waited on this forever.
    fs.writeFileSync(exe, "#!/bin/sh\nsleep 300 &\nsleep 300\n", { mode: 0o755 });
    process.env.PUPPETEER_EXECUTABLE_PATH = exe;
    process.env.PDF_LAUNCH_TIMEOUT_MS = "500";
    let userDataDir;
    const realPuppeteer = require("puppeteer");
    const launcher = {
      launch: (opts) => {
        userDataDir = opts.userDataDir;
        return realPuppeteer.launch({ ...opts, dumpio: false });
      },
    };
    const t0 = Date.now();
    try {
      await assert.rejects(withBrowser(render, { launcher }), (err) => {
        assert.equal(err.stage, "launch");
        return true;
      });
      assert.ok(Date.now() - t0 < 10000, "launch was not bounded");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(findProcessesUsingUserDataDir(userDataDir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real Chrome, when one is available (REAL_CHROME_PATH, or the Playwright
// Chromium on CI images). Skipped otherwise.
// ---------------------------------------------------------------------------
const realChrome = [process.env.REAL_CHROME_PATH, "/opt/pw-browsers/chromium"].find(
  (p) => p && fs.existsSync(p)
);

function processesWithPrefix() {
  return fs
    .readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .filter((n) => {
      try {
        return fs
          .readFileSync(`/proc/${n}/cmdline`, "utf8")
          .includes(`--user-data-dir=${path.join(os.tmpdir(), USER_DATA_DIR_PREFIX)}`);
      } catch (_) {
        return false;
      }
    });
}

describe("real Chrome", { skip: !(linux && realChrome) }, () => {
  it("12. renders the stock-checker PDF (3 branches, one browser) and leaves no Chrome behind", async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = realChrome;
    const PDFService = require("./pdf");
    const before = processesWithPrefix();
    const buffers = await PDFService.withBrowser(async (session) => {
      const out = [];
      for (const name of ["Anna Nagar", "Adyar", "Velachery"]) {
        out.push(
          await PDFService.renderStockCheckerPendingReportPDF(session, {
            generatedAt: new Date(),
            sections: [{ branch_id: 2, branch_name: name, rows: [{ product_id: 1, product_name: "Rice" }] }],
          })
        );
      }
      assert.ok(processesWithPrefix().length > before.length, "Chrome should be running here");
      return out;
    });
    for (const b of buffers) assert.equal(b.subarray(0, 5).toString(), "%PDF-");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(processesWithPrefix(), before, "Chrome left running after the run");
  });

  it("the single-PDF entry points still work", async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = realChrome;
    const PDFService = require("./pdf");
    const buf = await PDFService.generateStockCheckerPendingReportPDF({
      generatedAt: new Date(),
      sections: [{ branch_id: 2, branch_name: "X", rows: [] }],
    });
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(processesWithPrefix(), []);
  });
});

describe("shutdown", { skip: !linux }, () => {
  it("killActiveBrowsers() kills Chrome of runs still in progress (server.js onClose)", async () => {
    let child;
    let release;
    const fake = createFakeLauncher({
      launch: async (opts, makeBrowser) => {
        child = spawn(
          "/bin/sh",
          ["-c", "sleep 300 & sleep 300; :", "fake-chrome", `--user-data-dir=${opts.userDataDir}`],
          { detached: true, stdio: "ignore" }
        );
        child.unref();
        return makeBrowser();
      },
    });
    const run = withBrowser(() => new Promise((r) => (release = r)), { launcher: fake });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(child.pid), true);
    assert.ok(pdfBrowser.killActiveBrowsers() >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(child.pid), false, "Chrome survived shutdown");
    assert.deepEqual(groupMembers(child.pid), []);
    release();
    await run;
    assert.equal(pdfBrowser.killActiveBrowsers(), 0, "finished runs are forgotten");
  });

  it("server.js onClose calls it before anything else", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const onClose = src.slice(src.indexOf("  onClose() {"));
    assert.ok(
      onClose.indexOf("killActiveBrowsers()") < onClose.indexOf("cronService.stopAll()"),
      "killActiveBrowsers must run first in onClose"
    );
  });
});
