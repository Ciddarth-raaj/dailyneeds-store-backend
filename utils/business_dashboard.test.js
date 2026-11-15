/**
 * Business Dashboard - the RetailPilot queries, how rows map to branches,
 * how invoice types count, store scope, and one section failing alone.
 *
 *   node --test utils/business_dashboard.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const B = require("./business_dashboard");
const usecaseFactory = require("../usecase/business_dashboard");

const BRANCHES = [
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "kathir-slug" },
  { outlet_id: 4, outlet_name: "Vallalar Salai", retailpilot_id: "vallalar-slug" },
];

describe("the range", () => {
  it("takes real days, in order, at most 93 days", () => {
    assert.deepEqual(B.validRange("2026-11-01", "2026-11-15"), { from: "2026-11-01", to: "2026-11-15" });
    assert.ok(B.validRange("2026-11-15", "2026-11-01").error);
    assert.ok(B.validRange("2026-02-30", "2026-03-01").error);
    assert.ok(B.validRange("2026-01-01", "2026-12-31").error);
    assert.ok(B.validRange("2026-11-01'; DROP TABLE bills; --", "2026-11-02").error);
  });

  it("queries refuse anything but a valid range and inline only the two days", () => {
    const q = B.buildSalesRangeQuery("2026-11-01", "2026-11-15");
    assert.match(q, /BETWEEN DATE '2026-11-01' AND DATE '2026-11-15'/);
    assert.match(q, /FROM public\.bills/);
    assert.throws(() => B.buildSalesRangeQuery("2026-11-01", "x"));
    assert.throws(() => B.buildPurchaseRangeQuery("2026-11-15", "2026-11-01"));
    const pq = B.buildPurchaseRangeQuery("2026-11-01", "2026-11-15");
    assert.doesNotMatch(pq, /invoice_type = /);
    // SPECTRA parameterises literals: no GROUP BY on the time-zone expression.
    assert.doesNotMatch(pq, /GROUP BY/);
  });
});

describe("invoice types", () => {
  it("PURCHASE is a purchase, a return or debit type a purchase return, others not counted", () => {
    assert.equal(B.invoiceTypeKind("PURCHASE"), "purchase");
    assert.equal(B.invoiceTypeKind("purchase_return"), "purchase_return");
    assert.equal(B.invoiceTypeKind("DEBIT_NOTE"), "purchase_return");
    assert.equal(B.invoiceTypeKind("FREIGHT"), null);
    assert.equal(B.invoiceTypeKind(null), null);
  });

  it("purchases and returns fold per day per store; uncounted types are still reported", () => {
    const { resolve } = B.storeResolver(BRANCHES);
    const out = B.mapPurchaseRows(
      [
        { day: "2026-11-02", store_id: "kathir-slug", invoice_type: "PURCHASE", amount: "1000.50", invoices: 2 },
        { day: "2026-11-02", store_id: "kathir-slug", invoice_type: "PURCHASE_RETURN", amount: "-200", invoices: 1 },
        { day: "2026-11-02", store_id: "kathir-slug", invoice_type: "FREIGHT", amount: "50", invoices: 1 },
        { day: "2026-11-02", store_id: "kathir-slug", invoice_type: "PURCHASE", amount: "99.50" },
      ],
      resolve
    );
    assert.deepEqual(out.rows, [
      { day: "2026-11-02", store: "outlet:3", purchase: 1100, purchase_invoices: 3, purchase_return: 200, purchase_return_invoices: 1 },
    ]);
    assert.deepEqual(out.invoice_types.map((t) => [t.type, t.counted_as]), [
      ["PURCHASE", "purchase"],
      ["FREIGHT", null],
      ["PURCHASE_RETURN", "purchase_return"],
    ]);
  });
});

describe("margin", () => {
  it("the query reads bill lines, signs returns, and keeps no-cost lines out of the margin", () => {
    const q = B.buildMarginRangeQuery("2026-11-01", "2026-11-15");
    assert.match(q, /FROM public\.bill_details d/);
    assert.match(q, /\(d\.line_payable - d\.total_tax\) \* b\.sign/);
    assert.match(q, /FILTER \(WHERE d\.total_landing_without_tax > 0\)/);
    assert.match(q, /BETWEEN DATE '2026-11-01' AND DATE '2026-11-15'/);
    assert.throws(() => B.buildMarginRangeQuery("2026-11-15", "2026-11-01"));
  });

  it("margin is costed sales minus cost; uncosted sales are reported apart", () => {
    const { resolve } = B.storeResolver(BRANCHES);
    const [m] = B.mapMarginRows(
      [{ day: "2026-11-02", store_slug: "kathir-slug", store_name: "Kathirkamam", sales_ex_tax: "1100", costed_sales: "1000", cost: "820.5", uncosted_sales: "100" }],
      resolve
    );
    assert.deepEqual(m, { day: "2026-11-02", store: "outlet:3", sales_ex_tax: 1100, costed_sales: 1000, cost: 820.5, margin: 179.5, uncosted_sales: 100 });
  });
});

describe("stores", () => {
  it("matches by RetailPilot ID, else by branch name, else keeps the store unmapped", () => {
    const { resolve } = B.storeResolver(BRANCHES);
    assert.equal(resolve("kathir-slug").key, "outlet:3");
    assert.equal(resolve("other-slug", "VALLALAR SALAI").key, "outlet:4");
    const u = resolve("new-store", "New Store");
    assert.deepEqual([u.key, u.mapped, u.outlet_id], ["rp:new-store", false, null]);
  });

  it("stock sums locations and keeps the main location's value apart", () => {
    const { resolve } = B.storeResolver(BRANCHES);
    const [s] = B.mapStockRows(
      [
        { store_id: "kathir-slug", stock_location: "main", quantity: 10, cost_value: 100, mrp_value: 150, articles: 4 },
        { store_id: "kathir-slug", stock_location: "damaged", quantity: 2, cost_value: 20, mrp_value: 30, articles: 1 },
      ],
      resolve
    );
    assert.equal(s.cost_value, 120);
    assert.equal(s.sellable_cost_value, 100);
    assert.equal(s.mrp_value, 180);
    assert.equal(s.locations.length, 2);
  });
});

describe("open gate passes", () => {
  it("the query takes OPEN passes only, oldest first, with any inspection", () => {
    const q = B.buildOpenGatePassQuery();
    assert.match(q, /FROM public\.gate_passes g/);
    assert.match(q, /WHERE g\.status = 'OPEN'/);
    assert.match(q, /LEFT JOIN public\.grn_inspection_header i ON i\.gatepass_slug = g\.slug/);
    assert.match(q, /ORDER BY g\.entry_time/);
  });

  it("one row per pass, supplier named, age from entry, inspections collected", () => {
    const { resolve } = B.storeResolver(BRANCHES);
    const now = Date.parse("2026-11-15T06:00:00Z");
    const rows = B.mapGatePassRows(
      [
        { slug: "GP-1", store_id: "kathir-slug", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-1", inspection_state: "IN_PROGRESS" },
        { slug: "GP-1", store_id: "kathir-slug", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-2", inspection_state: "DONE" },
        { slug: "GP-2", store_id: "nowhere", supplier_id: "9", entry_time: "2026-11-15T04:30:00Z", inspection_slug: null },
      ],
      [{ id: "42", name: "Acme Foods" }],
      resolve,
      now
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      [rows[0].store, rows[0].supplier_name, rows[0].open_hours, rows[0].inspections.length],
      ["outlet:3", "Acme Foods", 24, 2]
    );
    assert.deepEqual([rows[1].store, rows[1].supplier_name, rows[1].open_hours, rows[1].inspections], ["rp:nowhere", null, 1.5, []]);
  });

  it("an Own Store caller sees only their branch's passes", async () => {
    const runway = fakeSpectra((q) => {
      if (/gate_passes/.test(q)) {
        return [
          { slug: "GP-1", store_id: "kathir-slug", supplier_id: "1", entry_time: "2026-11-14T06:00:00Z" },
          { slug: "GP-2", store_id: "vallalar-slug", supplier_id: "1", entry_time: "2026-11-14T06:00:00Z" },
        ];
      }
      return [];
    });
    const sales = fakeSpectra(() => []);
    const uc = usecaseFactory(sales, runway, async () => BRANCHES);
    const r = await uc.getSummary({ from_date: "2026-11-01", to_date: "2026-11-15", store_ids: [4] });
    assert.deepEqual(r.data.gate_passes.rows.map((g) => g.slug), ["GP-2"]);
  });
});

const fakeSpectra = (handler) => ({
  isConfigured: () => true,
  calls: 0,
  async queryAll(q) {
    this.calls += 1;
    return handler(q);
  },
});

describe("the summary", () => {
  const sales = () =>
    fakeSpectra(() => [
      { day: "2026-11-02", store_slug: "kathir-slug", store_name: "Kathirkamam", sales: 5000, returns: 100, bills: 40, return_bills: 1 },
      { day: "2026-11-02", store_slug: "vallalar-slug", store_name: "Vallalar", sales: 3000, returns: 0, bills: 20, return_bills: 0 },
      { day: "2026-11-02", store_slug: "mystery", store_name: "Mystery", sales: 10, returns: 0, bills: 1, return_bills: 0 },
    ]);
  const runway = () =>
    fakeSpectra((q) =>
      /invoice_headers/.test(q)
        ? [{ day: "2026-11-02", store_id: "kathir-slug", invoice_type: "PURCHASE", amount: 900, invoices: 3 }]
        : [{ store_id: "vallalar-slug", stock_location: "main", quantity: 5, cost_value: 50, mrp_value: 70, articles: 2 }]
    );

  it("All Stores sees every store, unmapped ones included, and the invoice types", async () => {
    const uc = usecaseFactory(sales(), runway(), async () => BRANCHES);
    const r = await uc.getSummary({ from_date: "2026-11-01", to_date: "2026-11-15", store_ids: null });
    assert.equal(r.code, 200);
    assert.equal(r.data.sales.rows.length, 3);
    assert.ok(r.data.stores.some((s) => s.key === "rp:mystery" && !s.mapped));
    assert.equal(r.data.purchases.invoice_types.length, 1);
    assert.equal(r.data.purchases.purchase_return_found, false);
    assert.equal(r.data.margin.ok, true);
  });

  it("Own Store sees its branch only, and no company-wide invoice type totals", async () => {
    const uc = usecaseFactory(sales(), runway(), async () => BRANCHES);
    const r = await uc.getSummary({ from_date: "2026-11-01", to_date: "2026-11-15", store_ids: [3] });
    assert.deepEqual(r.data.stores.map((s) => s.key), ["outlet:3"]);
    assert.deepEqual(r.data.sales.rows.map((x) => x.store), ["outlet:3"]);
    assert.equal(r.data.purchases.rows.length, 1);
    assert.equal(r.data.stock.rows.length, 0);
    assert.deepEqual(r.data.purchases.invoice_types, []);
  });

  it("a section that fails comes back alone as an error", async () => {
    const broken = fakeSpectra(() => {
      throw new Error("SPECTRA error: whitelist_violation");
    });
    const uc = usecaseFactory(broken, runway(), async () => BRANCHES);
    const r = await uc.getSummary({ from_date: "2026-11-01", to_date: "2026-11-15", store_ids: null });
    assert.equal(r.data.sales.ok, false);
    assert.match(r.data.sales.error, /whitelist_violation/);
    assert.equal(r.data.purchases.ok, true);
    assert.equal(r.data.stock.ok, true);
  });

  it("answers are reused for five minutes unless refreshed", async () => {
    let t = 0;
    const s = sales();
    const uc = usecaseFactory(s, runway(), async () => BRANCHES, () => t);
    const args = { from_date: "2026-11-01", to_date: "2026-11-02", store_ids: null };
    // The sales key answers two queries per summary: bills and bill lines (margin).
    await uc.getSummary(args);
    await uc.getSummary(args);
    assert.equal(s.calls, 2);
    await uc.getSummary({ ...args, refresh: true });
    assert.equal(s.calls, 4);
    t = 6 * 60 * 1000;
    await uc.getSummary(args);
    assert.equal(s.calls, 6);
  });

  it("a bad range is a 422", async () => {
    const uc = usecaseFactory(sales(), runway(), async () => BRANCHES);
    const r = await uc.getSummary({ from_date: "2026-11-15", to_date: "2026-11-01" });
    assert.equal(r.code, 422);
  });
});
