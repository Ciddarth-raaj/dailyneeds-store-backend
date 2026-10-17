/**
 *   node --test utils/retailpilot_purchase.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildPurchaseQuery, mapPurchases, contentTs } = require("./retailpilot_purchase");
const spectraFactory = require("../services/retailpilot_spectra");
const syncFactory = require("../usecase/retailpilot_purchase_sync");

const STORE_MAP = { "store-a": 2 };

const row = (over = {}) => ({
  invoice_slug: "INV-1001",
  supplier_invoice_id: "B-1",
  mrc_no: 6372,
  store_id: "store-a",
  supplier_id: "S1",
  supplier_name: "A Supplier",
  supplier_gstn: "34AAAAA0000A1Z5",
  received_date: "2026-10-15",
  invoice_date: "2026-10-14",
  invoice_amount: "1640.00",
  tcs: "0",
  cgst_rate: "2.5",
  sgst_rate: "2.5",
  igst_rate: "0",
  cess_rate: "0",
  taxable: "1000",
  ...over,
});

describe("buildPurchaseQuery", () => {
  it("subtracts integer days, never INTERVAL", () => {
    const q = buildPurchaseQuery(3);
    assert.match(q, /CURRENT_DATE - 3\b/);
    assert.doesNotMatch(q, /INTERVAL/i);
  });

  it("reads PURCHASE invoices only, by bill date or by when they were entered or changed", () => {
    const q = buildPurchaseQuery(3);
    assert.match(q, /h\.invoice_type = 'PURCHASE'/);
    assert.match(q, /h\.seq\s+AS mrc_no/);
    assert.match(q, /COALESCE\(h\.received_date, h\.invoice_date\) >= CURRENT_DATE - 3/);
    assert.match(q, /COALESCE\(h\.updated_at, h\.created_at\) >= CURRENT_DATE - 3/);
  });

  it("names the supplier by trade name, falling back to the vendor name", () => {
    assert.match(buildPurchaseQuery(3), /COALESCE\(NULLIF\(TRIM\(v\.trade_name\), ''\), v\.name\) AS supplier_name/);
  });

  it("refuses anything but a non-negative integer", () => {
    for (const bad of [-1, 1.5, "3; DROP", null, undefined]) {
      assert.throws(() => buildPurchaseQuery(bad));
    }
  });
});

describe("mapPurchases", () => {
  it("folds rate rows into one purchase in the /purchase/bulk shape", () => {
    const { purchases, skipped } = mapPurchases(
      [row(), row({ cgst_rate: "9", sgst_rate: "9", taxable: "500" })],
      STORE_MAP
    );
    assert.equal(skipped.length, 0);
    assert.equal(purchases.length, 1);
    const p = purchases[0];
    assert.equal(p.STORE_ID, 2);
    assert.equal(p.MRC_REF, "6372", "the reference (Tally voucher number) is seq");
    assert.equal(p.RP_INVOICE_SLUG, "INV-1001");
    assert.equal(p.MRC_DATE, "2026-10-15");
    assert.equal(p.DIST_BILL_DT, "2026-10-14");
    assert.equal(p.DIST_BILL_NO, "B-1");
    assert.equal(p.MRC_NO, 6372);
    assert.equal(p.MRC_AMT, 1640);
    assert.deepEqual(p.SGST, [
      { PERC: 2.5, TAXABLE: 1000, VALUE: 25 },
      { PERC: 9, TAXABLE: 500, VALUE: 45 },
    ]);
    assert.deepEqual(p.CGST, p.SGST);
    assert.deepEqual(p.IGST, []);
    assert.equal(p.TOT_SGST_AMT, 70);
    assert.equal(p.TOT_CGST_AMT, 70);
    assert.equal(p.TOT_IGST_AMT, 0);
    assert.equal(typeof p.TS, "number");
  });

  it("puts IGST lines and cess in their own arrays", () => {
    const { purchases } = mapPurchases(
      [row({ supplier_gstn: "29BBBBB0000B1Z5", cgst_rate: 0, sgst_rate: 0, igst_rate: 28, cess_rate: 12, taxable: 100 })],
      STORE_MAP
    );
    const p = purchases[0];
    assert.deepEqual(p.IGST, [{ PERC: 28, TAXABLE: 100, VALUE: 28 }]);
    assert.deepEqual(p.CESS, [{ PERC: 12, TAXABLE: 100, VALUE: 12 }]);
    assert.equal(p.TOT_GST_CESS_AMT, 12);
    assert.deepEqual(p.SGST, []);
  });

  it("files a 0% line as local or IGST by supplier GSTIN, like the Tally export", () => {
    const zero = { cgst_rate: 0, sgst_rate: 0, igst_rate: 0, taxable: 200 };
    const local = mapPurchases([row(zero)], STORE_MAP).purchases[0];
    assert.deepEqual(local.SGST, [{ PERC: 0, TAXABLE: 200, VALUE: 0 }]);
    assert.deepEqual(local.IGST, []);
    const inter = mapPurchases([row({ ...zero, supplier_gstn: "29BBBBB0000B1Z5" })], STORE_MAP).purchases[0];
    assert.deepEqual(inter.IGST, [{ PERC: 0, TAXABLE: 200, VALUE: 0 }]);
    assert.deepEqual(inter.SGST, []);
  });

  it("counts a row repeated across pages once", () => {
    const { purchases } = mapPurchases([row(), row()], STORE_MAP);
    assert.equal(purchases[0].TOT_SGST_AMT, 25);
  });

  it("skips, with a reason, what would not fit or has no outlet", () => {
    const { purchases, skipped } = mapPurchases(
      [
        row({ invoice_slug: "A", store_id: "unknown", mrc_no: 1 }),
        row({ invoice_slug: "C", supplier_invoice_id: "x".repeat(51), mrc_no: 2 }),
        row({ invoice_slug: "B", received_date: null, invoice_date: null, mrc_no: 3 }),
        row({ invoice_slug: "D", mrc_no: null }),
      ],
      STORE_MAP
    );
    assert.equal(purchases.length, 0);
    assert.deepEqual(skipped.map((s) => s.invoice_slug), ["A", "C", "B", "D"]);
    assert.match(skipped[0].reason, /RETAILPILOT_STORE_MAP/);
    assert.match(skipped[1].reason, /DIST_BILL_NO/);
    assert.match(skipped[2].reason, /date/);
    assert.match(skipped[3].reason, /no seq/);
  });

  it("takes MRC_NO and the reference from seq, and refuses a seq used twice in a store", () => {
    const one = mapPurchases([row({ mrc_no: "6400" })], STORE_MAP).purchases[0];
    assert.equal(one.MRC_NO, 6400);
    assert.equal(one.MRC_REF, "6400");
    const { purchases, skipped } = mapPurchases(
      [row({ invoice_slug: "P" }), row({ invoice_slug: "Q" })],
      STORE_MAP
    );
    assert.equal(purchases.length, 1);
    assert.match(skipped[0].reason, /seq 6372 is used by another invoice \(P\)/);
  });

  it("keeps the date part of a timestamp without shifting it", () => {
    const p = mapPurchases([row({ received_date: "2026-10-15T23:30:00+05:30" })], STORE_MAP).purchases[0];
    assert.equal(p.MRC_DATE, "2026-10-15");
  });

  it("TS changes when the purchase changes, and only then", () => {
    const a = mapPurchases([row()], STORE_MAP).purchases[0];
    const b = mapPurchases([row()], STORE_MAP).purchases[0];
    const c = mapPurchases([row({ invoice_amount: "1641" })], STORE_MAP).purchases[0];
    assert.equal(a.TS, b.TS);
    assert.notEqual(a.TS, c.TS);
    assert.ok(Number.isSafeInteger(contentTs({ x: 1 })));
  });
});

describe("the store map", () => {
  const { parseStoreMap, DEFAULT_STORE_MAP } = require("../config/retailpilot");
  const { WAREHOUSE_OUTLET_ID } = require("../constants/outlets");

  it("defaults to the six RetailPilot stores", () => {
    assert.deepEqual(parseStoreMap(""), {
      "9rJMC": WAREHOUSE_OUTLET_ID, FuUGY: 4, huABy: 3, sooWy: 5, rnMT1: 6, kKFom: 7,
    });
    assert.deepEqual(parseStoreMap(undefined), DEFAULT_STORE_MAP);
  });

  it("is replaced by RETAILPILOT_STORE_MAP, and a broken value falls back", () => {
    assert.deepEqual(parseStoreMap('{"abc": 9, "bad": "x"}'), { abc: 9 });
    assert.deepEqual(parseStoreMap("not json"), DEFAULT_STORE_MAP);
  });
});

describe("the SPECTRA client", () => {
  const config = { baseUrl: "https://rp.example", apiKey: "k", product: "runway", pageSize: 2, timeoutMs: 1000 };

  it("sends the auth headers and reads every page", async () => {
    const calls = [];
    const http = async (req) => {
      calls.push(req);
      const page = req.data.page;
      return { data: { data: [{ n: page }], pagination: { total: 2, has_next: page < 2 } } };
    };
    const rows = await spectraFactory(config, http).queryAll("SELECT 1");
    assert.deepEqual(rows, [{ n: 1 }, { n: 2 }]);
    assert.equal(calls[0].url, "https://rp.example/spectra/query");
    assert.equal(calls[0].headers["X-Authentication"], "k");
    assert.equal(calls[0].headers["X-Product"], "runway");
  });

  it("turns a SPECTRA error body into a thrown error", async () => {
    const http = async () => ({ data: { error: "bad", detail: "syntax" } });
    await assert.rejects(spectraFactory(config, http).queryAll("x"), /SPECTRA error: bad - syntax/);
  });

  it("refuses to call anything without a URL and key", async () => {
    await assert.rejects(spectraFactory({ ...config, apiKey: "" }, async () => ({})).queryAll("x"), /not configured/);
  });
});

describe("the sync", () => {
  const spectra = (rows) => ({ isConfigured: () => true, queryAll: async () => rows });
  const config = { storeMap: STORE_MAP, purchaseLookbackDays: 3 };

  it("saves through bulkCreatePurchase and reports counts and skips", async () => {
    let saved;
    const purchaseUsecase = {
      bulkCreatePurchase: async (list) => {
        saved = list;
        return { code: 200, insertedCount: 1, updatedCount: 0, unchangedCount: 0 };
      },
    };
    const result = await syncFactory(
      spectra([row(), row({ invoice_slug: "Z", store_id: "nope", mrc_no: 9 })]),
      purchaseUsecase,
      config
    ).run();
    assert.equal(saved.length, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.warnings.length, 1);
  });

  it("skips a seq whose reference already belongs to a different bill at the outlet", async () => {
    let saved;
    const existing = [
      { purchase_id: 77, retail_outlet_id: 2, mmh_mrc_refno: "6372", supplier_gstn: "33OTHER", mmh_dist_bill_no: "OLD-9" },
      { purchase_id: 78, retail_outlet_id: 2, mmh_mrc_refno: "6373", supplier_gstn: "34AAAAA0000A1Z5", mmh_dist_bill_no: "B-2" },
    ];
    const purchaseUsecase = {
      findByOutletRefnos: async (pairs) => {
        assert.deepEqual(pairs, [[2, "6372"], [2, "6373"]]);
        return existing;
      },
      bulkCreatePurchase: async (list) => {
        saved = list;
        return { code: 200, insertedCount: 0, updatedCount: 1, unchangedCount: 0 };
      },
    };
    const result = await syncFactory(
      spectra([row({ invoice_slug: "OLD" }), row({ invoice_slug: "SAME", mrc_no: 6373, supplier_invoice_id: "B-2" })]),
      purchaseUsecase,
      config
    ).run();
    assert.deepEqual(saved.map((p) => p.MRC_REF), ["6373"], "the same bill coming back still updates");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].invoice_slug, "OLD");
    assert.match(result.skipped[0].reason, /already belongs to purchase 77/);
  });

  it("dry run saves nothing", async () => {
    const purchaseUsecase = { bulkCreatePurchase: async () => assert.fail("must not save") };
    const result = await syncFactory(spectra([row()]), purchaseUsecase, config).run({ dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.purchases.length, 1);
  });

  it("rejects a bad look-back and an unconfigured client", async () => {
    const s = syncFactory(spectra([]), {}, config);
    assert.equal((await s.run({ days: 365 })).code, 400);
    const u = syncFactory({ isConfigured: () => false }, {}, config);
    assert.equal((await u.run()).code, 400);
  });
});
