/**
 * Payroll Dashboard repository - the statements it sends, against a capturing
 * fake connection (the MySQL suites need ATTENDANCE_TEST_MYSQL).
 *
 *   node --test repository/payroll_dashboard.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRepo = require("./payroll_dashboard");

function capture(rows = []) {
  const calls = [];
  const db = { query: (sql, params, cb) => { calls.push({ sql, params }); cb(null, rows); } };
  return { repo: buildRepo(db), calls };
}
const FY = { from: { year: 2026, month: 4 }, to: { year: 2027, month: 3 } };

describe("listMonthTotals", () => {
  it("reads April to March as one range", async () => {
    const { repo, calls } = capture([{ period_year: 2026, period_month: 8, initialized: 3, calculated: 2, approved: 1, published: 0, approved_gross: 1234.5 }]);
    const rows = await repo.listMonthTotals({ ...FY, store_ids: null });
    assert.deepEqual(calls[0].params, [2026, 2027, 202604, 202703]);
    assert.match(calls[0].sql, /pe\.period_year BETWEEN \? AND \?/, "an index-usable range on period_year");
    assert.ok(!/store_id IN/.test(calls[0].sql), "company-wide: no location clause");
    assert.match(calls[0].sql, /CASE WHEN c\.status = 'APPROVED_LOCKED' THEN c\.total_earnings END/, "final (approved) gross only");
    assert.deepEqual(rows, [{ year: 2026, month: 8, initialized: 3, calculated: 2, approved: 1, published: 0, approved_gross: "1234.5" }]);
  });

  it("fails closed on an empty scope and narrows by the snapshot", async () => {
    const { repo, calls } = capture();
    await repo.listMonthTotals({ ...FY, store_ids: [] });
    assert.match(calls[0].sql, /1 = 0/);
    await repo.listMonthTotals({ ...FY, store_ids: [1, 2], department_id: 10, designation_id: 100 });
    assert.match(calls[1].sql, /pe\.store_id IN \(\?\)/);
    assert.match(calls[1].sql, /pe\.department_id = \?/);
    assert.match(calls[1].sql, /pe\.designation_id = \?/);
    assert.deepEqual(calls[1].params, [2026, 2027, 202604, 202703, [1, 2], 10, 100]);
  });
});

describe("the per-employee reads", () => {
  it("read nothing for nobody", async () => {
    const { repo, calls } = capture();
    assert.deepEqual(await repo.listEmployeeFacts([]), []);
    assert.deepEqual(await repo.listPeriodsInWindow([], "2026-08-01", "2026-08-31"), []);
    assert.equal(calls.length, 0);
  });

  it("reads the periods that opened or closed in the month", async () => {
    const { repo, calls } = capture();
    await repo.listPeriodsInWindow([5, 6], "2026-08-01", "2026-08-31");
    assert.match(calls[0].sql, /joined_on BETWEEN \? AND \?\) OR \(ended_on BETWEEN \? AND \?/);
    assert.deepEqual(calls[0].params, [[5, 6], "2026-08-01", "2026-08-31", "2026-08-01", "2026-08-31"]);
  });
});
