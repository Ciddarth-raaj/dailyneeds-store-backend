/**
 * Stock Audit against real MySQL: bulk CSV import (validate, confirm,
 * revisions, conflicts, concurrency), the RetailPilot sync (idempotent,
 * watermark only on success, deferral), and the period figures.
 *
 *   SA_TEST_MYSQL=mysql://dnds:dnds@127.0.0.1:3307/sa_scratch \
 *     node --test repository/stock_audit.mysql.test.js
 *
 * SKIPPED unless SA_TEST_MYSQL names a SCRATCH database (tables are dropped).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("../test_support/stock_audit_mysql_fixture");
const repoFactory = require("./stock_audit");
const usecaseFactory = require("../usecase/stock_audit");
const syncFactory = require("../usecase/stock_audit_sync");
const S = require("../utils/stock_audit_status");

const URL = process.env.SA_TEST_MYSQL;
const HEAD = "Store,Store name,Auditor,Auditor name,Node,Level,Article ID,Article,Owned,Positive stock,Negative stock,Net stock,Sellable,Buyable,Effective,Reason";
const csv = (store, auditor, name, articles, notAuditable = []) =>
  [HEAD, ...articles.map((a) => `${store},x,${auditor},${name},Tea,category,${a},"item, ${a}",Y,1.000,0,1.000,Y,Y,Y,has stock`),
    ...notAuditable.map((a) => `${store},x,${auditor},${name},Tea,category,${a},item ${a},Y,,,,N,N,N,no stock record at store`)].join("\n");
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const NOW = new Date("2026-11-27T06:00:00Z");

describe("Stock Audit on MySQL", { skip: !URL && "SA_TEST_MYSQL is not set" }, () => {
  let db;
  let repo;
  let U;
  before(async () => {
    db = await setup(URL);
    repo = repoFactory(db.pool);
    U = usecaseFactory(repo, { now: () => NOW });
    await db.q(`INSERT INTO new_employee VALUES (501,'Anbu',7,1,1),(502,'Bala',7,2,1),(503,'Chitra',5,2,1),(504,'Deepa',7,3,1),(505,'Elango',7,4,1),(900,'HR',3,1,1)`);
    await db.q(`INSERT INTO wh_rp_staff_map (rp_user_id, employee_id) VALUES ('uA',501),('uB',502),('uC',503)`);
  });
  after(async () => db && db.end());

  describe("audit period", () => {
    it("creates one cycle per programme store; the warehouse and duplicates are refused", async () => {
      await assert.rejects(U.createPeriod({ period_code: "2026-Q4", start_date: "2026-11-25", end_date: "2026-12-10", deadline: "2026-12-05", outlet_ids: [2], by: 900 }), /warehouse/);
      const r = await U.createPeriod({ period_code: "2026-Q4", name: "Q4 2026 Full Audit", start_date: "2026-11-25", end_date: "2026-12-10", deadline: "2026-12-05", by: 900 });
      assert.equal(r.stores, 5);
      await assert.rejects(U.createPeriod({ period_code: "2026-Q4", start_date: "2026-11-25", end_date: "2026-12-10", deadline: "2026-12-05", by: 900 }), (e) => e.status === 409);
    });
  });

  describe("bulk CSV allotment import", () => {
    let batch1;
    it("validates many files at once, stages them, writes no allotment yet", async () => {
      const v = await U.validateUpload({
        period_code: "2026-Q4",
        by: 900,
        files: [
          { name: "a.csv", text: csv("kKFom", "uA", "anbu", range(1000, 40), [5000, 5001]) },
          { name: "b.csv", text: csv("kKFom", "uB", "bala", range(2000, 20)) },
          { name: "z.csv", text: csv("kKFom", "uZ", "zed", range(3000, 10)) }, // unmapped: warning only
          { name: "wh.csv", text: csv("9rJMC", "uW", "wh", [1]) }, // warehouse: rejected
        ],
      });
      assert.equal(v.canConfirm, true);
      assert.deepEqual(v.files.map((f) => f.status), ["VALID", "VALID", "WARNINGS", "REJECTED"]);
      assert.deepEqual(v.unmapped.map((u) => u.rp_user_id), ["uZ"]);
      assert.equal(v.summary.auditable, 70);
      assert.equal(v.summary.not_auditable, 2);
      batch1 = v.batch_id;
      const n = await db.q(`SELECT COUNT(*) AS n FROM sa_allotment`);
      assert.equal(Number(n[0].n), 0);
    });
    it("confirm writes the allotment in one transaction; progress then shows it", async () => {
      const r = await U.confirmUpload(batch1, 900);
      assert.equal(r.applied, 3);
      const rows = await db.q(`SELECT effective, COUNT(*) AS n FROM sa_allotment GROUP BY effective ORDER BY effective`);
      assert.deepEqual(rows.map((x) => [x.effective, Number(x.n)]), [["N", 2], ["Y", 70]]);
      await assert.rejects(U.confirmUpload(batch1, 900), (e) => e.status === 409);
      const st = await U.store({ outletId: 7 });
      assert.equal(st.allotted.value, 70);
      assert.equal(st.completion.value, 0);
      const a = (await U.employees({ outlets: [7] })).rows.find((e) => e.rp_user_id === "uA");
      assert.equal(a.allotted, 40);
      assert.equal(a.not_auditable, 2);
      assert.equal(a.pending_c.value, 40);
    });
    it("an identical file again is ALREADY_IMPORTED; a corrected one is the next revision", async () => {
      const v = await U.validateUpload({
        period_code: "2026-Q4",
        by: 900,
        files: [{ name: "a-again.csv", text: csv("kKFom", "uA", "anbu", range(1000, 40), [5000, 5001]) }, { name: "b-v2.csv", text: csv("kKFom", "uB", "bala", range(2005, 20)) }],
      });
      assert.deepEqual(v.files.map((f) => f.status), ["ALREADY_IMPORTED", "VALID"]);
      assert.deepEqual(v.files[1].diff, { added: 5, removed: 5, unchanged: 15 });
      assert.equal(v.files[1].revision, 2);
      await U.confirmUpload(v.batch_id, 900);
      const files = await db.q(`SELECT revision, state FROM sa_allotment_file WHERE rp_user_id = 'uB' AND revision IS NOT NULL ORDER BY revision`);
      assert.deepEqual(files.map((f) => [Number(f.revision), f.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
      const b = await db.q(`SELECT MIN(article_id) AS lo, COUNT(*) AS n FROM sa_allotment WHERE rp_user_id = 'uB'`);
      assert.deepEqual([Number(b[0].lo), Number(b[0].n)], [2005, 20]);
    });
    it("an article allotted to two auditors in one store blocks confirmation, also against earlier imports", async () => {
      const v = await U.validateUpload({ period_code: "2026-Q4", by: 900, files: [{ name: "c.csv", text: csv("kKFom", "uC", "chitra", [1000, 9999]) }] });
      assert.equal(v.canConfirm, false);
      assert.equal(v.files[0].status, "CONFLICT");
      await assert.rejects(U.confirmUpload(v.batch_id, 900), (e) => e.status === 409);
    });
    it("CONCURRENT confirms that would double-allot an article: exactly one wins, the database refuses the other", async () => {
      // validated separately (each alone is clean), confirmed at the same time
      const v1 = await U.validateUpload({ period_code: "2026-Q4", by: 900, files: [{ name: "p.csv", text: csv("kKFom", "uP", "p", [7000, 7001]) }] });
      const v2 = await U.validateUpload({ period_code: "2026-Q4", by: 900, files: [{ name: "q.csv", text: csv("kKFom", "uQ", "q", [7001, 7002]) }] });
      assert.ok(v1.canConfirm && v2.canConfirm);
      const res = await Promise.allSettled([U.confirmUpload(v1.batch_id, 900), U.confirmUpload(v2.batch_id, 900)]);
      assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(res.find((r) => r.status === "rejected").reason.status, 409);
      const n = await db.q(`SELECT COUNT(*) AS n FROM sa_allotment WHERE article_id = 7001 AND effective = 'Y'`);
      assert.equal(Number(n[0].n), 1);
    });
    it("CONCURRENT confirms of the same auditor: one revision number each, never two CURRENT files", async () => {
      const v1 = await U.validateUpload({ period_code: "2026-Q4", by: 900, files: [{ name: "r1.csv", text: csv("kKFom", "uR", "r", [8000]) }] });
      const v2 = await U.validateUpload({ period_code: "2026-Q4", by: 900, files: [{ name: "r2.csv", text: csv("kKFom", "uR", "r", [8000, 8001]) }] });
      const res = await Promise.allSettled([U.confirmUpload(v1.batch_id, 900), U.confirmUpload(v2.batch_id, 900)]);
      assert.equal(res.filter((r) => r.status === "fulfilled").length, 1); // the second saw a changed allotment
      const cur = await db.q(`SELECT COUNT(*) AS n FROM sa_allotment_file WHERE rp_user_id = 'uR' AND state = 'CURRENT'`);
      assert.equal(Number(cur[0].n), 1);
    });
    it("upload history lists every batch", async () => {
      const h = await U.uploads();
      assert.ok(h.length >= 6);
      assert.ok(h.some((x) => x.status === "Imported"));
    });
  });

  describe("RetailPilot sync (fake SPECTRA, read-only)", () => {
    const sessions = [];
    const lines = [];
    const ledger = [];
    let fail = null;
    const at = (h, m) => `2026-11-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.123456+05:30`;
    const addSession = (slug, user, article, h, m, extra = {}) => sessions.push({ slug, store_id: "kKFom", article_id: article, stock_location: "main", status: "FINALIZED", initiated_by: user, finalized_by: user,
      started_at: at(h, m), finalized_at: at(h, m + 1), updated_at: at(h, m + 1), net_adj_action: "STK_ADJ", marker_ledger_slug: `m${slug}`, recount_slug: null, cancel_reason: null, ...extra });
    for (let i = 0; i < 25; i++) addSession(`sa${i}`, "uA", 1000 + i, 10, i);
    addSession("sb0", "uB", 2005, 11, 0);
    addSession("sx0", "uX", 2006, 11, 5); // counted by someone not mapped and not allotted
    addSession("old", "uA", 1030, 9, 0, { finalized_at: "2026-11-20T10:00:00+05:30", started_at: "2026-11-20T09:59:00+05:30", updated_at: "2026-11-26T09:00:00.000001+05:30" });
    for (const s of sessions) lines.push({ slug: `l${s.slug}`, session_slug: s.slug, stock_location: "main", batch_id: null, mrp: 10, counted_qty: 5, snapshot_qty: 6, snapshot_cells: "[]", source: "scan", holding_type: null, status: "counted", created_at: s.started_at, updated_at: s.updated_at });
    ledger.push({ slug: "msa0", article_id: 1000, store_id: "kKFom", batch_id: null, stock_location: "main", action: "STK_ADJ", ts: sessions[0].finalized_at, quantity: 0, net_landing_cost: null, mrp: null,
      traceability: JSON.stringify({ audit: { counted_by: "uA", count_session: "sa0" }, value: { net: { delta_qty: "-1.000", delta_landing: "35.60" } } }) });
    const table = (q) => (q.includes("stock_audit_count_session") ? sessions : q.includes("stock_audit_count_line") ? lines : ledger);
    const spectra = {
      isConfigured: () => true,
      calls: 0,
      async queryKeyset(build, cursor, cursorOf, onPage, { size = 10 } = {}) {
        // honours the keyset contract on the in-memory "table"
        const q = build(cursor, size);
        const tsCol = q.includes("stock_ledgers") ? "ts" : "updated_at";
        const all = table(q).slice().sort((a, b) => (a[tsCol] < b[tsCol] ? -1 : a[tsCol] > b[tsCol] ? 1 : a.slug < b.slug ? -1 : 1));
        const { toUtc } = require("../utils/stock_audit_queries");
        let c = cursor;
        let rows = 0;
        for (;;) {
          this.calls += 1;
          if (fail && this.calls >= fail.at) throw fail.err;
          const page = all.filter((r) => !c || toUtc(r[tsCol]).iso > toUtc(c.ts).iso || (toUtc(r[tsCol]).iso === toUtc(c.ts).iso && r.slug > c.slug)).slice(0, size);
          if (page.length) c = cursorOf(page[page.length - 1]);
          rows += page.length;
          await onPage(page, c);
          if (page.length < size) return { rows, cursor: c };
        }
      },
    };
    let sync;
    before(() => {
      sync = syncFactory(spectra, repo, { now: () => NOW, pageSize: 10 });
    });

    it("a DRY_RUN reads and writes nothing", async () => {
      const r = await sync.run({ kind: "DRY_RUN" });
      assert.equal(r.code, 200);
      assert.equal(r.counts.session.read, 28);
      const n = await db.q(`SELECT COUNT(*) AS n FROM sa_rp_session`);
      assert.equal(Number(n[0].n), 0);
      assert.equal((await repo.syncState()).size, 0);
    });
    it("HISTORICAL mirrors sessions, lines and markers from the programme start, with microseconds", async () => {
      const r = await sync.run({ kind: "HISTORICAL", startedBy: 900 });
      assert.equal(r.code, 200, r.message);
      assert.equal(r.counts.session.inserted, 28);
      const s = await db.q(`SELECT outlet_id, var_qty, var_value, has_lines, DATE_FORMAT(finalized_at, '%Y-%m-%d %H:%i:%s.%f') AS f FROM sa_rp_session WHERE rp_slug = 'sa0'`);
      assert.deepEqual([Number(s[0].outlet_id), Number(s[0].var_qty), Number(s[0].var_value), Number(s[0].has_lines)], [7, -1, 35.6, 1]);
      assert.equal(s[0].f, "2026-11-26 04:31:00.123456");
      const st = await repo.syncState();
      assert.ok(st.get("session").ts.endsWith("Z"));
      const issues = await db.q(`SELECT kind, rp_ref FROM sa_sync_issue WHERE run_id = ?`, [r.run_id]);
      assert.ok(issues.some((i) => i.kind === "UNMAPPED_USER" && i.rp_ref === "uX"));
    });
    it("re-running is idempotent (no changes)", async () => {
      const r = await sync.run({ kind: "INCREMENTAL" });
      assert.equal(r.counts.session.inserted + r.counts.session.updated, 0);
    });
    it("a failure leaves the watermark where it was; a deferral is recorded as DEFERRED", async () => {
      const before = await repo.syncState();
      addSession("new1", "uA", 1026, 23, 0);
      spectra.calls = 0;
      fail = { at: 1, err: Object.assign(new Error("Service Unavailable"), { status: 503 }) };
      const r = await sync.run({ kind: "INCREMENTAL" });
      assert.equal(r.code, 500);
      assert.deepEqual(await repo.syncState(), before);
      spectra.calls = 0;
      fail = { at: 1, err: Object.assign(new Error("Retry-After 600 s above limit"), { status: 429, deferred: true, retryAfterSec: 600 }) };
      const d = await sync.run({ kind: "INCREMENTAL" });
      assert.equal(d.code, 503);
      const run = await db.q(`SELECT status, resume_after FROM sa_sync_run WHERE run_id = ?`, [d.run_id]);
      assert.equal(run[0].status, "DEFERRED");
      assert.ok(run[0].resume_after);
      fail = null;
      const ok = await sync.run({ kind: "INCREMENTAL" });
      assert.equal(ok.counts.session.inserted, 1);
    });
    it("a second run while one is running is refused", async () => {
      const p = sync.run({ kind: "INCREMENTAL" });
      const second = await sync.run({ kind: "INCREMENTAL" });
      assert.equal(second.code, 409);
      await p;
    });
  });

  describe("period figures from mirrored audits + allotment", () => {
    it("matches audits on store + auditor + article; pre-programme audits never count", async () => {
      U.invalidate();
      const a = await U.employee({ rpUserId: "uA", outlets: [7] });
      assert.equal(a.audited, 26); // 25 + new1; 'old' finalized 20 Nov is outside the cycle
      assert.equal(a.audited_own, 26);
      assert.equal(a.pending_c.value, 14);
      assert.equal(a.today, 0);
      assert.equal(a.calc_status, "PENDING_VERIFICATION");
      assert.equal(a.est.estimate.status, S.STATUS.PENDING);
      const x = await U.employee({ rpUserId: "uX", outlets: [7] });
      assert.equal(x.employee_id, null);
      assert.equal(x.audited_not_allotted, 1);
    });
    it("store figures, variance review-only, management pending before the deadline", async () => {
      const st = await U.store({ outletId: 7 });
      assert.equal(st.audited, 28);
      assert.equal(st.shortage_qty, 1);
      assert.equal(st.accuracy.status, S.STATUS.PENDING);
      const m = (await U.management({ outlets: [7] }))[0];
      assert.equal(m.storeManager.components[0].measure.reason, S.REASON.BEFORE_DEADLINE);
      assert.equal(m.supervisor.name, "Deepa");
      assert.equal(m.storeManager.name, "Elango");
      assert.equal(m.storeManager.amount.status, S.STATUS.PENDING);
    });
    it("stores without an allotment import show Unavailable, never 0 or 100%", async () => {
      const st = await U.store({ outletId: 5 });
      assert.equal(st.allotted.status, S.STATUS.UNAVAILABLE);
      assert.equal(st.completion.status, S.STATUS.UNAVAILABLE);
    });
    it("HR report data carries no individual incentive amount", async () => {
      const r = await U.hrReport({ date: "2026-11-27" });
      const text = JSON.stringify(r.stores);
      for (const k of ['"estimated"', '"est"', '"rate"', '"provisional"', '"approved_c"', '"estimate_employee"', '"estimated_employee"']) assert.ok(!text.includes(k), k);
      assert.equal(r.sample, false);
      const past = await U.hrReport({ date: "2026-11-25" });
      assert.equal(past.stores.find((s) => s.outlet_id === 7).audited, 0);
      await assert.rejects(U.hrReport({ date: "2026-12-30" }), (e) => e.status === 400);
    });
    it("Premier League: a season per period, provisional daily, weights locked, rules configurable", async () => {
      const { season_id } = await U.createSeason({ period_code: "2026-Q4", by: 900 });
      await assert.rejects(U.createSeason({ period_code: "2026-Q4", by: 900 }), (e) => e.status === 409);
      const rows = await U.standings({});
      assert.equal(rows.length, 5);
      assert.ok(rows.every((r) => r.provisional && !r.final));
      const locked = await U.updateSeason(season_id, { rules: { weights: { completion: 50 } } });
      assert.equal(locked.rules.weights.completion, 35); // weights can never be changed through the season
      await assert.rejects(U.updateSeason(season_id, { rules: { prize: { method: "LOTTERY", amount: 10000 } } }), (e) => e.status === 400);
      const s2 = await U.updateSeason(season_id, { deadline: "2026-12-06", rules: { tie_breakers: { confirmed: false, order: ["completion", "accuracy", "recount", "participation"] } } });
      assert.equal(s2.deadline, "2026-12-06");
      await assert.rejects(U.verifySeason(season_id, 900), (e) => e.status === 409); // before the deadline
      const snap = await U.snapshotStandings({});
      assert.equal(snap.saved, 5);
      assert.equal(snap.final, false);
    });
    it("mapping: nobody maps a RetailPilot user to themself", async () => {
      await assert.rejects(U.setMapping({ rp_user_id: "uX", employee_id: 900, by: 900 }), (e) => e.status === 403);
      await U.setMapping({ rp_user_id: "uX", employee_id: 504, by: 900 });
      const x = await U.employee({ rpUserId: "uX", outlets: [7] });
      assert.equal(x.employee_id, 504);
    });
  });

  describe("performance: 75,000-article allotment", () => {
    it("validates, confirms and computes 75,000 articles across five stores in bounded time", async () => {
      const stores = [["huABy", 3], ["FuUGY", 4], ["sooWy", 5], ["rnMT1", 6], ["kKFom", 7]];
      const files = [];
      let art = 200000;
      for (const [rp] of stores) for (let u = 0; u < 20; u++) { files.push({ name: `${rp}-${u}.csv`, text: csv(rp, `p${rp}${u}`, `p${u}`, range(art, 750)) }); art += 750; }
      const t0 = Date.now();
      const v = await U.validateUpload({ period_code: "2026-Q4", by: 900, files });
      const t1 = Date.now();
      assert.equal(v.summary.auditable, 75000);
      assert.equal(v.canConfirm, true);
      await U.confirmUpload(v.batch_id, 900);
      const t2 = Date.now();
      U.invalidate();
      const list = await U.employees({ size: 200 });
      const t3 = Date.now();
      assert.ok(list.total >= 100);
      console.log(`# 75,000 articles: validate+stage ${t1 - t0} ms, confirm ${t2 - t1} ms, compute ${t3 - t2} ms`);
      assert.ok(t1 - t0 < 60000 && t2 - t1 < 60000 && t3 - t2 < 30000);
    });
  });
});
