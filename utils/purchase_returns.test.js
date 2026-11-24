/**
 * Business Dashboard - Purchase returns: the queries, how rows map, open
 * return age, grouping, and store scope.
 *
 *   node --test utils/purchase_returns.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const PR = require("./purchase_returns");
const { storeResolver } = require("./business_dashboard");
const usecaseFactory = require("../usecase/business_dashboard");

const BRANCHES = [
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "kathir" },
  { outlet_id: 9, outlet_name: "Warehouse", retailpilot_id: "wh" },
];

describe("queries", () => {
  it("settled: children of a return, by India day, only a valid range inlined", () => {
    const q = PR.buildSettledQuery("2026-11-24", "2026-11-24");
    assert.match(q, /p\.reconciliation_type = 'PURCHASE_RETURN'/);
    assert.match(q, /IN \('DEBIT_NOTE', 'PURCHASE_REPLACEMENT'\)/);
    assert.match(q, />= DATE '2026-11-24'/);
    assert.throws(() => PR.buildSettledQuery("2026-11-24'; --", "2026-11-24"));
  });

  it("open: returns with goods submitted", () => {
    assert.match(PR.buildOpenQuery(), /status = 'GOODS_SUBMITTED'/);
  });
});

describe("mapping", () => {
  const { resolve } = storeResolver(BRANCHES);

  it("settled rows keep debit notes and replacements, amounts positive", () => {
    const rows = PR.mapSettledRows(
      [
        { slug: "a", kind: "DEBIT_NOTE", amount: "-8561.4", store_id: "wh", supplier_id: 7, supplier_name: "Deva", created_at: "2026-11-23T20:00:00Z" },
        { slug: "b", kind: "PURCHASE_REPLACEMENT", amount: "100", store_id: "wh", supplier_id: 8, supplier_name: null, created_at: "2026-11-24T05:00:00Z" },
        { slug: "c", kind: "OTHER", amount: "5", store_id: "wh" },
      ],
      resolve
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { slug: "a", kind: "debit_note", amount: 8561.4, store: "outlet:9", supplier_id: "7", supplier_name: "Deva", day: "2026-11-24" });
    assert.equal(rows[1].supplier_name, "Supplier 8");
  });

  it("open rows age in India days", () => {
    const now = Date.parse("2026-11-24T06:45:00Z");
    const open = PR.mapOpenRows(
      [
        { slug: "x", amount: 100, store_id: "wh", supplier_id: 1, supplier_name: "A", created_at: "2026-11-01T04:00:00Z" },
        { slug: "y", amount: 50, store_id: "wh", supplier_id: 1, supplier_name: "A", created_at: "2026-11-10T04:00:00Z" },
        { slug: "z", amount: 900, store_id: "kathir", supplier_id: 2, supplier_name: "B", created_at: "2026-10-15T04:00:00Z" },
      ],
      resolve,
      now
    );
    assert.equal(open[0].age_days, 23);
    assert.deepEqual(open.map((r) => [r.store, r.raised_on, r.age_days]), [
      ["outlet:9", "2026-11-01", 23],
      ["outlet:9", "2026-11-10", 14],
      ["outlet:3", "2026-10-15", 40],
    ]);
  });
});

describe("usecase", () => {
  const spectra = (byTable) => ({
    isConfigured: () => true,
    queryAll: async (q) => (/GOODS_SUBMITTED/.test(q) ? byTable.open : byTable.settled),
  });

  it("narrows to the caller's stores, and one failing read leaves the other", async () => {
    const runway = {
      isConfigured: () => true,
      queryAll: async (q) => {
        if (/GOODS_SUBMITTED/.test(q)) throw new Error("not allowed");
        return [
          { slug: "a", kind: "DEBIT_NOTE", amount: 10, store_id: "wh", created_at: "2026-11-24T05:00:00Z" },
          { slug: "b", kind: "DEBIT_NOTE", amount: 20, store_id: "kathir", created_at: "2026-11-24T05:00:00Z" },
        ];
      },
    };
    const uc = usecaseFactory(spectra({}), runway, async () => BRANCHES, () => Date.parse("2026-11-24T06:00:00Z"));
    const res = await uc.getPurchaseReturns({ from_date: "2026-11-24", to_date: "2026-11-24", store_ids: [3] });
    assert.equal(res.code, 200);
    assert.deepEqual(res.data.settled.rows.map((r) => r.slug), ["b"]);
    assert.deepEqual(res.data.stores.map((s) => s.name), ["Kathirkamam"]);
    assert.equal(res.data.open.ok, false);
    assert.match(res.data.open.error, /not allowed/);
  });

  it("refuses a bad range", async () => {
    const uc = usecaseFactory(spectra({}), spectra({}), async () => BRANCHES);
    assert.equal((await uc.getPurchaseReturns({ from_date: "x", to_date: "2026-11-24" })).code, 422);
  });
});
