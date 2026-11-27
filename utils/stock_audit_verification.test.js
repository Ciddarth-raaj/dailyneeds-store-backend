/**
 *   node --test utils/stock_audit_verification.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const V = require("./stock_audit_verification");
const P = require("./stock_audit_policy");

const orig = (qty, at = "2026-11-28T10:00:00+05:30", user = "A") => ({ qty, at, user });
const rec = (qty, at = "2026-11-28T16:00:00+05:30", user = "B") => ({ qty, at, user });

describe("recount verification (original count carried over genuine movements)", () => {
  it("100 counted, 5 sold, recount 95: the original count was right", () => {
    const r = V.verifyRecount({ original: orig(100), recount: rec(95), movements: [{ action: "SALES", qty: -5, ts: "2026-11-28T12:30:00+05:30" }] });
    assert.equal(r.verdict, V.VERDICT.MATCH);
    assert.equal(r.expectedQty, 95);
    assert.equal(r.netMovementQty, -5);
  });
  it("transfers in and out are carried over too", () => {
    const r = V.verifyRecount({ original: orig(40), recount: rec(52), movements: [{ action: "TIN", qty: 20, ts: "2026-11-28T11:00:00+05:30" }, { action: "TOUT", qty: -8, ts: "2026-11-28T13:00:00+05:30" }] });
    assert.equal(r.verdict, V.VERDICT.MATCH);
  });
  it("a real counting error is a mismatch", () => {
    const r = V.verifyRecount({ original: orig(100), recount: rec(90), movements: [{ action: "SALES", qty: -5, ts: "2026-11-28T12:30:00+05:30" }] });
    assert.equal(r.verdict, V.VERDICT.MISMATCH);
    assert.equal(r.expectedQty, 95);
  });
  it("book adjustments (STK_ADJ) are not physical movements", () => {
    const r = V.verifyRecount({ original: orig(7), recount: rec(7), movements: [{ action: "STK_ADJ", qty: -4, ts: "2026-11-28T10:00:00+05:30" }] });
    assert.equal(r.verdict, V.VERDICT.MATCH);
  });
  it("movements outside the window between the counts do not count", () => {
    const r = V.verifyRecount({ original: orig(10), recount: rec(10), movements: [{ action: "SALES", qty: -3, ts: "2026-11-28T08:00:00+05:30" }, { action: "SALES", qty: -2, ts: "2026-11-28T18:00:00+05:30" }] });
    assert.equal(r.verdict, V.VERDICT.MATCH);
  });
  it("a genuine shortage the recount confirms is a match: book stock is never an input", () => {
    // book said 11; counter found 7; nothing moved; recounter found 7
    assert.equal(V.verifyRecount({ original: orig(7), recount: rec(7), movements: [] }).verdict, V.VERDICT.MATCH);
  });
  it("stays UNRESOLVED when movements cannot be read or placed", () => {
    assert.equal(V.verifyRecount({ original: orig(10), recount: rec(10), movements: null }).reason, V.UNRESOLVED_REASON.MOVEMENTS_UNAVAILABLE);
    const close = V.verifyRecount({ original: orig(10), recount: rec(9), movements: [{ action: "SALES", qty: -1, ts: "2026-11-28T10:01:00+05:30" }] });
    assert.equal(close.verdict, V.VERDICT.UNRESOLVED);
    assert.equal(close.reason, V.UNRESOLVED_REASON.MOVEMENT_TIMING_AMBIGUOUS);
    assert.equal(V.verifyRecount({ original: orig(null), recount: rec(9), movements: [] }).reason, V.UNRESOLVED_REASON.ORIGINAL_QTY_MISSING);
    assert.equal(V.verifyRecount({ original: orig(9), recount: rec(9, "2026-11-28T09:00:00+05:30"), movements: [] }).reason, V.UNRESOLVED_REASON.RECOUNT_BEFORE_ORIGINAL);
  });
  it("a recount by the original counter is not independent and never counts", () => {
    assert.equal(V.verifyRecount({ original: orig(10), recount: rec(10, undefined, "A"), movements: [] }).verdict, V.VERDICT.NOT_INDEPENDENT);
  });
});

describe("one verdict per article, however many recounts", () => {
  const r = (at, verdict) => ({ at, verdict, ref: at });
  it("earliest resolved recount decides; a later match cannot erase an earlier mismatch", () => {
    const v = V.articleVerdict([r("2026-11-28T12:00:00Z", "MISMATCH"), r("2026-11-28T15:00:00Z", "MATCH")]);
    assert.equal(v.verdict, "MISMATCH");
  });
  it("unresolved recounts are skipped until one resolves", () => {
    assert.equal(V.articleVerdict([r("2026-11-28T12:00:00Z", "UNRESOLVED"), r("2026-11-28T15:00:00Z", "MATCH")]).verdict, "MATCH");
    assert.equal(V.articleVerdict([r("2026-11-28T12:00:00Z", "UNRESOLVED")]).verdict, "UNRESOLVED");
  });
  it("any_mismatch policy: one resolved mismatch decides", () => {
    const p = P.draftFromDefault(); p.employee.recountVerdict = "any_mismatch";
    assert.equal(V.articleVerdict([r("2026-11-28T12:00:00Z", "MATCH"), r("2026-11-28T15:00:00Z", "MISMATCH")], p).verdict, "MISMATCH");
  });
  it("only non-independent recounts: no verdict", () => {
    assert.equal(V.articleVerdict([r("2026-11-28T12:00:00Z", "NOT_INDEPENDENT")]).verdict, "NONE");
  });
});

describe("5% sample on UNIQUE articles, rounded up", () => {
  it("rounds up and needs at least one", () => {
    assert.equal(V.requiredSample(1000), 50);
    assert.equal(V.requiredSample(1001), 51);
    assert.equal(V.requiredSample(21), 2);
    assert.equal(V.requiredSample(3), 1);
    assert.equal(V.requiredSample(0), 0);
  });
  it("counts each article once: unresolved ones do not count", () => {
    const s = V.sampleOf(40, [{ verdict: "MATCH" }, { verdict: "UNRESOLVED" }, { verdict: "MISMATCH" }]);
    assert.deepEqual([s.required, s.verified, s.matched, s.unresolved, s.met], [2, 2, 1, 1, true]);
  });
});
