const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { dayRowsFingerprint, monthFreshness, monthWindow, dayRowsSql } = require("./attendance_month_freshness");

const day = (over = {}) => ({
  attendance_date: "2026-09-14", status: "FINAL", is_final: 1, attendance_day_count: 1, nrm_minutes: 660,
  base_nrm_minutes: 660, worked_minutes: 540, shortage_minutes: 120, approved_ot_minutes: 0, ot_rate: "1.00",
  permission_minutes: 0, calculation_version: 11, ...over,
});

describe("the day-rows fingerprint", () => {
  it("is the same for the same days however the values are typed", () => {
    assert.equal(dayRowsFingerprint([day()]), dayRowsFingerprint([day({ shortage_minutes: "120", ot_rate: 1 })]));
  });
  it("moves when a priced figure moves - a permission forgiving shortage", () => {
    assert.notEqual(dayRowsFingerprint([day()]), dayRowsFingerprint([day({ shortage_minutes: 0, permission_minutes: 120 })]));
  });
  it("moves when a day is added or removed, or settles", () => {
    const base = dayRowsFingerprint([day()]);
    assert.notEqual(base, dayRowsFingerprint([day(), day({ attendance_date: "2026-09-15" })]));
    assert.notEqual(base, dayRowsFingerprint([]));
    assert.notEqual(base, dayRowsFingerprint([day({ is_final: 0 })]));
  });
  it("does not depend on row order", () => {
    const a = day();
    const b = day({ attendance_date: "2026-09-15" });
    assert.equal(dayRowsFingerprint([a, b]), dayRowsFingerprint([b, a]));
  });
});

describe("the verdict Approve & Lock acts on", () => {
  const rows = [day()];
  it("current when the summary was made from these days", () => {
    assert.equal(monthFreshness({ monthly: { day_rows_fingerprint: dayRowsFingerprint(rows) }, dayRows: rows }).state, "CURRENT");
  });
  it("stale when a day moved since", () => {
    const v = monthFreshness({ monthly: { day_rows_fingerprint: dayRowsFingerprint(rows) }, dayRows: [day({ shortage_minutes: 0 })] });
    assert.deepEqual(v, { state: "STALE", reason: "DAYS_CHANGED" });
  });
  it("stale when the summary predates tracking", () => {
    assert.deepEqual(monthFreshness({ monthly: { day_rows_fingerprint: null }, dayRows: rows }), { state: "STALE", reason: "UNTRACKED" });
  });
  it("no summary: payroll's own readiness decides", () => {
    assert.equal(monthFreshness({ monthly: null, dayRows: rows }).state, "NO_SUMMARY");
  });
  it("the lock-time read is a locking read over the whole month", () => {
    assert.match(dayRowsSql("LOCK IN SHARE MODE"), /LOCK IN SHARE MODE\s*$/);
    assert.deepEqual(monthWindow(2026, 2), { from: "2026-02-01", to: "2026-02-28" });
  });
});
