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

const run = async (rows, pool = fakePool()) => {
  const repo = buildRepo(pool);
  const result = await repo.saveCalculationsWithReconciliation({
    employee_id: 42,
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    rows,
  });
  return { result, log: pool.log };
};

const deletes = (log) => log.filter((e) => /^DELETE/i.test(e.sql));

describe("the DELETE", () => {
  it("targets attendance_day_calculation and nothing else", async () => {
    const { log } = await run([row("2026-09-01")]);
    assert.equal(deletes(log).length, 1, "exactly one DELETE per reconciliation");
    assert.match(deletes(log)[0].sql, /^DELETE FROM attendance_day_calculation\b/);
  });

  it("is bounded by the employee AND the requested window", async () => {
    const { log } = await run([row("2026-09-01")]);
    const [del] = deletes(log);
    assert.match(del.sql, /WHERE employee_id = \?/);
    assert.match(del.sql, /AND attendance_date BETWEEN \? AND \?/);
    assert.deepEqual(del.params.slice(0, 3), [42, "2026-09-01", "2026-09-30"]);
  });

  it("spares every date the same run just wrote - valid history is never a candidate", async () => {
    const { log } = await run([row("2026-09-01"), row("2026-09-02")]);
    const [del] = deletes(log);
    assert.match(del.sql, /AND attendance_date NOT IN \(\?\)/);
    assert.deepEqual(del.params[3], ["2026-09-01", "2026-09-02"]);
  });

  it("with NO eligible date, deletes the whole window and adds no NOT IN", async () => {
    const { result, log } = await run([]);
    const [del] = deletes(log);
    assert.ok(!/NOT IN/.test(del.sql), "nothing to keep means nothing to exclude");
    assert.equal(del.params.length, 3);
    assert.equal(result.written, 0);
    assert.equal(result.stale_removed, 3);
  });

  it("runs INSIDE the transaction, after the write, and commits once", async () => {
    const { log } = await run([row("2026-09-01")]);
    const order = log.map((e) => (/^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(e.sql) ? e.sql : e.sql.split(" ")[0]));
    assert.deepEqual(order, ["BEGIN", "INSERT", "DELETE", "COMMIT", "RELEASE"]);
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
      }),
      /forced failure/
    );
    assert.ok(pool.log.some((e) => e.sql === "ROLLBACK"));
    assert.ok(!pool.log.some((e) => e.sql === "COMMIT"));
  });

  it("refuses a call that does not name an employee and a window", async () => {
    const repo = buildRepo(fakePool());
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({ from_date: "2026-09-01", to_date: "2026-09-30", rows: [] }),
      /employee_id/
    );
    await assert.rejects(
      repo.saveCalculationsWithReconciliation({ employee_id: 42, rows: [] }),
      /window/
    );
  });
});

describe("what the repository can reach at all", () => {
  const source = fs.readFileSync(path.join(__dirname, "attendance_calculation.js"), "utf8");
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
