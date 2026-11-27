/**
 *   node --test utils/stock_audit_sapl.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("./stock_audit_sapl");
const S = require("./stock_audit_status");

const A = S.available;
const full = (c, a, r, p) => ({ completion: A(c), accuracy: A(a), recount: A(r), participation: A(p) });
const store = (id, name, kpis) => ({ outlet_id: id, name, kpis });

describe("Premier League scoring (35 / 40 / 20 / 5)", () => {
  it("full marks give exactly 100 points", () => {
    assert.equal(L.points(full(100, 100, 100, 100), L.defaultRules().weights).total, 100);
  });
  it("points are proportional and capped at 0-100%", () => {
    const p = L.points(full(50, 99, 120, -5), L.defaultRules().weights);
    assert.deepEqual(p.rows.map((r) => r.points), [17.5, 39.6, 20, 0]);
  });
  it("a KPI not measured scores no points and leaves the standing incomplete - never 0 or 100%", () => {
    const p = L.points({ completion: S.unavailable("ALLOTMENT_UNAVAILABLE"), accuracy: S.pending("PENDING_VERIFICATION"), recount: A(10), participation: A(100) }, L.defaultRules().weights);
    assert.equal(p.complete, false);
    assert.equal(p.rows[0].points, null);
    assert.equal(p.total, 7);
  });
  it("the confirmed weights cannot be changed; shortage / excess cannot be added", () => {
    const r = L.defaultRules();
    assert.equal(L.validateRules(r).ok, true);
    assert.equal(L.validateRules({ ...r, weights: { ...r.weights, accuracy: 50 } }).ok, false);
    assert.equal(L.validateRules({ ...r, weights: { ...r.weights, shortage: 10 } }).ok, false);
  });
  it("unconfirmed rules are configurable and marked unconfirmed", () => {
    const r = L.defaultRules();
    assert.equal(r.qualification.confirmed, false);
    assert.equal(r.tie_breakers.confirmed, false);
    assert.equal(r.prize.confirmed, false);
    assert.equal(L.validateRules({ ...r, prize: { ...r.prize, method: "BY_ARTICLES_AUDITED" } }).ok, true);
    assert.equal(L.validateRules({ ...r, prize: { ...r.prize, method: "LOTTERY" } }).ok, false);
  });
});

describe("standings", () => {
  const rules = L.defaultRules();
  it("ranks by total; daily standings are provisional until verified", () => {
    const rows = L.standings([store(3, "KTK", full(90, 99, 100, 100)), store(7, "ECR", full(100, 99, 100, 100))], rules);
    assert.deepEqual(rows.map((r) => [r.outlet_id, r.rank]), [[7, 1], [3, 2]]);
    assert.ok(rows.every((r) => r.provisional && !r.final));
    assert.equal(L.winnerOf(rows).winner, null);
    const fin = L.standings([store(7, "ECR", full(100, 99, 100, 100))], rules, { final: true });
    assert.equal(L.winnerOf(fin).winner, 7);
  });
  it("tie-breakers follow the configured order; a full tie is a shared rank, never decided by name", () => {
    const a = store(3, "A", full(100, 95, 100, 80)); // 35 + 38 + 20 + 4 = 97
    const b = store(4, "B", full(100, 97.5, 90, 100)); // 35 + 39 + 18 + 5 = 97
    assert.equal(L.standings([a, b], rules)[0].outlet_id, 4); // accuracy first
    const byRecount = { ...rules, tie_breakers: { confirmed: false, order: ["recount"] } };
    assert.equal(L.standings([a, b], byRecount)[0].outlet_id, 3);
    const tie = L.standings([store(3, "Z", full(100, 100, 100, 100)), store(4, "A", full(100, 100, 100, 100))], rules, { final: true });
    assert.deepEqual(tie.map((r) => r.rank), [1, 1]);
    assert.equal(L.winnerOf(tie).reason, "TIE_FOR_FIRST");
  });
  it("a store with a KPI pending ranks after qualified stores and cannot win", () => {
    const pendingStore = store(5, "MLK", { ...full(100, 100, 100, 100), accuracy: S.pending("PENDING_VERIFICATION") });
    const rows = L.standings([pendingStore, store(6, "MTP", full(10, 10, 10, 10))], rules, { final: true });
    assert.equal(rows[0].outlet_id, 6);
    assert.deepEqual(rows[1].not_qualified_reasons, ["NOT_ALL_KPIS_MEASURED"]);
  });
  it("shortage and excess never change points or rank", () => {
    const k = full(80, 98, 70, 90);
    const a = L.standings([store(3, "A", { ...k, shortage: A(1) }), store(4, "B", k)], rules);
    const b = L.standings([store(3, "A", { ...k, shortage: A(99999) }), store(4, "B", { ...k, excess: A(5) })], rules);
    assert.deepEqual(a.map((r) => [r.outlet_id, r.total, r.rank]), b.map((r) => [r.outlet_id, r.total, r.rank]));
  });
});

describe("prize shares (draft only)", () => {
  const team = [{ employee_id: 3, articles_audited: 100 }, { employee_id: 1, articles_audited: 300 }, { employee_id: 2, articles_audited: 0 }, { employee_id: null, articles_audited: 900 }];
  it("equal shares add up exactly to the prize; unmapped and non-participants excluded", () => {
    const r = L.prizeShares(team, { ...L.defaultRules().prize, amount: 10000 });
    assert.equal(r.eligible, 2);
    assert.equal(r.shares.reduce((t, s) => t + s.amount, 0), 10000);
  });
  it("shares by articles audited, to the paisa", () => {
    const r = L.prizeShares([{ employee_id: 1, articles_audited: 1 }, { employee_id: 2, articles_audited: 1 }, { employee_id: 3, articles_audited: 1 }], { ...L.defaultRules().prize, method: "BY_ARTICLES_AUDITED", amount: 10000 });
    assert.equal(Math.round(r.shares.reduce((t, s) => t + s.amount, 0) * 100), 1000000);
    assert.deepEqual(r.shares.map((s) => s.amount).sort(), [3333.33, 3333.33, 3333.34]);
  });
  it("manual method proposes nothing", () => {
    assert.deepEqual(L.prizeShares(team, { ...L.defaultRules().prize, method: "MANUAL" }).shares, []);
  });
});
