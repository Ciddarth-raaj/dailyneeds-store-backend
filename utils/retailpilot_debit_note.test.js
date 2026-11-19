/**
 *   node --test utils/retailpilot_debit_note.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildDebitNoteQuery, mapDebitNotes } = require("./retailpilot_debit_note");
const syncFactory = require("../usecase/retailpilot_debit_note_sync");

const STORE_MAP = { "9rJMC": 2, sooWy: 5 };

// One rate group of a debit note, as the SPECTRA query returns it.
const row = (over = {}) => ({
  recon_slug: "REC-RL8HLA",
  seq: 1458,
  fy: 2026,
  status: "SUBMITTED",
  discrepancy_type: "QTY_MISMATCH",
  store_id: "9rJMC",
  supplier_id: "25423",
  supplier_name: "intelligent retail private limited",
  supplier_gstn: "34AAFCI1726B1Z5",
  invoice_seq: 6372,
  supplier_invoice_id: "PDY40369",
  created_at: "2026-11-03T12:10:00.000000+05:30",
  cgst_rate: 2.5,
  sgst_rate: 2.5,
  igst_rate: 0,
  cess_rate: 0,
  taxable: 4797.38,
  line_value: 5037.25,
  qty: 40,
  unrated_lines: 0,
  ...over,
});

describe("buildDebitNoteQuery", () => {
  it("reads only DEBIT_NOTE reconciliations in the look-back window", () => {
    const q = buildDebitNoteQuery(3);
    assert.match(q, /reconciliation_type = 'DEBIT_NOTE'/);
    assert.match(q, /r\.created_at >= CURRENT_DATE - 3/);
    assert.doesNotMatch(q, /INTERVAL/);
  });

  it("refuses anything but a non-negative integer", () => {
    for (const bad of [-1, 1.5, "3", null, undefined, NaN]) {
      assert.throws(() => buildDebitNoteQuery(bad));
    }
  });
});

describe("mapDebitNotes", () => {
  it("folds rate groups into one debit note with the GST split by slab", () => {
    const { debitNotes, skipped } = mapDebitNotes(
      [row(), row({ cgst_rate: 9, sgst_rate: 9, taxable: 6960.85, line_value: 8214.11, qty: 20 })],
      STORE_MAP
    );
    assert.deepEqual(skipped, []);
    assert.equal(debitNotes.length, 1);
    const d = debitNotes[0];
    assert.equal(d.STORE_ID, 2);
    assert.equal(d.MPRH_PR_NO, "REC-RL8HLA");
    assert.equal(d.MPRH_PR_REFNO, "1458");
    assert.equal(d.MPRH_PR_DT, "2026-11-03");
    assert.equal(d.MPRH_DIST_CODE, "25423");
    assert.deepEqual(d.CGST, [
      { PERC: 2.5, TAXABLE: 4797.38, VALUE: 119.93 },
      { PERC: 9, TAXABLE: 6960.85, VALUE: 626.48 },
    ]);
    assert.deepEqual(d.SGST, d.CGST);
    assert.deepEqual(d.IGST, []);
    assert.equal(d.TOT_CGST_AMT, 746.41);
    assert.equal(d.TOT_SGST_AMT, 746.41);
    assert.equal(d.TOT_ITEM_QTY, 60);
    assert.equal(d.TOT_ITEM_VALUE, 13251.36);
    assert.equal(d.PURCHASE_REF, "6372");
    assert.equal(typeof d.TS, "number");
  });

  it("puts an interstate supplier's tax in IGST", () => {
    const { debitNotes } = mapDebitNotes(
      [row({ supplier_gstn: "33AAACN2369L1ZD", cgst_rate: 0, sgst_rate: 0, igst_rate: 5, taxable: 1000 })],
      STORE_MAP
    );
    assert.deepEqual(debitNotes[0].IGST, [{ PERC: 5, TAXABLE: 1000, VALUE: 50 }]);
    assert.deepEqual(debitNotes[0].CGST, []);
  });

  it("keeps a stock return with no GSTIN, at 0%, and counts unrated lines", () => {
    const { debitNotes } = mapDebitNotes(
      [
        row({
          recon_slug: "REC-PW1GGX", seq: 52, store_id: "sooWy", supplier_gstn: null, invoice_seq: null,
          discrepancy_type: "STOCK_RETURN", cgst_rate: 0, sgst_rate: 0, taxable: 356.25, unrated_lines: 5,
        }),
      ],
      STORE_MAP
    );
    const d = debitNotes[0];
    assert.equal(d.SUPPLIER_GSTN, "");
    assert.deepEqual(d.CGST, [{ PERC: 0, TAXABLE: 356.25, VALUE: 0 }]);
    assert.equal(d.UNRATED_LINES, 5);
    assert.equal(d.PURCHASE_REF, "");
  });

  it("skips what cannot be imported, with the reason", () => {
    const { debitNotes, skipped } = mapDebitNotes(
      [
        row({ recon_slug: "REC-A", status: "DRAFT" }),
        row({ recon_slug: "REC-B", store_id: "nowhere" }),
        row({ recon_slug: "REC-C", seq: null }),
        row({ recon_slug: "REC-D", seq: 7 }),
        row({ recon_slug: "REC-E", seq: 7 }),
      ],
      STORE_MAP
    );
    assert.deepEqual(debitNotes.map((d) => d.MPRH_PR_NO), ["REC-D"]);
    assert.deepEqual(skipped.map((s) => s.recon_slug), ["REC-A", "REC-B", "REC-C", "REC-E"]);
    assert.match(skipped[0].reason, /status DRAFT/);
    assert.match(skipped[1].reason, /Branch Master/);
    assert.match(skipped[3].reason, /seq 7 is used by another debit note \(REC-D\)/);
  });

  it("allows the same number at two outlets", () => {
    const { debitNotes } = mapDebitNotes(
      [row({ recon_slug: "REC-0SSLW7", seq: 51 }), row({ recon_slug: "REC-SJNH78", seq: 51, store_id: "sooWy" })],
      STORE_MAP
    );
    assert.equal(debitNotes.length, 2);
  });

  it("changes TS exactly when the debit note changes", () => {
    const a = mapDebitNotes([row()], STORE_MAP).debitNotes[0].TS;
    assert.equal(mapDebitNotes([row()], STORE_MAP).debitNotes[0].TS, a);
    assert.notEqual(mapDebitNotes([row({ taxable: 4797.39 })], STORE_MAP).debitNotes[0].TS, a);
  });
});

describe("RetailPilotDebitNoteSync.run", () => {
  const spectra = (rows) => ({ isConfigured: () => true, queryAll: async () => rows });
  const config = { debitNoteLookbackDays: 3 };
  const repo = (decide, existing = []) => {
    const calls = { upsert: [], preview: [] };
    return {
      calls,
      findByOutletRefnos: async () => existing,
      upsertRetailPilotDebitNote: async (d) => (calls.upsert.push(d), decide(d)),
      previewRetailPilotDebitNote: async (d) => (calls.preview.push(d), decide(d)),
    };
  };

  it("saves each debit note and reports the counts", async () => {
    const r = repo((d) => ({ action: d.MPRH_PR_NO === "REC-1" ? "inserted" : "kept", debit_note_id: 9 }));
    const sync = syncFactory(spectra([row({ recon_slug: "REC-1", seq: 1 }), row({ recon_slug: "REC-2", seq: 2 })]), r, config, async () => STORE_MAP);
    const out = await sync.run();
    assert.equal(out.code, 200);
    assert.equal(out.days, 3);
    assert.equal(out.inserted, 1);
    assert.equal(out.kept_for_accounts, 1);
    assert.equal(r.calls.upsert.length, 2);
    assert.equal(out.payloads, undefined);
    assert.equal(sync.running, false);
  });

  it("writes nothing on a dry run", async () => {
    const r = repo(() => ({ action: "inserted" }));
    const out = await syncFactory(spectra([row()]), r, config, async () => STORE_MAP).run({ dryRun: true, days: 10 });
    assert.equal(out.dry_run, true);
    assert.equal(out.days, 10);
    assert.equal(r.calls.upsert.length, 0);
    assert.equal(r.calls.preview.length, 1);
    assert.equal(out.payloads.length, 1);
  });

  it("skips a number another debit note already has at the outlet that financial year", async () => {
    const r = repo(() => ({ action: "inserted" }), [
      { debit_note_id: 4, store_id: 2, mprh_pr_refno: "1458", mprh_pr_no: "77881", mprh_pr_dt: "2026-05-02" },
    ]);
    const out = await syncFactory(spectra([row()]), r, config, async () => STORE_MAP).run();
    assert.equal(out.row_count, 0);
    assert.match(out.skipped[0].reason, /already belongs to debit note 4/);
  });

  it("does not count the same RetailPilot debit note, or last year's number, as a clash", async () => {
    const r = repo(() => ({ action: "unchanged" }), [
      { debit_note_id: 5, store_id: 2, mprh_pr_refno: "1458", mprh_pr_no: "REC-RL8HLA", mprh_pr_dt: "2026-11-03" },
      { debit_note_id: 6, store_id: 2, mprh_pr_refno: "1458", mprh_pr_no: "55", mprh_pr_dt: "2026-02-10" },
    ]);
    const out = await syncFactory(spectra([row()]), r, config, async () => STORE_MAP).run();
    assert.equal(out.unchanged, 1);
    assert.deepEqual(out.skipped, []);
  });

  it("skips a debit note the database refuses as a duplicate and carries on", async () => {
    const r = repo((d) => {
      if (d.MPRH_PR_NO === "REC-1") throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY", sqlMessage: "Duplicate entry '3-51' for key 'sr'" });
      return { action: "inserted" };
    });
    const out = await syncFactory(spectra([row({ recon_slug: "REC-1", seq: 1 }), row({ recon_slug: "REC-2", seq: 2 })]), r, config, async () => STORE_MAP).run();
    assert.equal(out.code, 200);
    assert.equal(out.inserted, 1);
    assert.match(out.skipped[0].reason, /Duplicate entry '3-51'/);
    assert.match(out.warnings[0], /1 debit note\(s\) skipped/);
  });

  it("says so, with the table as the database has it, when saved debit notes cannot be found", async () => {
    const r = repo(() => ({ action: "inserted" }));
    r.countRetailPilotSlugs = async () => 1;
    r.describeForRetailPilot = async () => "columns: mprh_pr_no int(11)";
    const out = await syncFactory(spectra([row({ recon_slug: "REC-1", seq: 1 }), row({ recon_slug: "REC-2", seq: 2 })]), r, config, async () => STORE_MAP).run();
    assert.match(out.msg, /^2 read from RetailPilot - 2 new/);
    assert.match(out.msg, /Only 1 of 2 debit notes can be found in debit_note after saving - columns: mprh_pr_no int\(11\)/);
  });

  it("refuses to save when mprh_pr_no cannot hold the slug", async () => {
    const r = repo(() => ({ action: "inserted" }));
    r.prNoHoldsText = async () => false;
    r.describeForRetailPilot = async () => "columns: mprh_pr_no int(11)";
    const out = await syncFactory(spectra([row()]), r, config, async () => STORE_MAP).run();
    assert.equal(out.code, 500);
    assert.match(out.message, /nothing was saved/);
    assert.equal(r.calls.upsert.length, 0);
  });

  it("still fails the run on any other database error", async () => {
    const r = repo(() => { throw new Error("connection lost"); });
    await assert.rejects(syncFactory(spectra([row()]), r, config, async () => STORE_MAP).run(), /connection lost/);
  });

  it("warns about lines with no GST rate", async () => {
    const r = repo(() => ({ action: "inserted" }));
    const out = await syncFactory(spectra([row({ unrated_lines: 2 })]), r, config, async () => STORE_MAP).run();
    assert.match(out.warnings.join(" "), /REC-RL8HLA \(2 line\(s\)\)/);
  });

  it("refuses a bad look-back, a missing configuration, no branch map, or a second run", async () => {
    const r = repo(() => ({ action: "inserted" }));
    assert.equal((await syncFactory(spectra([]), r, config, async () => STORE_MAP).run({ days: 91 })).code, 400);
    assert.equal((await syncFactory({ isConfigured: () => false }, r, config, async () => STORE_MAP).run()).code, 400);
    assert.equal((await syncFactory(spectra([]), r, config, async () => ({})).run()).code, 400);
    const busy = syncFactory(spectra([]), r, config, async () => STORE_MAP);
    busy.running = true;
    assert.equal((await busy.run()).code, 409);
  });
});
