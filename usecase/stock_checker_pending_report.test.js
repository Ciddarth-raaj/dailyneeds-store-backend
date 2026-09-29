/**
 * THE STOCK-CHECKER PENDING REPORT: ONE CHROME PER RUN, ONE RUN AT A TIME,
 * AND NEVER LONGER THAN ITS TIME LIMIT.
 *
 *   node --test usecase/stock_checker_pending_report.test.js
 *
 * 2026-09 incident: this job (cron `stock_checker_pending_daily_report`,
 * also POST /stock-checker/pending-daily-report) left Chrome processes
 * running for days. It launched one Chrome per branch, had no overall limit,
 * and nothing stopped a second run starting while the first was stuck.
 *
 * Real use case, real PDFService + pdf_browser lifecycle; only Chrome (fake
 * launcher), S3, Telegram and the repositories are stand-ins.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Telegram is instantiated when the use case module loads, so the stand-in
// has to be in the require cache first.
const fakeTelegram = {
  sent: [],
  messages: [],
  sendDocument: async (chatId, url, caption) => {
    fakeTelegram.sent.push({ chatId, url, caption });
  },
  sendMessage: async (chatId, text) => {
    fakeTelegram.messages.push({ chatId, text });
  },
};
const telegramPath = require.resolve("../services/telegram");
require.cache[telegramPath] = {
  id: telegramPath,
  filename: telegramPath,
  loaded: true,
  exports: () => fakeTelegram,
};

const S3 = require("../services/s3");
const PDFService = require("../services/pdf");
const pdfBrowser = require("../services/pdf_browser");
const logger = require("../utils/logger");
const makeUsecase = require("./stock_checker");
const { createFakeLauncher, hang } = require("../test_support/fake_puppeteer");

const realS3Upload = S3.uploadFile;
const realWithBrowser = PDFService.withBrowser;
const realLog = logger.Log;
let fake;
let uploads;
let logs;
let savedEnv;

const OUTLETS = [
  { outlet_id: 1, outlet_name: "Head office", is_active: 1 },
  { outlet_id: 2, outlet_name: "Anna Nagar", is_active: 1 },
  { outlet_id: 3, outlet_name: "Adyar", is_active: 1 },
  { outlet_id: 4, outlet_name: "Velachery", is_active: 1 },
];

/** Three open checks, none filled by any branch -> three branch PDFs. */
function makeRepos() {
  return {
    stockCheckerRepo: {
      listPendingStockCheckerHeaders: async () => [
        { stock_checker_id: 10, product_id: 100, product_de_name: "Rice" },
        { stock_checker_id: 11, product_id: 101, product_de_name: "Dal" },
      ],
      getItemsByStockCheckerIds: async () => ({}),
    },
    outletRepo: { get: async () => OUTLETS },
  };
}

function newUsecase() {
  const { stockCheckerRepo, outletRepo } = makeRepos();
  return makeUsecase(stockCheckerRepo, outletRepo);
}

function useLauncher(behaviour) {
  fake = createFakeLauncher(behaviour);
  PDFService.withBrowser = (fn, opts) =>
    pdfBrowser.withBrowser(fn, { ...opts, launcher: fake });
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const logWith = (code) => logs.filter((l) => l.code === code);

beforeEach(() => {
  savedEnv = {
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
    STOCK_CHECKER_REPORT_TIMEOUT_MS: process.env.STOCK_CHECKER_REPORT_TIMEOUT_MS,
    PDF_RENDER_TIMEOUT_MS: process.env.PDF_RENDER_TIMEOUT_MS,
  };
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
  uploads = [];
  logs = [];
  fakeTelegram.sent = [];
  fakeTelegram.messages = [];
  fakeTelegram.sendDocument = async (chatId, url, caption) => {
    fakeTelegram.sent.push({ chatId, url, caption });
  };
  S3.uploadFile = async (_bucket, key, _type, buf) => {
    uploads.push({ key, size: buf.length });
    return `https://s3.example/${key}`;
  };
  logger.Log = (entry) => logs.push(entry);
  useLauncher();
});

afterEach(() => {
  S3.uploadFile = realS3Upload;
  PDFService.withBrowser = realWithBrowser;
  logger.Log = realLog;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("one browser per run", () => {
  it("9. three branch PDFs, one Chrome launch, every page and the browser closed", async () => {
    const result = await newUsecase().runDailyPendingStockCheckReport({ trigger: "cron" });
    assert.equal(result.branch_reports, 3);
    assert.equal(fake.launchCalls.length, 1, "Chrome launched once per branch again");
    assert.equal(fake.pages.length, 3);
    assert.ok(fake.pages.every((p) => p.closed));
    assert.equal(fake.browsers[0].closeCalls, 1);
    // Output unchanged: one PDF per branch, uploaded and sent in order.
    assert.equal(uploads.length, 3);
    assert.deepEqual(
      fakeTelegram.sent.map((s) => s.caption),
      [
        "📋 Pending stock checks - Anna Nagar (2 product(s)).",
        "📋 Pending stock checks - Adyar (2 product(s)).",
        "📋 Pending stock checks - Velachery (2 product(s)).",
      ]
    );
    assert.match(fake.pages[0].contents[0].html, /Anna Nagar/);
    assert.doesNotMatch(fake.pages[0].contents[0].html, /Adyar/);
  });

  it("logs start (branches, executable) and completion (duration, PDFs, success)", async () => {
    await newUsecase().runDailyPendingStockCheckReport({ trigger: "cron" });
    const [start] = logWith("USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_START");
    assert.equal(start.ref.job, "stock_checker_pending_daily_report");
    assert.equal(start.ref.branch_reports, 3);
    assert.equal(start.ref.executable, process.execPath);
    const [done] = logWith("USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_DONE");
    assert.equal(done.ref.success, true);
    assert.equal(done.ref.pdfs_generated, 3);
    assert.equal(done.ref.sent, 3);
    assert.ok(Number.isFinite(done.ref.duration_ms));
    // No HTML or PDF bytes in the logs.
    assert.ok(JSON.stringify(logs).length < 5000);
  });

  it("no pending checks: Telegram message only, Chrome never launched", async () => {
    const { stockCheckerRepo, outletRepo } = makeRepos();
    stockCheckerRepo.listPendingStockCheckerHeaders = async () => [];
    const result = await makeUsecase(stockCheckerRepo, outletRepo).runDailyPendingStockCheckReport();
    assert.equal(result.pending_count, 0);
    assert.equal(fakeTelegram.messages.length, 1);
    assert.equal(fake.launchCalls.length, 0);
  });
});

describe("failure stages are reported and Chrome is still closed", () => {
  const cases = [
    ["launch", { launch: () => Promise.reject(new Error("spawn failed")) }, null],
    ["page", { newPage: () => Promise.reject(new Error("no page")) }, null],
    ["content", { setContent: () => Promise.reject(new Error("bad html")) }, null],
    ["pdf", { pdf: () => Promise.reject(new Error("print failed")) }, null],
    ["upload", {}, "upload"],
    ["telegram", {}, "telegram"],
  ];
  for (const [stage, behaviour, breakWhat] of cases) {
    it(`stage "${stage}"`, async () => {
      useLauncher(behaviour);
      if (breakWhat === "upload") S3.uploadFile = async () => Promise.reject(new Error("s3 down"));
      if (breakWhat === "telegram")
        fakeTelegram.sendDocument = async () => Promise.reject(new Error("telegram down"));
      await assert.rejects(newUsecase().runDailyPendingStockCheckReport(), (err) => {
        assert.equal(err.stage, stage);
        return true;
      });
      const [fail] = logWith("USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT");
      assert.equal(fail.ref.stage, stage);
      assert.equal(fail.ref.success, false);
      assert.ok(Number.isFinite(fail.ref.duration_ms));
      for (const b of fake.browsers) assert.equal(b.closed, true, "browser left open");
      for (const p of fake.pages) assert.equal(p.closed, true, "page left open");
    });
  }
});

describe("no overlap", () => {
  it("7. a second run while the first is active is skipped - no second Chrome", async () => {
    const gate = deferred();
    fakeTelegram.sendDocument = async () => gate.promise;
    const usecase = newUsecase();
    const first = usecase.runDailyPendingStockCheckReport({ trigger: "cron" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await usecase.runDailyPendingStockCheckReport({ trigger: "manual" });
    assert.equal(second.skipped, "already_running");
    assert.equal(fake.launchCalls.length, 1);
    assert.equal(logWith("USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT_SKIP").length, 1);
    gate.resolve();
    await first;
    const third = await usecase.runDailyPendingStockCheckReport();
    assert.equal(third.skipped, undefined, "guard did not clear after success");
    assert.equal(fake.launchCalls.length, 2);
  });

  it("8. the guard clears after a failure", async () => {
    const usecase = newUsecase();
    S3.uploadFile = async () => Promise.reject(new Error("s3 down"));
    await assert.rejects(usecase.runDailyPendingStockCheckReport());
    S3.uploadFile = async (_b, key) => `https://s3.example/${key}`;
    const again = await usecase.runDailyPendingStockCheckReport();
    assert.equal(again.skipped, undefined);
    assert.equal(again.branch_reports, 3);
  });
});

describe("overall job timeout", () => {
  it("10. a hung Telegram call: times out, Chrome closed, error logged, next run allowed", async () => {
    process.env.STOCK_CHECKER_REPORT_TIMEOUT_MS = "100";
    fakeTelegram.sendDocument = hang;
    const usecase = newUsecase();
    const t0 = Date.now();
    await assert.rejects(usecase.runDailyPendingStockCheckReport(), (err) => {
      assert.equal(err.name, "TimeoutError");
      assert.equal(err.stage, "telegram");
      return true;
    });
    assert.ok(Date.now() - t0 < 20000);
    assert.equal(fake.browsers[0].closed, true, "Chrome outlived the job timeout");
    const [fail] = logWith("USECASE.STOCK_CHECKER.DAILY_PENDING_REPORT");
    assert.equal(fail.ref.timed_out, true);
    assert.equal(fail.ref.stage, "telegram");

    fakeTelegram.sendDocument = async () => {};
    delete process.env.STOCK_CHECKER_REPORT_TIMEOUT_MS;
    const again = await usecase.runDailyPendingStockCheckReport();
    assert.equal(again.branch_reports, 3, "cron not eligible again after a timeout");
  });

  it("10b. a hung page.pdf: Chrome is closed as soon as the job limit hits", async () => {
    process.env.STOCK_CHECKER_REPORT_TIMEOUT_MS = "100";
    process.env.PDF_RENDER_TIMEOUT_MS = "60000"; // the job limit must act first
    useLauncher({ pdf: hang });
    const t0 = Date.now();
    await assert.rejects(newUsecase().runDailyPendingStockCheckReport(), (err) => {
      assert.equal(err.name, "TimeoutError");
      assert.equal(err.stage, "pdf");
      return true;
    });
    assert.ok(Date.now() - t0 < 20000);
    assert.equal(fake.browsers[0].closed, true);
  });

  it("the default limit is finite", () => {
    delete process.env.STOCK_CHECKER_REPORT_TIMEOUT_MS;
    const src = require("fs").readFileSync(path.join(__dirname, "stock_checker.js"), "utf8");
    assert.match(src, /DEFAULT_PENDING_REPORT_TIMEOUT_MS = 10 \* 60 \* 1000/);
  });
});
