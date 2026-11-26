/**
 * Out-of-stock follow-up, end to end over an in-memory repository: two
 * mornings' uploads, the chaser's and a buyer's views, answers and access.
 *
 *   node --test usecase/oos_followup.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const factory = require("./oos_followup");

function memoryRepo() {
  const cases = [];
  const events = [];
  const uploads = [];
  let nextId = 1;
  return {
    cases,
    eventLog: events,
    uploads,
    enrichment: async (ids) =>
      new Map(
        ids
          .filter((id) => id !== 999)
          .map((id) => [id, id === 300 ? { distributor_id: null } : { distributor_id: "RP10", supplier_name: "Ponlait", buyer_id: id === 200 ? 8 : 7, buyer_name: id === 200 ? "Prashanth" : "Saravanan" }])
      ),
    warehouseStock: async () => new Map([[200, 12]]),
    outlets: async () => [
      { outlet_id: 2, outlet_name: "\tDaily Needs-Warehouse", retailpilot_id: "9rJMC" },
      { outlet_id: 4, outlet_name: "Daily Needs-Vallalar Salai", retailpilot_id: "FuUGY" },
    ],
    latestReportDate: async () => (uploads.length ? uploads.map((u) => u.report_date).sort().pop() : null),
    latestUpload: async () => (uploads.length ? { ...uploads[uploads.length - 1], warnings: uploads[uploads.length - 1].warnings.join("\n") } : null),
    existingFor: async (d) =>
      cases.filter((c) => c.status === "open" || c.closed_on === d).map((c) => ({ id: c.oos_case_id, article_id: c.article_id, store: c.store, status: c.status, closed_on: c.closed_on })),
    applyUpload: async ({ reportDate, fileName, plan, warnings }) => {
      for (const l of plan.insert) cases.push({ ...l, oos_case_id: nextId++, status: "open", opened_on: reportDate, last_seen_on: reportDate, closed_on: null, reason: null });
      for (const u of plan.update) Object.assign(cases.find((c) => c.oos_case_id === u.id), u.line, { status: "open", last_seen_on: reportDate, closed_on: null });
      for (const id of plan.close) Object.assign(cases.find((c) => c.oos_case_id === id), { status: "closed", closed_on: reportDate });
      uploads.push({ report_date: reportDate, file_name: fileName, warnings });
      return { upload_id: uploads.length };
    },
    openCases: async ({ buyerId, includeHidden, hiding }) =>
      cases.filter(
        (c) =>
          c.status === "open" &&
          (buyerId == null || (buyerId === "none" ? c.buyer_id == null : c.buyer_id === buyerId)) &&
          (includeHidden || !hiding.includes(c.reason))
      ),
    closedOn: async (d) => {
      const m = new Map();
      for (const c of cases.filter((x) => x.status === "closed" && x.closed_on === d)) m.set(c.buyer_id, (m.get(c.buyer_id) || 0) + 1);
      return [...m].map(([buyer_id, n]) => ({ buyer_id, n }));
    },
    getCase: async (id) => cases.find((c) => c.oos_case_id === id) || null,
    addEvent: async (id, { reason, note, employeeId }) => {
      const c = cases.find((x) => x.oos_case_id === id);
      if (reason) c.reason = reason;
      if (note) c.last_note = note;
      events.push({ id, reason, note, employeeId });
    },
    events: async (id) => events.filter((e) => e.id === id),
  };
}

const poTracker = {
  list: async () => ({
    code: 200,
    data: { orders: [{ po_slug: "p1", po_ref: "WH/9", store_id: "9rJMC", supplier_id: "10", status: "APPROVED", po_date: "2026-11-24" }] },
  }),
};

const line = (article_id, store, cls, value) => ({ article_id: String(article_id), article_name: `item ${article_id}`, category: "c", class: cls, store, value: String(value) });

describe("out-of-stock follow-up", () => {
  let repo;
  let uc;
  let today;
  beforeEach(() => {
    repo = memoryRepo();
    today = "2026-11-26";
    uc = factory(repo, poTracker, { warehouseOutletId: 2, today: () => today });
  });

  it("day 1: lines become cases with supplier, buyer, cause and tier; warnings for what could not be matched", async () => {
    const r = await uc.upload({
      fileName: "out_supplier_2026-11-26.csv",
      rows: [line(100, "warehouse", "C", 10), line(200, "vallalar salai", "B", 500), line(300, "ecr", "X", 50), line(999, "ecr", "C", 5)],
      employeeId: 1,
    });
    assert.equal(r.code, 200, r.msg);
    assert.equal(r.report_date, "2026-11-26");
    assert.deepEqual([r.opened, r.still_out, r.back_in_stock], [4, 0, 0]);
    assert.deepEqual(r.tiers, { daily: 2, ageing: 1, review: 1 });
    assert.deepEqual(r.causes, { warehouse_stock: 1, po_pending: 1, no_po: 0, no_supplier: 2 });
    assert.ok(r.warnings.some((w) => /ecr/.test(w)), "ecr has no outlet with a RetailPilot id here");
    assert.ok(r.warnings.some((w) => /1 line\(s\) whose article is not in DNDS/.test(w)));
    const wh = repo.cases.find((c) => c.store === "warehouse");
    assert.equal(wh.cause, "po_pending");
    assert.match(wh.cause_detail, /^PO WH\/9 · 2 days · not received/);
  });

  it("day 2: still out carries on (days out), missing ones close, an older report is refused", async () => {
    await uc.upload({ fileName: "out_supplier_2026-11-26.csv", rows: [line(100, "warehouse", "C", 10), line(200, "vallalar salai", "B", 500)], employeeId: 1 });
    today = "2026-11-27";
    const r = await uc.upload({ fileName: "out_supplier_2026-11-27.csv", rows: [line(200, "vallalar salai", "B", 500), line(201, "vallalar salai", "A", 9)], employeeId: 1 });
    assert.deepEqual([r.opened, r.still_out, r.back_in_stock], [1, 1, 1]);
    const v = await uc.view({ employeeId: 1, canChase: true });
    const c200 = v.data.cases.find((c) => c.article_id === 200);
    assert.deepEqual([c200.days_out, c200.is_new, c200.list, c200.needs_update], [2, false, "chase", true]);
    assert.equal(v.data.cases.find((c) => c.article_id === 201).is_new, true);
    const older = await uc.upload({ fileName: "out_supplier_2026-11-26.csv", rows: [line(1, "ecr", "A", 1)], employeeId: 1 });
    assert.equal(older.code, 409);
  });

  it("a same-day re-upload replaces the day: reopened, not duplicated", async () => {
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(100, "warehouse", "C", 10)], employeeId: 1 });
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(200, "vallalar salai", "B", 1)], employeeId: 1 });
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(100, "warehouse", "C", 10), line(200, "vallalar salai", "B", 1)], employeeId: 1 });
    assert.equal(repo.cases.length, 2);
    assert.ok(repo.cases.every((c) => c.status === "open"));
  });

  it("chaser sees everyone and a scoreboard; a buyer sees only their own lines", async () => {
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(100, "warehouse", "A", 10), line(200, "vallalar salai", "B", 500), line(300, "ecr", "C", 1)], employeeId: 1 });
    const chaser = await uc.view({ employeeId: 1, canChase: true });
    assert.equal(chaser.data.cases.length, 3);
    assert.deepEqual(
      chaser.data.scoreboard.map((r) => [r.buyer_name, r.to_chase, r.class_a, r.not_updated]),
      [["Prashanth", 1, 0, 1], ["Saravanan", 1, 1, 1], ["No buyer", 0, 0, 0]]
    );
    const buyer = await uc.view({ employeeId: 8, canChase: false });
    assert.deepEqual(buyer.data.cases.map((c) => c.article_id), [200]);
    assert.equal(buyer.data.scoreboard, null);
  });

  it("answers: own line only (unless chaser); discontinued hides the line; notes need text", async () => {
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(100, "warehouse", "A", 10), line(200, "vallalar salai", "B", 500)], employeeId: 1 });
    const id200 = repo.cases.find((c) => c.article_id === 200).oos_case_id;
    assert.equal((await uc.answer({ id: id200, reason: "ordered", employeeId: 7, canChase: false })).code, 403, "buyer 7 does not own article 200");
    assert.equal((await uc.answer({ id: id200, note: "  ", employeeId: 8, canChase: false })).code, 422);
    assert.equal((await uc.answer({ id: id200, reason: "bogus", employeeId: 8, canChase: false })).code, 422);
    assert.equal((await uc.answer({ id: id200, reason: "discontinued", note: "delisted", employeeId: 8, canChase: false })).code, 200);
    assert.deepEqual((await uc.view({ employeeId: 8, canChase: false })).data.cases, []);
    assert.equal((await uc.view({ employeeId: 8, canChase: false, includeHidden: true })).data.cases.length, 1);
    assert.equal((await uc.answer({ id: id200, note: "called buyer", employeeId: 1, canChase: true })).code, 200, "the chaser notes any line");
    assert.equal((await uc.events({ id: id200, employeeId: 8, canChase: false })).data.length, 2);
  });

  it("answerMany: one answer for an item's stores; all checked before any is saved", async () => {
    await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(200, "vallalar salai", "B", 5), line(200, "ecr", "B", 5), line(100, "warehouse", "A", 1)], employeeId: 1 });
    const ids200 = repo.cases.filter((c) => c.article_id === 200).map((c) => c.oos_case_id);
    const id100 = repo.cases.find((c) => c.article_id === 100).oos_case_id;
    assert.equal((await uc.answerMany({ ids: [...ids200, id100], reason: "ordered", employeeId: 8, canChase: false })).code, 403);
    assert.equal(repo.eventLog.length, 0, "nothing saved when one line is not theirs");
    const r = await uc.answerMany({ ids: ids200, reason: "ordered", note: "PO raised", employeeId: 8, canChase: false });
    assert.deepEqual([r.code, r.saved], [200, 2]);
    assert.ok(repo.cases.filter((c) => c.article_id === 200).every((c) => c.reason === "ordered"));
  });

  it("PO Tracker down: the upload still goes through, with a warning", async () => {
    uc = factory(repo, { list: async () => ({ code: 502, msg: "RetailPilot: timeout" }) }, { warehouseOutletId: 2, today: () => today });
    const r = await uc.upload({ fileName: "x_2026-11-26.csv", rows: [line(100, "warehouse", "A", 10)], employeeId: 1 });
    assert.equal(r.code, 200);
    assert.ok(r.warnings.some((w) => /PO Tracker unavailable/.test(w)));
  });

  it("a future report date is refused", async () => {
    const r = await uc.upload({ fileName: "x_2026-11-28.csv", rows: [line(100, "warehouse", "A", 10)], employeeId: 1 });
    assert.equal(r.code, 422);
  });
});
