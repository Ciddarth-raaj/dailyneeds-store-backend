/**
 * THE ONLY DELETE IN THE ATTENDANCE CALCULATION REPOSITORY, examined.
 *
 *   node --test repository/attendance_calculation_reconciliation.test.js
 *
 * Item 2's guardrails are claims about a DELETE statement, so this captures
 * the statement the repository actually issues - against a fake pooled
 * connection, exactly as the driver would hand it over - and asserts what it
 * targets and what it cannot reach. The transaction is checked too: the write
 * and the delete either both commit or neither does, because a window that
 * was emptied but not rewritten is worse than one that was never touched.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./attendance_calculation");

/** A pool whose single connection records every statement in order. */
function fakePool({ failOn = null } = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (failOn && text.includes(failOn)) {
        cb(new Error(`forced failure on ${failOn}`));
        return;
      }
      // A SELECT hands back ROWS, as the driver does - the payroll-lock gate
      // in front of every write issues one, and an unlocked month is an
      // empty answer.
      if (/^SELECT/i.test(text)) {
        cb(null, []);
        return;
      }
      cb(null, { affectedRows: /^DELETE/i.test(text) ? 3 : 1, insertId: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return {
    log,
    getConnection: (cb) => cb(null, connection),
    query: (sql, params, cb) => connection.query(sql, params, cb),
  };
}

const row = (attendance_date) => ({
  employee_id: 42,
  attendance_date,
  work_shift_id: 7,
  work_shift_weekly_schedule_id: 71,
  work_shift_config_version_id: null,
  shift_snapshot: "{}",
  shift_snapshot_hash: "h",
  raw_punch_ids: "[]",
  effective_punches: "[]",
  punch_count: 2,
  attendance_day_count: 1,
  nrm_minutes: 660,
  span_minutes: 720,
  break_allowance_minutes: 60,
  break_allowance_source: "SHIFT",
  actual_gap_minutes: 0,
  break_charged_minutes: 60,
  worked_minutes: 660,
  shortage_minutes: 0,
  late_minutes: 0,
  early_exit_minutes: 0,
  pre_shift_minutes: 0,
  post_shift_minutes: 0,
  raw_ot_minutes: 0,
  ot_offset_minutes: 0,
  pre_shift_ot_minutes: 0,
  post_shift_ot_minutes: 0,
  candidate_ot_minutes: 0,
  approved_ot_minutes: 0,
  ot_rate: 1,
  status: "FINAL",
  is_final: 1,
  review_reasons: "[]",
  approval_request_id: null,
  calculation_version: 1,
});

const run = async (rows, ineligible_dates = [], pool = fakePool()) => {
  const repo = buildRepo(pool);
  const result = await repo.saveCalculationsWithReconciliation({
    employee_id: 42,
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    rows,
    ineligible_dates,
  });
  return { result, log: pool.log };
};

const deletes = (log) => log.filter((e) => /^DELETE/i.test(e.sql));

describe("the DELETE deletes ONLY what the eligibility rule condemns", () => {
  it("targets attendance_day_calculation and nothing else", async () => {
    const { log } = await run([row("2026-09-01")], ["2026-09-02"]);
    assert.equal(deletes(log).length, 1, "exactly one DELETE per reconciliation");
    assert.match(deletes(log)[0].sql, /^DELETE FROM attendance_day_calculation\b/);
  });

  it("names the ineligible dates POSITIVELY - IN, never NOT IN", async () => {
    // The whole review finding in one assertion. `NOT IN (what was
    // calculated)` deletes a date the engine merely failed to produce; `IN
    // (what the rule excludes)` cannot.
    const { log } = await run([row("2026-09-03")], ["2026-09-01", "2026-09-02"]);
    const [del] = deletes(log);
    assert.match(del.sql, /AND attendance_date IN \(\?\)/);
    assert.ok(!/NOT IN/.test(del.sql), "'not calculated' is not 'ineligible'");
    assert.deepEqual(del.params, [42, ["2026-09-01", "2026-09-02"]]);
  });

  it("is bounded by the employee", async () => {
    const { log } = await run([], ["2026-09-02"]);
    assert.match(deletes(log)[0].sql, /WHERE employee_id = \?/);
    assert.equal(deletes(log)[0].params[0], 42);
  });

  it("ISSUES NO DELETE AT ALL when the rule excludes nothing", async () => {
    // A recalculation of a fully eligible window - however few rows the
    // engine produced - must not reach the DELETE statement at all.
    const { result, log } = await run([row("2026-09-01")], []);
    assert.equal(deletes(log).length, 0);
    assert.equal(result.stale_removed, 0);
    assert.equal(result.written, 1);
  });

  it("AN ENGINE THAT PRODUCED NOTHING STILL DELETES NOTHING", async () => {
    // The failure the review asked about: a temporary calculation failure, a
    // missing shift, an incomplete batch. No row written, no date condemned,
    // therefore no deletion.
    const { result, log } = await run([], []);
    assert.equal(deletes(log).length, 0, "an empty calculation is not an eligibility verdict");
    assert.equal(result.stale_removed, 0);
  });

  it("deletes the whole window when every date of it is ineligible", async () => {
    const whole = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const { result, log } = await run([], whole);
    assert.deepEqual(deletes(log)[0].params[1], whole);
    assert.equal(result.stale_removed, 3);
  });

  it("REFUSES a date outside the requested window, and writes nothing", async () => {
    const pool = fakePool();
    await assert.rejects(
      run([row("2026-09-01")], ["2026-08-31"], pool),
      /outside the requested window/
    );
    assert.equal(pool.log.length, 0, "it never even opened a transaction");
  });

  it("REFUSES a date that the same run also calculated", async () => {
    // The rule and the calculation disagreeing is a contradiction, and the
    // honest response is to abort rather than to pick a winner.
    const pool = fakePool();
    await assert.rejects(
      run([row("2026-09-01")], ["2026-09-01"], pool),
      /the eligibility rule and the calculation disagree/
    );
    assert.equal(pool.log.length, 0);
  });

  it("REFUSES a caller that did not compute the ineligible dates", async () => {
    const repo = buildRepo(fakePool());
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({
        employee_id: 42,
        from_date: "2026-09-01",
        to_date: "2026-09-30",
        rows: [],
      }),
      /needs ineligible_dates/,
      "not defaulted to [] - a caller that forgot must fail loudly"
    );
  });

  it("runs INSIDE the transaction, after the write, and commits once", async () => {
    const { log } = await run([row("2026-09-01")], ["2026-09-02"]);
    const order = log.map((e) => (/^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(e.sql) ? e.sql : e.sql.split(" ")[0]));
    // Each modification is preceded by its own payroll-lock SELECT, inside
    // the same transaction: one for the rows being written, one for the
    // dates being deleted - which carry no row in the batch and would
    // otherwise pass ungated.
    assert.deepEqual(order, ["BEGIN", "SELECT", "INSERT", "SELECT", "DELETE", "COMMIT", "RELEASE"]);
  });

  it("the gate reads the PAYRUN's lock, and nothing else invents one", async () => {
    const { log } = await run([row("2026-09-01")], ["2026-09-02"]);
    const selects = log.filter((e) => /^SELECT/i.test(e.sql));
    assert.equal(selects.length, 2);
    for (const select of selects) {
      assert.match(select.sql, /FROM payrun_employee_calculation/);
      assert.match(select.sql, /WHERE status = \?/);
      assert.equal(select.params[0], "APPROVED_LOCKED");
      assert.deepEqual(select.params[1], [42]);
    }
  });

  it("a failing DELETE rolls the write back - never an emptied, unwritten window", async () => {
    const pool = fakePool({ failOn: "DELETE" });
    const repo = buildRepo(pool);
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({
        employee_id: 42,
        from_date: "2026-09-01",
        to_date: "2026-09-30",
        rows: [row("2026-09-01")],
        ineligible_dates: ["2026-09-02"],
      }),
      /forced failure/
    );
    assert.ok(pool.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!pool.log.some((e) => e.sql === "COMMIT"));
  });

  it("a failing INSERT rolls back before the DELETE is ever issued", async () => {
    const pool = fakePool({ failOn: "INSERT" });
    const repo = buildRepo(pool);
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({
        employee_id: 42,
        from_date: "2026-09-01",
        to_date: "2026-09-30",
        rows: [row("2026-09-01")],
        ineligible_dates: ["2026-09-02"],
      }),
      /forced failure/
    );
    assert.equal(deletes(pool.log).length, 0, "the write failed, so nothing was removed");
    assert.ok(pool.log.some((e) => e.sql === "ROLLBACK"));
  });

  it("refuses a call that does not name an employee and a window", async () => {
    const repo = buildRepo(fakePool());
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({ from_date: "2026-09-01", to_date: "2026-09-30", rows: [], ineligible_dates: [] }),
      /employee_id/
    );
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({ employee_id: 42, rows: [], ineligible_dates: [] }),
      /window/
    );
  });
});

describe("what the repository can reach at all", () => {
  // COMMENTS STRIPPED FIRST. The documentation above the method quotes the
  // statement it issues, and a scan that counts prose would count that quote
  // as a second DELETE - measuring the comment instead of the code.
  const source = fs
    .readFileSync(path.join(__dirname, "attendance_calculation.js"), "utf8")
    .replace(/^\s*\*.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
  const statements = source.match(/\bDELETE\s+FROM\s+[`a-z_]+/gi) || [];

  it("issues exactly one DELETE in the whole file", () => {
    assert.equal(statements.length, 1, `found: ${statements.join(", ")}`);
  });

  it("and it is against the derived calculation table", () => {
    assert.match(statements[0], /DELETE\s+FROM\s+attendance_day_calculation/i);
  });

  it("never deletes a raw punch, a human decision, or an audit row", () => {
    for (const table of [
      "biomax_punch",
      "biomax_punch_derived",
      "attendance_punch_void",
      "attendance_approval_request",
      "attendance_regularized_punch",
      "attendance_date_shift_override",
      "attendance_monthly_payroll",
      "employee_lifecycle_event",
      "employee_employment_period",
      "new_employee",
    ]) {
      assert.ok(
        !new RegExp(`DELETE\\s+FROM\\s+\`?${table}\\b`, "i").test(source),
        `${table} must never be deleted from here`
      );
    }
  });

  it("never rewrites a raw punch or a human decision either", () => {
    // `new_employee` is NOT on this list: the Special Break Duration Override
    // is a column on it and this repository owns that one setter. Every other
    // table here is somebody else's record.
    for (const table of [
      "biomax_punch",
      "biomax_punch_derived",
      "attendance_punch_void",
      "attendance_approval_request",
      "attendance_regularized_punch",
      "attendance_date_shift_override",
      "employee_lifecycle_event",
      "employee_employment_period",
    ]) {
      assert.ok(
        !new RegExp(`\\bUPDATE\\s+\`?${table}\\b`, "i").test(source),
        `${table} must never be updated from here`
      );
    }
    const employeeUpdates = source.match(/\bUPDATE\s+new_employee\s+SET\s+(\w+)/gi) || [];
    assert.deepEqual(
      employeeUpdates.map((u) => u.split(/\s+/).pop()),
      ["special_break_override_minutes"],
      "the only employee column this repository writes"
    );
  });
});
