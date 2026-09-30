/**
 * The one-time monthly fingerprint bootstrap: which employee-months it
 * re-stores, which it leaves alone, and what it reports.
 *
 *   node --test scripts/attendance/month_fingerprint_bootstrap.test.js
 *
 * As real SQL (a locked month untouched, a stale summary rebuilt, Approve &
 * Lock accepting afterwards): `repository/attendance_month_freshness.mysql.test.js`.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bootstrap = require("./month-fingerprint-bootstrap");

/** A fake database: monthly rows joined to payrun status, and the verify read. */
function fakeDb(rows) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/GROUP BY m\.period_year/.test(sql)) {
      return [{ period_year: 2026, period_month: 9, summaries: rows.length, untracked: rows.filter((r) => r.untracked).length, payroll_locked: rows.filter((r) => r.payrun_status === "APPROVED_LOCKED").length }];
    }
    if (/^\s*SELECT employee_id\s/.test(sql)) {
      const ids = params[2];
      return rows.filter((r) => ids.includes(r.employee_id) && r.untracked).map((r) => ({ employee_id: r.employee_id }));
    }
    const ids = params[2];
    return rows
      .filter((r) => !ids || ids.includes(r.employee_id))
      .map((r) => ({ employee_id: r.employee_id, untracked: r.untracked ? 1 : 0, payrun_status: r.payrun_status }));
  };
  return { query, calls, rows };
}

const SEPT = [{ year: 2026, month: 9 }];

describe("arguments", () => {
  it("inventory with no month, dry run by default, apply only with a month", () => {
    assert.deepEqual(bootstrap.parseArgs([]), { months: [], employee_ids: [], apply: false });
    assert.deepEqual(bootstrap.parseArgs(["--month", "2026-09"]).apply, false);
    assert.deepEqual(bootstrap.parseArgs(["--month", "2026-09", "--month", "2026-10", "--apply", "--employee", "7"]), {
      months: [{ year: 2026, month: 9 }, { year: 2026, month: 10 }],
      employee_ids: [7],
      apply: true,
    });
    assert.throws(() => bootstrap.parseArgs(["--apply"]), /needs at least one --month/);
    assert.throws(() => bootstrap.parseArgs(["--month", "2026-13"]), /YYYY-MM/);
    assert.throws(() => bootstrap.parseArgs(["--employee", "7"]), /needs a --month/);
    assert.throws(() => bootstrap.parseArgs(["--force"]), /unknown argument/);
  });
});

describe("a dry run", () => {
  it("names who would be re-stored and who is skipped as payroll locked, and stores nothing", async () => {
    const db = fakeDb([
      { employee_id: 1, untracked: true, payrun_status: "CALCULATED" },
      { employee_id: 2, untracked: true, payrun_status: "APPROVED_LOCKED" },
      { employee_id: 3, untracked: false, payrun_status: null },
    ]);
    const stored = [];
    const [month] = await bootstrap.run({ query: db.query, calculateMonth: async (a) => stored.push(a), months: SEPT });
    assert.equal(stored.length, 0);
    assert.equal(month.to_restore, 2);
    assert.equal(month.untracked_before, 1);
    assert.deepEqual(month.skipped_payroll_locked, [2]);
    assert.equal(month.applied, false);
  });
});

describe("--apply", () => {
  it("re-stores every unlocked employee-month through calculateMonth(persist=true), never a locked one", async () => {
    const db = fakeDb([
      { employee_id: 1, untracked: true, payrun_status: "READY_FOR_APPROVAL" },
      { employee_id: 2, untracked: true, payrun_status: "APPROVED_LOCKED" },
      { employee_id: 3, untracked: false, payrun_status: null },
    ]);
    const stored = [];
    const calculateMonth = async (a) => {
      stored.push(a);
      db.rows.find((r) => r.employee_id === a.employee_id).untracked = false;
    };
    const report = await bootstrap.run({ query: db.query, calculateMonth, months: SEPT, apply: true });
    assert.deepEqual(stored, [
      { employee_id: 1, year: 2026, month: 9, persist: true },
      { employee_id: 3, year: 2026, month: 9, persist: true },
    ]);
    assert.deepEqual(report[0].restored, [1, 3]);
    assert.deepEqual(report[0].skipped_payroll_locked, [2]);
    assert.deepEqual(report[0].still_without_fingerprint, []);
    assert.equal(bootstrap.succeeded(report), true);
  });

  it("a month locked meanwhile is reported, a failure does not stop the rest, and either fails the run", async () => {
    const db = fakeDb([
      { employee_id: 1, untracked: true, payrun_status: null },
      { employee_id: 2, untracked: true, payrun_status: null },
      { employee_id: 3, untracked: true, payrun_status: null },
    ]);
    const calculateMonth = async ({ employee_id }) => {
      if (employee_id === 1) throw Object.assign(new Error("locked"), { code: "PAYROLL_MONTH_LOCKED" });
      if (employee_id === 2) throw new Error("no shift");
      db.rows.find((r) => r.employee_id === employee_id).untracked = false;
    };
    const [month] = await bootstrap.run({ query: db.query, calculateMonth, months: SEPT, apply: true });
    assert.deepEqual(month.locked_during_run, [1]);
    assert.deepEqual(month.failed.map((f) => f.employee_id), [2]);
    assert.deepEqual(month.restored, [3]);
    assert.equal(bootstrap.succeeded([month]), false);
  });

  it("a restored month still without a fingerprint fails the run", async () => {
    const db = fakeDb([{ employee_id: 1, untracked: true, payrun_status: null }]);
    const [month] = await bootstrap.run({ query: db.query, calculateMonth: async () => {}, months: SEPT, apply: true });
    assert.deepEqual(month.still_without_fingerprint, [1]);
    assert.equal(bootstrap.succeeded([month]), false);
  });

  it("--employee narrows the run", async () => {
    const db = fakeDb([
      { employee_id: 1, untracked: true, payrun_status: null },
      { employee_id: 2, untracked: true, payrun_status: null },
    ]);
    const stored = [];
    await bootstrap.run({ query: db.query, calculateMonth: async (a) => stored.push(a.employee_id), months: SEPT, employee_ids: [2], apply: true });
    assert.deepEqual(stored, [2]);
  });
});

describe("the script writes nothing itself", () => {
  it("contains no INSERT, UPDATE or DELETE - the month persist is the only writer", () => {
    const src = fs.readFileSync(path.join(__dirname, "month-fingerprint-bootstrap.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE)\b\s/);
    assert.doesNotMatch(src, /\bSET\b/);
  });
  it("counts, plans and verifies a fingerprint of an earlier definition as untracked, like a missing one", () => {
    const { FINGERPRINT_VERSION } = require("../../utils/attendance_month_freshness");
    const rule = `day_rows_fingerprint IS NULL OR m.day_rows_fingerprint NOT LIKE '${FINGERPRINT_VERSION}:%'`;
    assert.ok(bootstrap.INVENTORY_SQL.includes(`SUM((m.${rule}))`));
    assert.ok(bootstrap.VERIFY_SQL.includes(`(day_rows_fingerprint IS NULL OR day_rows_fingerprint NOT LIKE '${FINGERPRINT_VERSION}:%')`));
  });
  it("inventory reads every month's summaries, locked and untracked counts", async () => {
    const db = fakeDb([{ employee_id: 1, untracked: true, payrun_status: "APPROVED_LOCKED" }]);
    assert.deepEqual(await bootstrap.inventory(db.query), [{ month: "2026-09", summaries: 1, untracked: 1, payroll_locked: 1 }]);
  });
});
