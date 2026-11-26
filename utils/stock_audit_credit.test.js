/**
 *   node --test utils/stock_audit_credit.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const C = require("./stock_audit_credit");

const outlets = { kKFom: 6, sooWy: 4 };
const staff = { u1: 101, u2: 102 };
const deps = (extra = {}) => ({
  outletOf: (s) => outlets[s] ?? null,
  employeeOf: (u) => staff[u] ?? null,
  cycleOf: (outletId, at) => (at >= "2026-11-01" ? 9 : null),
  ...extra,
});
const s = (rp_slug, article_id, finalized_at, extra = {}) => ({ rp_slug, rp_store_id: "kKFom", article_id, status: "FINALIZED", finalized_by: "u1", initiated_by: "u1", finalized_at, ...extra });

describe("article credit", () => {
  it("credits one article once per cycle and store: the first finalized count wins", () => {
    const r = C.creditArticles([
      s("b", 500, "2026-11-26T21:00:00.000002+05:30", { finalized_by: "u2" }),
      s("a", 500, "2026-11-26T21:00:00.000001+05:30"),
      s("c", 501, "2026-11-26T21:05:00+05:30"),
    ], deps());
    assert.deepEqual(r.credited.map((x) => [x.session_slug, x.employee_id]), [["a", 101], ["c", 101]]);
    assert.deepEqual(r.duplicates.map((x) => [x.rp_slug, x.credited_to]), [["b", "a"]]);
  });
  it("the same article in another store is a separate credit", () => {
    const r = C.creditArticles([s("a", 500, "2026-11-26T10:00:00Z"), s("b", 500, "2026-11-26T10:00:00Z", { rp_store_id: "sooWy" })], deps());
    assert.equal(r.credited.length, 2);
  });
  it("is deterministic on ties: slug breaks an exact timestamp tie", () => {
    const at = "2026-11-26T10:00:00.123456Z";
    const one = C.creditArticles([s("z", 7, at), s("m", 7, at)], deps());
    const two = C.creditArticles([s("m", 7, at), s("z", 7, at)], deps());
    assert.equal(one.credited[0].session_slug, "m");
    assert.equal(two.credited[0].session_slug, "m");
  });
  it("skips what an earlier run already credited", () => {
    const r = C.creditArticles([s("a", 500, "2026-11-26T10:00:00Z")], deps({ alreadyCredited: new Set([C.keyOf(9, 6, 500)]) }));
    assert.equal(r.credited.length, 0);
    assert.equal(r.skipped[0].reason, C.REASON.ALREADY_CREDITED);
  });
  it("never credits unfinished, cancelled, unmapped or out-of-cycle counts, and says why", () => {
    const r = C.creditArticles([
      s("p", 1, null, { status: "IN_PROGRESS" }),
      s("x", 2, "2026-11-26T10:00:00Z", { status: "CANCELLED" }),
      s("st", 3, "2026-11-26T10:00:00Z", { rp_store_id: "nope" }),
      s("us", 4, "2026-11-26T10:00:00Z", { finalized_by: "ghost" }),
      s("old", 5, "2026-10-01T10:00:00Z"),
    ], deps());
    assert.equal(r.credited.length, 0);
    assert.deepEqual(r.skipped.map((x) => x.reason).sort(), ["no_cycle", "not_finalized", "not_finalized", "unmapped_store", "unmapped_user"]);
  });
  it("falls back to initiated_by when finalized_by is empty", () => {
    const r = C.creditArticles([s("a", 1, "2026-11-26T10:00:00Z", { finalized_by: null, initiated_by: "u2" })], deps());
    assert.equal(r.credited[0].employee_id, 102);
  });
  it("leaves recounts out through the (pending) hook", () => {
    const r = C.creditArticles([s("a", 1, "2026-11-26T10:00:00Z"), s("r", 1, "2026-11-26T11:00:00Z")], deps({ isRecount: (x) => x.rp_slug === "r" }));
    assert.equal(r.credited.length, 1);
    assert.equal(r.duplicates.length, 0);
    assert.equal(r.skipped[0].reason, C.REASON.RECOUNT);
  });
  it("counts credited articles per employee per cycle", () => {
    const r = C.creditArticles([s("a", 1, "2026-11-26T10:00:00Z"), s("b", 2, "2026-11-26T10:00:00Z"), s("c", 3, "2026-11-26T10:00:00Z", { finalized_by: "u2" })], deps());
    assert.deepEqual(C.countByEmployee(r.credited), { "9|101": 2, "9|102": 1 });
  });
});
