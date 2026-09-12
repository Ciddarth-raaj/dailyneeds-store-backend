/**
 * What the cron path writes to `api_sync_log`.
 *
 *   node --test utils/api_sync_logger.test.js
 *
 * Two bugs prompted this file, both of which made the log table lie about a
 * live nightly job:
 *
 *   1. `stock_holding_report_sync` registered `async () => { await fn(); }`
 *      instead of `return await fn();`, so `wrapCron` saw `undefined` and
 *      logged no row count at all.
 *   2. `wrapCron` decided status from `result.warnings` alone, so a usecase
 *      that returned `{ code: 400, message: "No valid rows to import" }` was
 *      logged as success / 200. Only a THROWN error was a failure.
 *
 *   3. `extractRowCount` ended its candidate list with
 *      `Array.isArray(p.data) ? p.data.length : null`, and `Number(null)` is
 *      0 - a finite number >= 0, so it was RETURNED. Any result with nothing
 *      countable in it logged `row_count: 0` rather than null. This is the
 *      "row_count: 0 on every run" the Digisme sync showed while it was
 *      inserting rows, and it affected every job whose result carries no
 *      recognised key.
 *
 * Fix 1 without fix 2 would have been worse than the bug: the job would have
 * started recording its refusals as clean runs. So the assertions below are
 * about the set.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ApiSyncLogger = require("./api_sync_logger");
const { extractRowCount } = require("./api_sync_log_helpers");

/** A logger whose writes are captured instead of stored. */
const capture = () => {
  const rows = [];
  const logger = new ApiSyncLogger({
    create: async (entry) => {
      rows.push(entry);
      return { insertId: rows.length };
    },
    getAllCronConfigs: async () => [],
  });
  return { logger, rows };
};

/** Run a cron-wrapped function and return the single row it logged. */
const runCron = async (result, { throws = false } = {}) => {
  const { logger, rows } = capture();
  const wrapped = logger.wrapCron("stock_holding_report_sync", "/stock-holding-report/sync", async () => {
    if (throws) throw new Error("delium timed out");
    return result;
  });
  if (throws) await assert.rejects(wrapped);
  else await wrapped();
  assert.equal(rows.length, 1, "exactly one log row per run");
  return rows[0];
};

describe("a sync that REFUSES is logged as a failure", () => {
  it("code 400 with a message is failed, and the message is the error", async () => {
    const row = await runCron({ code: 400, message: "No valid stock holding rows to import" });
    assert.equal(row.status, "failed");
    assert.equal(row.status_code, 400);
    assert.match(row.error_message, /No valid stock holding rows/);
  });

  it("a non-200 code with no message still says something useful", async () => {
    const row = await runCron({ code: 500 });
    assert.equal(row.status, "failed");
    assert.equal(row.status_code, 500);
    assert.match(row.error_message, /code 500/);
  });

  it("a 207 partial is a failure too - it is not a clean run", async () => {
    const row = await runCron({ code: 207, msg: "lifecycle reconciliation failed" });
    assert.equal(row.status, "failed");
    assert.equal(row.status_code, 207);
    assert.match(row.error_message, /reconciliation failed/);
  });

  it("warnings still fail the run, as they always did", async () => {
    const row = await runCron({ code: 200, warnings: ["3 outlets skipped"] });
    assert.equal(row.status, "failed");
    assert.match(row.error_message, /3 outlets skipped/);
  });

  it("and a thrown error is unchanged", async () => {
    const row = await runCron(null, { throws: true });
    assert.equal(row.status, "failed");
    assert.equal(row.status_code, 500);
    assert.match(row.error_message, /delium timed out/);
  });
});

describe("a sync that SUCCEEDS is still logged as one", () => {
  it("code 200 is success", async () => {
    const row = await runCron({ code: 200, message: "Stock holding report synced successfully" });
    assert.equal(row.status, "success");
    assert.equal(row.status_code, 200);
    assert.equal(row.error_message, null);
  });

  it("a job that returns nothing is success, not a failure", async () => {
    // Several jobs resolve undefined on a clean run. Treating those as
    // failures would be a different lie from the one being fixed.
    const row = await runCron(undefined);
    assert.equal(row.status, "success");
    assert.equal(row.status_code, 200);
  });
});

describe("the row count", () => {
  it("is read from the stock holding sync's own key", () => {
    // Its usecase returns data.item_count, which no candidate matched before.
    assert.equal(extractRowCount({ body: {} }, { code: 200, data: { item_count: 216 } }), 216);
    assert.equal(extractRowCount({ body: {} }, { code: 200, item_count: 7 }), 7);
  });

  it("is null, NOT 0, when there is nothing to count", () => {
    // Bug 3. `Number(null)` is 0, so the fallback candidate used to be
    // returned as a real count of zero for any unrecognised payload.
    assert.equal(extractRowCount({ body: {} }, undefined), null);
    assert.equal(extractRowCount({ body: {} }, { code: 200 }), null);
    assert.equal(extractRowCount({ body: {} }, { code: 200, data: { report_name: "x" } }), null);
  });

  it("but a genuine zero is still zero", () => {
    assert.equal(extractRowCount({ body: {} }, { row_count: 0 }), 0);
    assert.equal(extractRowCount({ body: {} }, { code: 200, data: [] }), 0);
  });

  it("and an array payload is still counted by length", () => {
    assert.equal(extractRowCount({ body: {} }, { code: 200, data: [1, 2, 3] }), 3);
  });

  it("reaches the log row", async () => {
    const row = await runCron({ code: 200, data: { item_count: 216 } });
    assert.equal(row.row_count, 216);
  });
});

describe("the cron registration returns its result", () => {
  const synker = fs.readFileSync(path.join(__dirname, "..", "services", "synker.js"), "utf8");

  it("every wrapped cron body returns, so nothing is logged from undefined", () => {
    // The bug was one missing `return` in a body that otherwise looked right.
    const init = synker.slice(synker.indexOf("initCronJobs("), synker.indexOf("async syncStockHoldingReportWithLogging"));
    const bodies = [...init.matchAll(/async \(\) => \{([\s\S]*?)\n\s*\}\s*\n?\s*\)/g)].map((m) => m[1]);
    assert.ok(bodies.length >= 2, "expected the wrapped cron bodies to be found");
    for (const body of bodies) {
      const statements = body.replace(/^\s*\/\/.*$/gm, "").trim();
      assert.match(statements, /^return /, `a cron body must return its result, got: ${statements}`);
    }
  });
});
