/**
 * A CRON JOB REGISTERED WITH preventOverlap NEVER RUNS TWICE AT ONCE.
 *
 *   node --test services/cron_service_overlap.test.js
 *
 * node-cron fires on schedule whether or not the previous run finished, and
 * CronService used to fire-and-forget each tick. For the stock-checker
 * pending report that meant a stuck run (Chrome hung) could be joined by the
 * next one. The guard is per process - the API is a single PM2 fork instance.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const CronService = require("./cron_service");

let ticks;
let realSchedule;
let realLog;
let realWarn;
let realError;
let warnings;

beforeEach(() => {
  ticks = {};
  warnings = [];
  realSchedule = cron.schedule;
  realLog = console.log;
  realWarn = console.warn;
  realError = console.error;
  console.log = () => {};
  console.error = () => {};
  console.warn = (...a) => warnings.push(a.join(" "));
  // Capture each job's tick callback so the test can fire it at will.
  cron.schedule = (expr, cb) => {
    ticks[expr] = cb;
    return { stop() {} };
  };
});

afterEach(() => {
  cron.schedule = realSchedule;
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));

describe("preventOverlap", () => {
  it("a tick while the job is running is skipped; after it finishes the next tick runs", async () => {
    const svc = new CronService();
    let calls = 0;
    const gate = deferred();
    svc.register("stock_checker_pending_daily_report", "0 23 * * *", () => {
      calls += 1;
      return gate.promise;
    }, { preventOverlap: true });
    svc.start();

    ticks["0 23 * * *"]();
    ticks["0 23 * * *"]();
    ticks["0 23 * * *"]();
    await flush();
    assert.equal(calls, 1, "job ran in parallel with itself");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /stock_checker_pending_daily_report" skipped/);

    gate.resolve();
    await flush();
    ticks["0 23 * * *"]();
    await flush();
    assert.equal(calls, 2);
  });

  it("the guard clears after the job throws (sync or async)", async () => {
    const svc = new CronService();
    let calls = 0;
    const job = { name: "j", task: () => {
      calls += 1;
      if (calls === 1) throw new Error("sync boom");
      if (calls === 2) return Promise.reject(new Error("async boom"));
    }, preventOverlap: true };
    assert.equal(await svc.runJob(job), "failed");
    assert.equal(await svc.runJob(job), "failed");
    assert.equal(await svc.runJob(job), "ran");
    assert.equal(calls, 3);
    assert.equal(svc.running.size, 0);
  });

  it("jobs without the option keep their old behaviour (overlap allowed)", async () => {
    const svc = new CronService();
    let calls = 0;
    svc.register("other", "*/5 * * * *", () => {
      calls += 1;
      return new Promise(() => {});
    });
    svc.start();
    ticks["*/5 * * * *"]();
    ticks["*/5 * * * *"]();
    await flush();
    assert.equal(calls, 2);
  });

  it("server.js registers the stock-checker pending report with preventOverlap", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const at = src.indexOf('"stock_checker_pending_daily_report"');
    assert.ok(at > 0);
    const registration = src.slice(at, src.indexOf(");", src.indexOf("preventOverlap", at)) + 2);
    assert.match(registration, /runDailyPendingStockCheckReport\(\{\s*trigger: "cron"/);
    assert.match(registration, /\{ preventOverlap: true \}/);
  });
});
