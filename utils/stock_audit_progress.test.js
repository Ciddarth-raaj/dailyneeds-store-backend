/**
 *   node --test utils/stock_audit_progress.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computePeriod } = require("./stock_audit_progress");
const S = require("./stock_audit_status");

const ECR = { outlet_id: 7, name: "ECR", rp_id: "kKFom" };
const WH = { outlet_id: 2, name: "Warehouse", rp_id: "9rJMC" };
const CYCLE = { cycle_id: 11, outlet_id: 7, name: "Q4", period_code: "2026-Q4", start_date: "2026-11-25", end_date: "2026-12-10", deadline: "2026-12-05", status: "OPEN" };
let n = 0;
const sess = (user, article, finalizedAt, extra = {}) => ({
  rp_slug: `s${++n}`, rp_store_id: "kKFom", outlet_id: 7, article_id: article, status: "FINALIZED",
  initiated_by: user, finalized_by: user, started_at: finalizedAt, finalized_at: finalizedAt, var_qty: 0, var_value: 0, ...extra,
});
const people = new Map([["uA", { employee_id: 501, name: "Anbu", designation: "Cashier" }], ["uB", { employee_id: 502, name: "Bala", designation: "CSA" }]]);
const base = (over = {}) => ({
  cycles: [CYCLE], stores: [ECR], people, rpNames: new Map([["uC", "chitra (rp)"]]), today: "2026-11-27", asOf: "2026-11-27T06:00:00Z", ...over,
});

describe("progress: allotment not imported", () => {
  const sessions = [sess("uA", 1, "2026-11-26T05:00:00Z"), sess("uA", 2, "2026-11-27T05:00:00Z"), sess("uB", 3, "2026-11-27T04:00:00Z")];
  const r = computePeriod(base({ sessions }));
  it("allotted, pending and completion are Unavailable - never 0 or 100%", () => {
    const st = r.stores[0];
    for (const c of [st.allotted, st.pending, st.completion]) assert.equal(c.status, S.STATUS.UNAVAILABLE);
    for (const e of r.employees) for (const c of [e.allotted_c, e.pending_c, e.completion_c]) assert.equal(c.status, S.STATUS.UNAVAILABLE);
  });
  it("counts unique audited articles and today's, per employee and store", () => {
    const a = r.employees.find((e) => e.rp_user_id === "uA");
    assert.equal(a.audited, 2);
    assert.equal(a.today, 1);
    assert.equal(r.stores[0].audited, 3);
    assert.equal(r.stores[0].audited_today, 2);
  });
  it("no recounts: accuracy and payable amount pending; estimate pending", () => {
    const a = r.employees.find((e) => e.rp_user_id === "uA");
    assert.equal(a.accuracy.status, S.STATUS.PENDING);
    assert.equal(a.estimated.status, S.STATUS.PENDING);
    assert.equal(a.est.estimate.status, S.STATUS.PENDING);
    assert.equal(r.stores[0].accuracy.status, S.STATUS.PENDING);
  });
  it("Store Manager and Supervisor totals pending; completion unavailable", () => {
    const m = r.management[0];
    assert.equal(m.storeManager.amount.status, S.STATUS.PENDING);
    assert.equal(m.storeManager.components[0].measure.status, S.STATUS.UNAVAILABLE);
    assert.equal(m.supervisor.amount.status, S.STATUS.PENDING);
  });
});

describe("progress: with allotment", () => {
  const allotment = [
    ...[1, 2, 3, 4].map((a) => ({ cycle_id: 11, rp_user_id: "uA", article_id: a, effective: "Y" })),
    { cycle_id: 11, rp_user_id: "uA", article_id: 9, effective: "N" },
    ...[5, 6].map((a) => ({ cycle_id: 11, rp_user_id: "uB", article_id: a, effective: "Y" })),
  ];
  const sessions = [
    sess("uA", 1, "2026-11-26T05:00:00Z", { var_qty: -2, var_value: -80 }),
    sess("uA", 2, "2026-11-26T06:00:00Z"),
    sess("uA", 5, "2026-11-26T07:00:00Z", { var_qty: 1, var_value: 30 }), // uB's article, counted by uA
    sess("uB", 6, "2026-11-27T05:00:00Z"),
    sess("uA", 3, "2026-11-20T05:00:00Z"), // before the cycle: not in it
  ];
  const r = computePeriod(base({ sessions, allotment, allotmentCycles: new Set([11]) }));
  const a = r.employees.find((e) => e.rp_user_id === "uA");
  const b = r.employees.find((e) => e.rp_user_id === "uB");
  it("matches audits on store + auditor + article", () => {
    assert.equal(a.allotted, 4);
    assert.equal(a.not_auditable, 1);
    assert.equal(a.audited, 3);
    assert.equal(a.audited_own, 2);
    assert.equal(a.audited_not_allotted, 1);
    assert.equal(a.pending_c.value, 2);
    assert.equal(a.completion_c.value, 50);
    assert.equal(b.audited_own, 1);
  });
  it("an article counted by someone it was not allotted to earns nothing", () => {
    const art5 = r.eligibility.find((x) => x.article_id === 5);
    assert.equal(art5.status, "NOT_ELIGIBLE");
    assert.equal(a.eligible, 2);
  });
  it("store completion counts allotted articles audited by anyone; deadline KPI pending before the deadline", () => {
    const st = r.stores[0];
    assert.equal(st.allotted.value, 6);
    assert.equal(st.audited_allotted, 4);
    assert.equal(Math.round(st.completion.value * 100) / 100, 66.67);
    assert.equal(r.management[0].storeManager.components[0].measure.reason, S.REASON.BEFORE_DEADLINE);
  });
  it("shortage / excess are reported for review only", () => {
    assert.equal(r.stores[0].shortage_qty, 2);
    assert.equal(r.stores[0].shortage_value, 80);
    assert.equal(r.stores[0].excess_value, 30);
    assert.ok(!("shortage" in r.saplKpis[0].kpis) && !("excess" in r.saplKpis[0].kpis));
  });
  it("after the deadline the completion KPI is decided", () => {
    const late = computePeriod(base({ sessions, allotment, allotmentCycles: new Set([11]), today: "2026-12-06", asOf: "2026-12-06T06:00:00Z" }));
    const c = late.management[0].storeManager.components[0];
    assert.equal(c.measure.status, S.STATUS.AVAILABLE);
    assert.equal(c.amount.value, 0); // 4 of 6 allotted by the deadline, threshold 100%
  });
});

describe("progress: recounts and incentives", () => {
  const allotment = Array.from({ length: 40 }, (_, i) => ({ cycle_id: 11, rp_user_id: "uA", article_id: 100 + i, effective: "Y" }));
  const sessions = allotment.map((x) => sess("uA", x.article_id, "2026-11-26T05:00:00Z"));
  const verifications = sessions.slice(0, 2).map((s, i) => ({ cycle_id: 11, outlet_id: 7, article_id: s.article_id, original_session_slug: s.rp_slug, recount_ref: `r${i}`, recount_user: "uB", verdict: "MATCH", recount_at: "2026-11-27T05:00:00Z" }));
  const r = computePeriod(base({ sessions, allotment, allotmentCycles: new Set([11]), verifications }));
  const a = r.employees.find((e) => e.rp_user_id === "uA");
  it("5% of unique audited articles, rounded up", () => {
    assert.equal(a.recount_required, 2);
    assert.equal(a.sample.met, true);
  });
  it("payable calculated only with the full sample; estimate shown, never payable", () => {
    assert.equal(a.calc_status, "CALCULATED");
    assert.equal(a.estimated.value, 44);
    assert.equal(a.est.estimate.value, 44);
    assert.equal(a.est.estimate.estimate, true);
    assert.equal(a.approved_c.status, S.STATUS.PENDING);
  });
  it("store accuracy from recounts only", () => {
    assert.equal(r.stores[0].accuracy.value, 100);
    assert.equal(r.stores[0].recount_progress.value, 100);
  });
});

describe("progress: programme boundaries", () => {
  it("warehouse and pre-programme audits never count", () => {
    const whCycle = { ...CYCLE, cycle_id: 12, outlet_id: 2 };
    const sessions = [
      { ...sess("uA", 1, "2026-11-26T05:00:00Z"), rp_store_id: "9rJMC", outlet_id: 2 },
      sess("uA", 2, "2026-11-24T17:00:00Z"), // 24 Nov 22:30 IST, before the start
    ];
    const r = computePeriod(base({ cycles: [CYCLE, whCycle], stores: [ECR, WH], sessions }));
    assert.equal(r.stores.find((s) => s.outlet_id === 2).audited, 0);
    assert.equal(r.stores.find((s) => s.outlet_id === 7).audited, 0);
  });
  it("unmapped users are listed and never paid", () => {
    const r = computePeriod(base({ sessions: [sess("uC", 1, "2026-11-26T05:00:00Z")] }));
    assert.deepEqual(r.issues.unmapped_users, ["uC"]);
    const c = r.employees[0];
    assert.equal(c.employee_id, null);
    assert.equal(c.rp_name, "chitra (rp)");
    assert.notEqual(c.estimated.status, S.STATUS.AVAILABLE);
  });
});

describe("progress: 75,000 articles (performance)", () => {
  it("computes a full period across five stores in well under 5 s", () => {
    const stores = [3, 4, 5, 6, 7].map((o) => ({ outlet_id: o, name: `S${o}`, rp_id: `R${o}` }));
    const cycles = stores.map((s, i) => ({ ...CYCLE, cycle_id: 20 + i, outlet_id: s.outlet_id }));
    const allotment = [];
    const sessions = [];
    const ppl = new Map();
    let art = 1;
    stores.forEach((s, si) => {
      for (let u = 0; u < 22; u++) {
        const user = `u${si}_${u}`;
        ppl.set(user, { employee_id: 1000 + si * 100 + u, name: user });
        for (let k = 0; k < 682; k++) {
          const article = art++;
          allotment.push({ cycle_id: 20 + si, rp_user_id: user, article_id: article, effective: "Y" });
          if (k % 3) sessions.push({ ...sess(user, article, "2026-11-26T05:00:00Z"), rp_store_id: s.rp_id, outlet_id: s.outlet_id });
        }
      }
    });
    assert.ok(allotment.length >= 75000);
    const t0 = Date.now();
    const r = computePeriod({ cycles, stores, sessions, allotment, allotmentCycles: new Set(cycles.map((c) => c.cycle_id)), people: ppl, today: "2026-11-27", asOf: "2026-11-27T06:00:00Z" });
    const ms = Date.now() - t0;
    assert.equal(r.employees.length, 110);
    assert.equal(r.stores.reduce((t, s) => t + s.allotted.value, 0), allotment.length);
    assert.ok(ms < 5000, `took ${ms} ms`);
  });
});

describe("mapping: unmapped auditors, later reconciliation, no double credit", () => {
  const allotment = Array.from({ length: 40 }, (_, i) => ({ cycle_id: 11, rp_user_id: "uOld", article_id: 500 + i, effective: "Y" }));
  const sessions = [
    ...Array.from({ length: 20 }, (_, i) => sess("uOld", 500 + i, "2026-11-26T05:00:00Z")), // 500-519
    ...Array.from({ length: 10 }, (_, i) => sess("uNew", i < 5 ? 510 + i : 515 + i, "2026-11-26T06:00:00Z")), // 510-514 again, 520-524 new
  ];
  const verifications = sessions.slice(0, 2).map((s, i) => ({ cycle_id: 11, outlet_id: 7, article_id: s.article_id, original_session_slug: s.rp_slug, recount_ref: `m${i}`, recount_user: "uB", verdict: "MATCH", recount_at: "2026-11-27T05:00:00Z" }));
  const base2 = (people2) => computePeriod(base({ sessions, allotment, allotmentCycles: new Set([11]), verifications, people: people2 }));
  it("unmapped: shown as its own provisional row, never an estimate or an amount", () => {
    const r = base2(new Map());
    const u = r.employees.filter((e) => !e.mapped);
    assert.equal(u.length, 2);
    for (const e of u) {
      assert.equal(e.mapping_status, "UNMAPPED");
      assert.equal(e.estimated.reason, S.REASON.EMPLOYEE_UNMAPPED);
      assert.equal(e.est.estimate.reason, S.REASON.EMPLOYEE_UNMAPPED);
    }
  });
  it("after mapping BOTH RetailPilot users to one employee: one row, articles counted once, allotment honoured", () => {
    const r = base2(new Map([["uOld", { employee_id: 77, name: "Same Person" }], ["uNew", { employee_id: 77, name: "Same Person" }]]));
    const rows = r.employees.filter((e) => e.employee_id === 77);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].rp_user_ids.sort(), ["uNew", "uOld"]);
    assert.equal(rows[0].audited, 25); // 20 + 5 new (the overlapping 5 counted once)
    assert.equal(rows[0].audited_own, 25); // uNew's counts of uOld's allotment are the same person's
    // the 5 articles counted twice stay in review (a second count may be a recount), but NOT as "two counters"
    assert.equal(r.eligibility.filter((x) => x.status === "ELIGIBLE").length, 20);
    const twice = r.eligibility.filter((x) => x.status === "PENDING_ELIGIBILITY_REVIEW");
    assert.equal(twice.length, 5);
    assert.ok(twice.every((x) => !x.reasons.includes("MULTIPLE_COUNTERS")));
    assert.equal(r.eligibility.filter((x) => x.status === "NOT_ELIGIBLE").length, 0);
    // credited now that the person is known: the estimate shows; the payable amount waits for the 5 in review
    assert.equal(rows[0].est.estimate.status, S.STATUS.AVAILABLE);
    assert.equal(rows[0].estimated.reason, S.REASON.PENDING_ELIGIBILITY_REVIEW);
  });
  it("participation is provisional while counters are unmapped", () => {
    const hc = new Map([[7, { snapshot: true, eligible: [{ employee_id: 77, name: "Same Person" }, { employee_id: 78, name: "Other" }], excluded: [] }]]);
    const r = computePeriod(base({ sessions, allotment, allotmentCycles: new Set([11]), people: new Map([["uOld", { employee_id: 77, name: "Same Person" }]]), headcount: hc }));
    const st = r.stores[0];
    assert.equal(st.participation.value, 50);
    assert.equal(st.participation.provisional, true);
    assert.deepEqual(st.participation.provisional_reasons, ["UNMAPPED_COUNTERS"]);
    assert.equal(st.participation_detail.unmapped_counters, 1);
  });
});
