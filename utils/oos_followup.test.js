/**
 * Out-of-stock follow-up rules: cleaning the upload, tiers, causes (warehouse
 * stock, PO Tracker), and what each upload does to the cases.
 *
 *   node --test utils/oos_followup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const O = require("./oos_followup");

const row = (over = {}) => ({
  article_id: "103539",
  category: "Milk",
  article_name: "ponlait milk 500ml (green)",
  class: "A",
  store: "Vallalar  Salai",
  mrp: "24.0",
  cover_now: "0.0",
  planned: "28.0",
  pct: "0.0",
  stock: "0.0",
  value: "37388.71",
  ...over,
});

describe("cleanRows", () => {
  it("numbers, lower-case single-spaced store, class upper case", () => {
    const { rows, skipped } = O.cleanRows([row({ class: "a" })]);
    assert.equal(skipped.length, 0);
    assert.deepEqual(rows[0], {
      article_id: 103539, store: "vallalar salai", article_name: "ponlait milk 500ml (green)", category: "Milk",
      class: "A", mrp: 24, cover_now: 0, planned: 28, pct: 0, stock: 0, value: 37388.71,
    });
  });
  it("a line with no numeric Article ID or no store is skipped; a repeat keeps the first", () => {
    const { rows, skipped } = O.cleanRows([row(), row({ article_id: "x" }), row({ store: "" }), row({ value: "1" })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 37388.71);
    assert.deepEqual(skipped.map((s) => [s.line, s.reason]), [[3, "no Article ID or Store"], [4, "no Article ID or Store"], [5, "repeated line"]]);
  });
});

describe("tierOf", () => {
  const t = (over, outIn = 1) => O.tierOf({ ...O.cleanRows([row(over)]).rows[0] }, outIn);
  it("A and B: daily", () => {
    assert.equal(t({ class: "A" }), 1);
    assert.equal(t({ class: "B", value: "10" }), 1);
  });
  it("every warehouse line: daily, whatever the class", () => assert.equal(t({ class: "C", store: "warehouse", value: "1" }), 1));
  it("C: ageing, unless out in 5+ locations", () => {
    assert.equal(t({ class: "C", value: "1" }, 4), 2);
    assert.equal(t({ class: "C", value: "1" }, 5), 1);
  });
  it("X (slow moving): review, unless worth 5000 or more - spread does not lift it", () => {
    assert.equal(t({ class: "X", value: "4999" }, 6), 3);
    assert.equal(t({ class: "X", value: "5000" }), 1);
  });
});

describe("causeOf", () => {
  const r = O.cleanRows([row()]).rows[0];
  const base = { supplierCid: "RP10", warehouseQty: 0, po: null, reportDate: "2026-11-26" };
  it("store out, warehouse has stock: transfer", () => {
    assert.deepEqual(O.causeOf(r, { ...base, warehouseQty: 36 }), { cause: "warehouse_stock", detail: "Warehouse has 36" });
  });
  it("the warehouse's own line never blames warehouse stock", () => {
    const wh = O.cleanRows([row({ store: "warehouse" })]).rows[0];
    assert.equal(O.causeOf(wh, { ...base, warehouseQty: 36 }).cause, "no_po");
  });
  it("open PO on the PO Tracker: po_pending, with ref, age, status, fill and last remark", () => {
    const po = { po_slug: "s1", po_ref: "DN1/88", po_date: "2026-11-23", status: "PARTIALLY_FULFILLED", qty_fill_pct: 40, last_remark: "delivers Friday" };
    assert.deepEqual(O.causeOf(r, { ...base, po }), {
      cause: "po_pending",
      detail: 'PO DN1/88 · 3 days · partly received 40% · "delivers Friday"',
    });
    assert.equal(O.causeOf(r, { ...base, po: { ...po, status: "APPROVED", last_remark: null } }).detail, "PO DN1/88 · 3 days · not received");
  });
  it("latest PO fully received, or none: no_po", () => {
    const po = { po_ref: "DN1/80", po_date: "2026-11-20", status: "FULFILLED" };
    assert.deepEqual(O.causeOf(r, { ...base, po }), { cause: "no_po", detail: "No open PO (last: PO DN1/80 · 6 days · fulfilled)" });
    assert.deepEqual(O.causeOf(r, base), { cause: "no_po", detail: "No PO on the PO Tracker" });
  });
  it("no supplier in DNDS", () => assert.equal(O.causeOf(r, { ...base, supplierCid: null }).cause, "no_supplier"));
});

describe("poByStoreSupplier", () => {
  const slugs = new Map([["FuUGY", "vallalar salai"]]);
  it("keys by report store name and RP cid; an open PO wins on the same day", () => {
    const m = O.poByStoreSupplier(
      [
        { po_slug: "a", po_ref: "A", store_id: "FuUGY", supplier_id: "10", status: "FULFILLED", po_date: "2026-11-25" },
        { po_slug: "b", po_ref: "B", store_id: "FuUGY", supplier_id: "10", status: "APPROVED", po_date: "2026-11-25", last_followup: { remark: "called" } },
        { po_slug: "c", store_id: "unknown", supplier_id: "10", status: "APPROVED" },
      ],
      slugs
    );
    assert.deepEqual([...m.keys()], ["vallalar salai|RP10"]);
    assert.equal(m.get("vallalar salai|RP10").po_ref, "B");
    assert.equal(m.get("vallalar salai|RP10").last_remark, "called");
  });
});

describe("storeKeyOfOutlet", () => {
  it("DNDS outlet names to the report's store names", () => {
    assert.equal(O.storeKeyOfOutlet({ outlet_id: 2, outlet_name: "\tDaily Needs-Warehouse" }, 2), "warehouse");
    assert.equal(O.storeKeyOfOutlet({ outlet_id: 4, outlet_name: "Daily Needs-Vallalar Salai" }, 2), "vallalar salai");
    assert.equal(O.storeKeyOfOutlet({ outlet_id: 7, outlet_name: "Daily Needs - East Coast Road" }, 2), "ecr");
  });
});

describe("buildLines", () => {
  it("supplier and buyer from DNDS, cause, tier, and how many locations the article is out in", () => {
    const { rows } = O.cleanRows([row(), row({ store: "ecr", class: "C", value: "10" })]);
    const lines = O.buildLines(rows, {
      reportDate: "2026-11-26",
      enrichment: new Map([[103539, { distributor_id: "RP10", supplier_name: "Ponlait", buyer_id: 7, buyer_name: "C Saravanan" }]]),
      warehouseStock: new Map(),
      poByStoreSupplier: new Map([["ecr|RP10", { po_slug: "p", po_ref: "E/1", po_date: "2026-11-26", status: "APPROVED" }]]),
    });
    assert.deepEqual(
      lines.map((l) => [l.store, l.supplier_cid, l.buyer_id, l.cause, l.tier, l.stores_out, l.po_slug]),
      [
        ["vallalar salai", "RP10", 7, "no_po", 1, 2, null],
        ["ecr", "RP10", 7, "po_pending", 2, 2, "p"],
      ]
    );
  });
});

describe("planCases", () => {
  const line = (article, store) => ({ article_id: article, store });
  it("new lines open cases; open cases still out are updated; those missing are closed", () => {
    const plan = O.planCases(
      [line(1, "ecr"), line(2, "ecr")],
      [
        { id: 10, article_id: 1, store: "ecr", status: "open" },
        { id: 11, article_id: 3, store: "ecr", status: "open" },
      ],
      "2026-11-26"
    );
    assert.deepEqual(plan.insert.map((l) => l.article_id), [2]);
    assert.deepEqual(plan.update.map((u) => [u.id, u.reopen]), [[10, false]]);
    assert.deepEqual(plan.close, [11]);
  });
  it("a same-day re-upload reopens a case it closed earlier that day", () => {
    const plan = O.planCases([line(3, "ecr")], [{ id: 11, article_id: 3, store: "ecr", status: "closed", closed_on: "2026-11-26" }], "2026-11-26");
    assert.deepEqual(plan.update.map((u) => [u.id, u.reopen]), [[11, true]]);
    assert.deepEqual(plan.insert, []);
    assert.deepEqual(plan.close, []);
  });
});

describe("reportDateFromFileName", () => {
  it("the date in the export's name", () => {
    assert.equal(O.reportDateFromFileName("out_supplier_2026-11-26.csv"), "2026-11-26");
    assert.equal(O.reportDateFromFileName("oos.csv"), null);
  });
});
