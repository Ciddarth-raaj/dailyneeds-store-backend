/**
 *   node --test utils/stock_audit_activity.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./stock_audit_activity");
const S = require("./stock_audit_status");

const outlets = { kKFom: 7, sooWy: 5, "9rJMC": 2 };
const ctx = { outletOf: (s) => outlets[s] ?? null, employeeOf: (u) => ({ u1: 101 })[u] ?? null };
const fin = (slug, store, article, user, at) => ({ rp_slug: slug, rp_store_id: store, article_id: article, status: "FINALIZED", finalized_by: user, finalized_at: at });

describe("actual audit activity", () => {
  const out = A.summarize([
    fin("a", "kKFom", 1, "u1", "2026-11-26T23:30:00+05:30"),
    fin("b", "kKFom", 1, "u1", "2026-11-26T23:40:00+05:30"),
    fin("c", "kKFom", 2, "u1", "2026-11-27T00:10:00+05:30"),
    fin("d", "sooWy", 3, "u2", "2026-11-26T10:00:00+05:30"),
    fin("e", "9rJMC", 4, "u1", "2026-11-26T10:00:00+05:30"),
    { rp_slug: "p", rp_store_id: "kKFom", article_id: 5, status: "IN_PROGRESS", initiated_by: "u1" },
  ], ctx);
  it("counts unique articles per employee per India date", () => {
    const u1 = out.employee_daily.filter((r) => r.rp_user_id === "u1");
    assert.deepEqual(u1.map((r) => [r.date, r.unique_articles, r.finalized_counts]), [["2026-11-27", 1, 1], ["2026-11-26", 1, 2]]);
  });
  it("excludes the warehouse and unfinished counts", () => {
    assert.equal(out.excluded_outside_programme, 1);
    assert.equal(out.stores.length, 2);
  });
  it("keeps allotted, pending and completion unavailable - never assumed", () => {
    for (const r of [...out.employees, ...out.stores]) {
      for (const k of ["allotted", "pending", "completion_pct"]) assert.equal(r[k].status, S.STATUS.UNAVAILABLE);
    }
    assert.equal(out.allotment.status, S.STATUS.UNAVAILABLE);
  });
  it("flags unmapped counters", () => {
    assert.equal(out.employees.find((e) => e.rp_user_id === "u2").mapped, false);
  });
});
