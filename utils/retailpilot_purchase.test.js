/**
 *   node --test utils/retailpilot_purchase.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildPurchaseQuery, mapPurchases, contentTs, roundOffFor } = require("./retailpilot_purchase");
const RP = require("./retailpilot_purchase");
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

  it("reads the seq's financial year and the entry time, and groups by them", () => {
    const sql = buildPurchaseQuery(3);
    assert.match(sql, /h\.fy\s+AS fy,/);
    assert.match(sql, /h\.created_at\s+AS entered_at,/);
    assert.match(sql, /GROUP BY h\.slug, h\.invoice_id, h\.seq, h\.fy, h\.created_at,/);
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
    assert.equal(p.MRC_NO, "INV-1001", "the MRC no is the RetailPilot invoice slug");
    assert.equal(p.MRC_DATE, "2026-10-15");
    assert.equal(p.DIST_BILL_DT, "2026-10-14");
    assert.equal(p.DIST_BILL_NO, "B-1");
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

  it("refuses a slug longer than the MRC no column", () => {
    const { skipped } = mapPurchases([row({ invoice_slug: "x".repeat(51) })], STORE_MAP);
    assert.match(skipped[0].reason, /MRC_NO .* is longer than 50/);
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
    assert.match(skipped[0].reason, /not set as the RetailPilot ID of any branch/);
    assert.match(skipped[1].reason, /DIST_BILL_NO/);
    assert.match(skipped[2].reason, /date/);
    assert.match(skipped[3].reason, /no seq/);
  });

  it("takes the reference from seq and the MRC no from the slug, and refuses a seq used twice in a store", () => {
    const one = mapPurchases([row({ invoice_slug: "INV-0EevA9mzmHYx", mrc_no: "6400" })], STORE_MAP).purchases[0];
    assert.equal(one.MRC_REF, "6400", "seq is the reference / Tally voucher number");
    assert.equal(one.MRC_NO, "INV-0EevA9mzmHYx", "the slug is the MRC no");
    assert.ok(!("RP_INVOICE_SLUG" in one));
    const { purchases, skipped } = mapPurchases(
      [row({ invoice_slug: "P" }), row({ invoice_slug: "Q" })],
      STORE_MAP
    );
    assert.equal(purchases.length, 1);
    assert.match(skipped[0].reason, /seq 6372 is used by another invoice \(P\)/);
  });

  it("carries the seq's financial year and the entry day on the bill", () => {
    const p = mapPurchases([row({ fy: 2026, entered_at: "2026-10-16T16:09:20.413334+05:30" })], STORE_MAP).purchases[0];
    assert.equal(p.FY, 2026);
    assert.equal(p.ENTERED_AT, "2026-10-16");
    assert.equal(mapPurchases([row({ fy: null })], STORE_MAP).purchases[0].FY, null);
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

describe("round-off, as the Purchase screen adds it up", () => {
  it("a local bill: the live dinesh agency bill rounds off by -0.20 to Rs 4544", () => {
    const p = mapPurchases(
      [
        row({ supplier_gstn: "34AHVPV0618F1Z2", invoice_amount: 4544, taxable: 3884.26 }),
        row({ supplier_gstn: "34AHVPV0618F1Z2", invoice_amount: 4544, cgst_rate: 9, sgst_rate: 9, taxable: 394.68 }),
      ],
      STORE_MAP
    ).purchases[0];
    assert.deepEqual(roundOffFor(p), { round_off: -0.2, total_amount: 4544 });
    assert.equal(p.ROUND_OFF, -0.2, "carried on the mapped bill for the dry run");
  });

  it("an other-state bill counts IGST, and TCS", () => {
    const p = mapPurchases(
      [row({ supplier_gstn: "29BBBBB0000B1Z5", cgst_rate: 0, sgst_rate: 0, igst_rate: 18, taxable: 1000, tcs: 1.18, invoice_amount: 1182 })],
      STORE_MAP
    ).purchases[0];
    // 1000 + 180 + 1.18 = 1181.18 -> round-off 0.82
    assert.deepEqual(roundOffFor(p), { round_off: 0.82, total_amount: 1182 });
  });

  it("IGST on a supplier with no GSTIN: the whole difference is still pre-filled (approval is blocked elsewhere)", () => {
    // the live k.r.candles bill: no GSTIN, IGST 5% - the screen shows CGST/SGST only
    const p = mapPurchases(
      [row({ supplier_gstn: "", cgst_rate: 0, sgst_rate: 0, igst_rate: 5, taxable: 4271.49, invoice_amount: 4485 })],
      STORE_MAP
    ).purchases[0];
    assert.deepEqual(roundOffFor(p), { round_off: 4485, total_amount: 4485 }, "the screen would see no tax at all");
    assert.equal(p.ROUND_OFF, 4485);
    assert.ok(!("ROUND_OFF_PREFILL" in p) && !("ROUND_OFF_NOTE" in p), "no pre-fill gate on the bill");
  });

  it("no Rs 10 limit: small, large, positive, negative and zero differences are all the full difference", () => {
    const ro = (amount) => mapPurchases([row({ invoice_amount: amount, taxable: 1000 })], STORE_MAP).purchases[0].ROUND_OFF;
    // taxable 1000 at 5% local = 1050
    assert.equal(ro(1050.4), 0.4, "small positive");
    assert.equal(ro(1049.75), -0.25, "small negative");
    assert.equal(ro(1060.01), 10.01, "just over Rs 10");
    assert.equal(ro(1059.99), 9.99, "just under Rs 10");
    assert.equal(ro(2050), 1000, "large positive");
    assert.equal(ro(1050 - 300.2), -300.2, "large negative");
    assert.equal(ro(1050), 0, "zero");
    assert.ok(!("ROUND_OFF_PREFILL_LIMIT" in RP) && !("roundOffPrefillCheck" in RP), "the limit and its check are gone");
    const src = require("fs").readFileSync(require("path").join(__dirname, "retailpilot_purchase.js"), "utf8");
    assert.doesNotMatch(src, /LIMIT\s*=\s*10|> ?10\b|Math\.abs\(round/, "no amount threshold left in the mapping");
  });

  it("the total it gives is the bill amount, as the screen would save it, also with a discount on purchase", () => {
    const r = RP.roundOffForRow({
      supplier_gstn: "34AAAAA0000A1Z5", sgst: [{ PERC: 2.5, TAXABLE: 1000, VALUE: 25 }], igst: [],
      tot_sgst_amt: 25, tot_cgst_amt: 25, tot_igst_amt: 0, mmd_goods_tcs_amt: 0, mmh_manual_disc: 10, mmh_mrc_amt: 1040,
    });
    assert.deepEqual(r, { round_off: 0, total_amount: 1040 });
  });

  it("nothing to round when the bill already adds up", () => {
    const p = mapPurchases([row({ invoice_amount: 1050, taxable: 1000 })], STORE_MAP).purchases[0];
    assert.equal(roundOffFor(p).round_off, 0);
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
  const config = { purchaseLookbackDays: 3 };
  const branchMaster = async () => STORE_MAP;

  // A purchase usecase that records what the sync saved.
  const recorder = (actions = {}) => {
    const saved = [];
    return {
      saved,
      upsertRetailPilotPurchase: async (p) => {
        saved.push(p);
        const a = actions[p.MRC_NO] || { action: "inserted", purchase_id: saved.length, kept: [] };
        return a;
      },
    };
  };

  it("saves each bill through upsertRetailPilotPurchase and reports counts and skips", async () => {
    const uc = recorder();
    const result = await syncFactory(
      spectra([row({ invoice_amount: 1050 }), row({ invoice_slug: "Z", store_id: "nope", mrc_no: 9 })]),
      uc,
      config, branchMaster
    ).run();
    assert.equal(uc.saved.length, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.warnings.length, 1);
  });

  it("counts inserted, updated, unchanged and approved bills, and lists Accounts' corrections it kept", async () => {
    const uc = recorder({
      A: { action: "inserted", purchase_id: 1, kept: [] },
      B: { action: "updated", purchase_id: 2, kept: ["supplier_gstn"] },
      C: { action: "unchanged", purchase_id: 3, kept: [] },
      D: { action: "approved", purchase_id: 4, kept: [] },
    });
    const result = await syncFactory(
      spectra(["A", "B", "C", "D"].map((slug, i) => row({ invoice_slug: slug, mrc_no: 6372 + i }))),
      uc, config, branchMaster
    ).run();
    assert.deepEqual(
      [result.inserted, result.updated, result.unchanged, result.approved_untouched],
      [1, 1, 1, 1]
    );
    assert.deepEqual(result.corrections_kept, [{ invoice_slug: "B", mrc_ref: "6373", outlet: 2, purchase_id: 2, fields: ["supplier_gstn"] }]);
    assert.deepEqual(result.warnings, [], "kept corrections are Accounts' work, not a failed sync");
  });

  it("skips a seq whose reference another bill holds at the outlet in the same financial year", async () => {
    // row() is dated 2026-10-15, i.e. financial year 2026-27.
    const existing = [
      // a GoFrugal bill already holding 6372 this year - a real clash
      { purchase_id: 77, retail_outlet_id: 2, mmh_mrc_refno: "6372", mmh_mrc_no: "118000", mmh_mrc_dt: "2026-09-30", supplier_gstn: "33OTHER", mmh_dist_bill_no: "OLD-9" },
      // the same RetailPilot bill saved earlier - not a clash
      { purchase_id: 78, retail_outlet_id: 2, mmh_mrc_refno: "6373", mmh_mrc_no: "SAME", mmh_mrc_dt: new Date(2026, 9, 15), supplier_gstn: "34AAAAA0000A1Z5", mmh_dist_bill_no: "B-2" },
    ];
    const uc = recorder();
    uc.findByOutletRefnos = async (keys) => {
      assert.deepEqual(keys, [
        [2, "6372", "2026-04-01", "2027-03-31"],
        [2, "6373", "2026-04-01", "2027-03-31"],
        [2, "6374", "2026-04-01", "2027-03-31"],
      ]);
      return existing;
    };
    const result = await syncFactory(
      spectra([
        row({ invoice_slug: "OLD" }),
        row({ invoice_slug: "SAME", mrc_no: 6373 }),
        row({ invoice_slug: "NEW", mrc_no: 6374 }),
      ]),
      uc,
      config, branchMaster
    ).run();
    assert.deepEqual(uc.saved.map((p) => p.MRC_REF), ["6373", "6374"]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].invoice_slug, "OLD");
    assert.match(result.skipped[0].reason, /already belongs to purchase 77 at this outlet in the same financial year/);
    assert.doesNotMatch(result.warnings.join(" "), /33OTHER|GSTIN/, "no supplier GSTIN in what the API Sync Log keeps");
  });

  it("a bill dated in last year by mistake is checked against its seq's year, not its date's", async () => {
    // DN1 bill 271: both dates 16-01-2026, seq 961 of the FY 2026-27 series.
    let keys;
    const uc = recorder();
    uc.findByOutletRefnos = async (k) => { keys = k; return []; };
    const result = await syncFactory(
      // the query has already put invoice_date in received_date (COALESCE)
      spectra([row({ invoice_slug: "INV-ouL0uNb0VjxP", mrc_no: 961, received_date: "2026-01-16", invoice_date: "2026-01-16", fy: 2026, entered_at: "2026-10-16T16:09:20+05:30" })]),
      uc, config, branchMaster
    ).run();
    assert.deepEqual(keys, [[2, "961", "2026-04-01", "2027-03-31"]]);
    assert.equal(uc.saved.length, 1, "imported, not skipped against FY 2025-26's 961");
    assert.deepEqual(result.discrepancies.map((d) => `${d.code}:${d.severity}`), ["MRC_DATE_OUTSIDE_SERIES_FY:block"]);
  });

  it("the same number in an earlier financial year is not a clash", async () => {
    const uc = recorder();
    // the repository filters by year; it returns nothing for 2026-27
    uc.findByOutletRefnos = async () => [];
    await syncFactory(spectra([row({ invoice_slug: "NEW" })]), uc, config, branchMaster).run();
    assert.deepEqual(uc.saved.map((p) => p.MRC_REF), ["6372"]);
  });

  it("reports discrepancies for Accounts without failing the run, whatever the round-off", async () => {
    const uc = recorder();
    const result = await syncFactory(
      spectra([
        row({ invoice_slug: "BIG", invoice_amount: 2000, taxable: 1000 }),
        row({ invoice_slug: "KRC", mrc_no: 6373, supplier_gstn: "", cgst_rate: 0, sgst_rate: 0, igst_rate: 5, taxable: 4271.49, invoice_amount: 4485 }),
        row({ invoice_slug: "OLDBILL", mrc_no: 6374, invoice_date: "2026-01-16" }),
      ]),
      uc, config, branchMaster
    ).run();
    assert.equal(uc.saved.length, 3, "every bill is imported, the large difference and the discrepancies included");
    assert.deepEqual(
      result.discrepancies.map((d) => [d.invoice_slug, d.code, d.severity]),
      [["KRC", "UNREGISTERED_SUPPLIER_TAX", "block"], ["OLDBILL", "BILL_DATE_OTHER_FY", "review"]]
    );
    assert.deepEqual(result.warnings, []);
  });

  it("dry run saves nothing", async () => {
    const uc = { upsertRetailPilotPurchase: async () => assert.fail("must not save") };
    const result = await syncFactory(spectra([row()]), uc, config, branchMaster).run({ dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.purchases.length, 1);
    assert.equal(result.purchases[0].ROUND_OFF, 590, "the full difference is shown: 1640 - 1050");
  });

  it("one sync at a time: a second run while one is going is refused", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const uc = { upsertRetailPilotPurchase: async () => { await gate; return { action: "inserted", kept: [] }; } };
    const s = syncFactory(spectra([row()]), uc, config, branchMaster);
    const first = s.run();
    await new Promise((r) => setImmediate(r));
    const second = await s.run();
    assert.equal(second.code, 409);
    release();
    assert.equal((await first).code, 200);
    assert.equal((await s.run()).code, 200, "free again once the first finished");
  });

  it("a failed save stops the run, is thrown for the log, and frees the lock", async () => {
    const uc = { upsertRetailPilotPurchase: async () => { throw new Error("db down"); } };
    const s = syncFactory(spectra([row()]), uc, config, branchMaster);
    await assert.rejects(s.run(), /db down/);
    assert.equal(s.running, false);
  });

  it("reads the store map from Branch Master on every run", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls === 1 ? STORE_MAP : {};
    };
    const s = syncFactory(spectra([row()]), recorder(), config, loader);
    assert.equal((await s.run({ dryRun: true })).purchases.length, 1);
    const second = await s.run({ dryRun: true });
    assert.equal(second.code, 400, "an emptied Branch Master stops the sync instead of guessing");
    assert.match(second.message, /Branch Master/);
    assert.equal(calls, 2);
  });

  it("a store missing from Branch Master is skipped, never put on another outlet", async () => {
    const uc = recorder();
    const result = await syncFactory(
      spectra([row(), row({ invoice_slug: "NEW", store_id: "zzNew", mrc_no: 9 })]),
      uc,
      config,
      async () => ({ "store-a": 2 })
    ).run();
    assert.deepEqual(uc.saved.map((p) => p.STORE_ID), [2]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /RetailPilot store zzNew is not set as the RetailPilot ID of any branch in Branch Master/);
  });

  it("maps through the real outlet usecase, so Branch Master is the only source", async () => {
    const outletUsecase = require("../usecase/outlet")(
      {
        getRetailPilotIds: async () => [
          { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "store-a" },
          { outlet_id: 9, outlet_name: "No ID", retailpilot_id: null },
        ],
      },
      {}
    );
    const result = await syncFactory(
      spectra([row(), row({ invoice_slug: "OTHER", store_id: "store-z", mrc_no: 7 })]),
      {},
      config,
      () => outletUsecase.getRetailPilotStoreMap()
    ).run({ dryRun: true });
    assert.deepEqual(result.purchases.map((p) => p.STORE_ID), [2]);
    assert.match(result.skipped[0].reason, /RetailPilot store store-z is not set as the RetailPilot ID of any branch in Branch Master/);
  });

  it("a RetailPilot ID on two branches stops the sync instead of picking one", async () => {
    const outletUsecase = require("../usecase/outlet")(
      {
        getRetailPilotIds: async () => [
          { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "store-a" },
          { outlet_id: 3, outlet_name: "Copy", retailpilot_id: "store-a" },
        ],
      },
      {}
    );
    await assert.rejects(
      syncFactory(spectra([row()]), {}, config, () => outletUsecase.getRetailPilotStoreMap()).run({ dryRun: true }),
      (err) => err.code === "RETAILPILOT_BRANCH_MAP_DUPLICATE"
    );
  });

  it("is scheduled three times a day - 9:00, 14:00 and 17:00 IST - and only when enabled", () => {
    const fs = require("fs");
    const path = require("path");
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const at = server.indexOf('"retailpilot_purchase_sync",');
    assert.ok(at > 0);
    assert.match(server.slice(at, at + 80), /"retailpilot_purchase_sync",\s*"0 9,14,17 \* \* \*"/);
    assert.match(server.slice(at, at + 600), /\{ preventOverlap: true \}/, "a run still going at the next tick is skipped");
    assert.match(server.slice(at - 700, at), /if \(require\("\.\/config\/retailpilot"\)\.purchaseSyncEnabled\)/);
    const cron = fs.readFileSync(path.join(__dirname, "..", "services", "cron_service.js"), "utf8");
    assert.match(cron, /const CRON_TIMEZONE = "Asia\/Kolkata";/, "the hours are IST");
  });

  it("the config carries no store map of its own", () => {
    const cfg = require("../config/retailpilot");
    assert.ok(!("storeMapOverride" in cfg) && !("storeMap" in cfg) && !("parseStoreMap" in cfg));
  });

  it("rejects a bad look-back and an unconfigured client", async () => {
    const s = syncFactory(spectra([]), {}, config, branchMaster);
    assert.equal((await s.run({ days: 365 })).code, 400);
    const u = syncFactory({ isConfigured: () => false }, {}, config, branchMaster);
    assert.equal((await u.run()).code, 400);
  });
});
