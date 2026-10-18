/**
 *   node --test utils/retailpilot_merge.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  sourceOf,
  buildSource,
  mergeRetailPilotUpdate,
  roundOffIsSyncs,
  keptFields,
} = require("./retailpilot_merge");

// A bill as RetailPilot sends it (lowercase purchase columns).
const rp = (over = {}) => ({
  supplier_id: "S1",
  supplier_name: "k.r.candles",
  supplier_gstn: "",
  mmh_mrc_dt: "2026-10-16",
  mmh_mrc_amt: 4485,
  mmh_dist_bill_dt: "2026-10-15",
  mmh_dist_bill_no: "B-1",
  mmh_manual_disc: 0,
  mmd_goods_tcs_amt: 0,
  tot_sgst_amt: 0,
  tot_cgst_amt: 0,
  tot_igst_amt: 213.57,
  tot_gst_cess_amt: 0,
  sgst: [],
  cgst: [],
  igst: [{ PERC: 5, TAXABLE: 4271.49, VALUE: 213.57 }],
  cess: [],
  ...over,
});

// The same bill as stored after the sync wrote it: DATE columns come back as
// Dates, decimals as strings, JSON as text.
const stored = (values, roundOff = { round_off: 0, total_amount: 4485 }, kept = []) => ({
  ...values,
  mmh_mrc_dt: new Date(`${values.mmh_mrc_dt}T00:00:00`),
  mmh_dist_bill_dt: new Date(`${values.mmh_dist_bill_dt}T00:00:00`),
  mmh_mrc_amt: String(Number(values.mmh_mrc_amt).toFixed(2)),
  sgst: JSON.stringify(values.sgst),
  cgst: JSON.stringify(values.cgst),
  igst: JSON.stringify(values.igst),
  cess: JSON.stringify(values.cess),
  retailpilot_source: buildSource(sourceOf(values), roundOff, kept),
});

// What the Purchase screen saves when Accounts correct the tax to local 5%.
const accountsLocalTax = {
  sgst: JSON.stringify([{ PERC: 2.5, TAXABLE: 4271.49, VALUE: "106.79" }]),
  cgst: JSON.stringify([{ PERC: 2.5, TAXABLE: 4271.49, VALUE: "106.79" }]),
  igst: "[]",
  cess: "[]",
  tot_sgst_amt: "106.79",
  tot_cgst_amt: "106.79",
  tot_igst_amt: "0.00",
};

describe("re-syncing a bill over Accounts' corrections", () => {
  it("the stored form of what the sync wrote compares equal to it (dates, decimals, JSON)", () => {
    assert.deepEqual(sourceOf(stored(rp())), sourceOf(rp()));
  });

  it("no correction: every RetailPilot change is taken", () => {
    const { changes, kept } = mergeRetailPilotUpdate(stored(rp()), rp({ mmh_mrc_amt: 4490, supplier_name: "K R Candles" }));
    assert.deepEqual(changes, { supplier_name: "K R Candles", mmh_mrc_amt: 4490 });
    assert.deepEqual(kept, []);
  });

  it("a corrected GSTIN is kept when RetailPilot sends the bill again, other changes still apply", () => {
    const row = { ...stored(rp()), supplier_gstn: "33KRCAN0000K1Z5" };
    const { changes, kept } = mergeRetailPilotUpdate(row, rp({ mmh_mrc_amt: 4490 }));
    assert.deepEqual(changes, { mmh_mrc_amt: 4490 }, "GSTIN not touched, amount updated");
    assert.deepEqual(kept, [], "RetailPilot did not change the GSTIN, so nothing to flag");
  });

  it("a corrected GSTIN is kept AND flagged when RetailPilot changes it too", () => {
    const row = { ...stored(rp()), supplier_gstn: "33KRCAN0000K1Z5" };
    const { changes, kept } = mergeRetailPilotUpdate(row, rp({ supplier_gstn: "33OTHER0000O1Z5" }));
    assert.deepEqual(changes, {});
    assert.deepEqual(kept, ["supplier_gstn"]);
  });

  it("corrected tax (the whole tax unit) is kept; RetailPilot's tax change is flagged", () => {
    const row = { ...stored(rp()), ...accountsLocalTax };
    const r1 = mergeRetailPilotUpdate(row, rp({ supplier_name: "K R Candles" }));
    assert.deepEqual(r1.changes, { supplier_name: "K R Candles" }, "tax left as Accounts entered it");
    const r2 = mergeRetailPilotUpdate(row, rp({ igst: [{ PERC: 5, TAXABLE: 4300, VALUE: 215 }], tot_igst_amt: 215 }));
    assert.deepEqual(r2.changes, {});
    assert.deepEqual(r2.kept, ["tax"]);
  });

  it("corrected invoice and MRC dates are kept (DN1 bill 271)", () => {
    const base = rp({ mmh_mrc_dt: "2026-10-16", mmh_dist_bill_dt: "2026-01-16" });
    const row = { ...stored(base), mmh_dist_bill_dt: new Date("2026-10-15T00:00:00") };
    const { changes, kept } = mergeRetailPilotUpdate(row, { ...base, mmh_mrc_amt: 600 });
    assert.deepEqual(changes, { mmh_mrc_amt: 600 });
    assert.deepEqual(kept, []);
  });

  it("a kept correction stays flagged on later runs until the two agree", () => {
    const row = { ...stored(rp({ supplier_gstn: "33OTHER0000O1Z5" }), undefined, ["supplier_gstn"]), supplier_gstn: "33KRCAN0000K1Z5" };
    assert.deepEqual(mergeRetailPilotUpdate(row, rp({ supplier_gstn: "33OTHER0000O1Z5", mmh_mrc_amt: 1 })).kept, ["supplier_gstn"]);
    assert.deepEqual(mergeRetailPilotUpdate(row, rp({ supplier_gstn: "33KRCAN0000K1Z5" })).kept, [], "RetailPilot fixed: flag clears");
  });

  it("without a snapshot nothing is known to be the sync's own: nothing is overwritten", () => {
    const row = { ...stored(rp()), retailpilot_source: null };
    const { changes, kept, hasSource } = mergeRetailPilotUpdate(row, rp({ mmh_mrc_amt: 9 }));
    assert.equal(hasSource, false);
    assert.deepEqual(changes, {});
    assert.deepEqual(kept, ["mmh_mrc_amt"]);
  });

  it("the pre-filled round-off is the sync's only while purchase_internal still holds exactly it", () => {
    const row = stored(rp(), { round_off: 0.4, total_amount: 4485 });
    assert.equal(roundOffIsSyncs({ round_off: "0.40", total_amount: "4485.00" }, row.retailpilot_source), true);
    assert.equal(roundOffIsSyncs({ round_off: "1.00", total_amount: "4485.00" }, row.retailpilot_source), false, "Accounts changed it");
    assert.equal(roundOffIsSyncs({ round_off: "0.40", total_amount: "4400.00" }, row.retailpilot_source), false, "Accounts saved other adjustments");
    assert.equal(roundOffIsSyncs({ round_off: 0, total_amount: 0 }, buildSource(sourceOf(rp()), null)), false, "once Accounts' always Accounts'");
  });

  it("keptFields reads the flag list back", () => {
    assert.deepEqual(keptFields(buildSource(sourceOf(rp()), null, ["tax"])), ["tax"]);
    assert.deepEqual(keptFields(null), []);
    assert.deepEqual(keptFields("not json"), []);
  });
});
