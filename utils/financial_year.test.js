/**
 *   node --test utils/financial_year.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { financialYearBounds } = require("./financial_year");

describe("financialYearBounds", () => {
  it("April to March", () => {
    assert.deepEqual(financialYearBounds("2026-10-15"), { start: "2026-04-01", end: "2027-03-31", startYear: 2026 });
    assert.deepEqual(financialYearBounds("2026-04-01"), { start: "2026-04-01", end: "2027-03-31", startYear: 2026 });
    assert.deepEqual(financialYearBounds("2026-03-31"), { start: "2025-04-01", end: "2026-03-31", startYear: 2025 });
    assert.deepEqual(financialYearBounds("2026-01-16"), { start: "2025-04-01", end: "2026-03-31", startYear: 2025 });
  });

  it("accepts a timestamp and refuses anything that is not a date", () => {
    assert.equal(financialYearBounds("2026-10-15T23:30:00+05:30").start, "2026-04-01");
    for (const bad of [null, "", "15-10-2026"]) assert.throws(() => financialYearBounds(bad));
  });
});
