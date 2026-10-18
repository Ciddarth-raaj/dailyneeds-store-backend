/**
 *   node --test utils/purchase_discrepancy.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { purchaseDiscrepancies, hasBlockingDiscrepancy, dayOf, financialYearOf } = require("./purchase_discrepancy");

const local = (over = {}) => ({
  supplier_gstn: "34AAAAA0000A1Z5",
  sgst: [{ PERC: 2.5, TAXABLE: 1000, VALUE: 25 }],
  cgst: [{ PERC: 2.5, TAXABLE: 1000, VALUE: 25 }],
  igst: [],
  mmh_mrc_dt: "2026-10-16",
  mmh_dist_bill_dt: "2026-10-15",
  ...over,
});
const codes = (p) => purchaseDiscrepancies(p).map((d) => `${d.code}:${d.severity}`);

describe("purchase discrepancies", () => {
  it("a clean local bill and a clean other-state bill have none", () => {
    assert.deepEqual(codes(local()), []);
    assert.deepEqual(
      codes(local({ supplier_gstn: "33BBBBB0000B1Z5", sgst: [], cgst: [], igst: [{ PERC: 18, TAXABLE: 1000, VALUE: 180 }] })),
      []
    );
  });

  it("Warehouse MRC 6392 (k.r.candles): no GSTIN but IGST 5% - blocks approval, says why", () => {
    const p = local({ supplier_gstn: "", sgst: [], cgst: [], igst: [{ PERC: 5, TAXABLE: 4271.49, VALUE: 213.57 }] });
    const list = purchaseDiscrepancies(p);
    assert.deepEqual(list.map((d) => d.code), ["TAX_TYPE_MISMATCH"]);
    assert.equal(list[0].severity, "block");
    assert.match(list[0].message, /IGST 5% on 4271\.49 \(213\.57\)/);
    assert.match(list[0].message, /has no GSTIN/);
    assert.ok(hasBlockingDiscrepancy(list));
  });

  it("the correction clears it: a real other-state GSTIN, or the tax re-entered as local", () => {
    const igst = [{ PERC: 5, TAXABLE: 4271.49, VALUE: 213.57 }];
    assert.deepEqual(codes(local({ supplier_gstn: "33KRCAN0000K1Z5", sgst: [], cgst: [], igst })), []);
    assert.deepEqual(codes(local({ supplier_gstn: "", igst: [] })), []);
  });

  it("CGST/SGST from an other-state supplier blocks too", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "29CCCCC0000C1Z5" })), ["TAX_TYPE_MISMATCH:block"]);
  });

  it("an empty 0% line of the other kind is not tax", () => {
    assert.deepEqual(codes(local({ igst: [{ PERC: 0, TAXABLE: 0, VALUE: 0 }] })), []);
  });

  it("reads tax stored as JSON text", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "", sgst: "[]", cgst: "[]", igst: '[{"PERC":5,"TAXABLE":100,"VALUE":5}]' })), ["TAX_TYPE_MISMATCH:block"]);
  });

  it("DN1 bill 271 as RetailPilot holds it: both dates 16-01-2026, ref no 961 of the FY 2026-27 series - blocks", () => {
    const p = local({ mmh_mrc_refno: "961", mmh_mrc_dt: "2026-01-16", mmh_dist_bill_dt: "2026-01-16", voucher_fy: 2026, entered_at: "2026-10-16" });
    const list = purchaseDiscrepancies(p);
    assert.deepEqual(list.map((d) => `${d.code}:${d.severity}`), ["MRC_DATE_OUTSIDE_SERIES_FY:block"]);
    assert.match(list[0].message, /MRC date 2026-01-16 is in FY 2025-26, but MRC ref no 961 is numbered in the FY 2026-27 series \(entered 2026-10-16\)/);
    assert.deepEqual(codes({ ...p, mmh_mrc_dt: "2026-10-16" }), ["BILL_DATE_OTHER_FY:review"], "MRC date corrected");
    assert.deepEqual(codes({ ...p, mmh_mrc_dt: "2026-10-16", mmh_dist_bill_dt: "2026-10-15" }), [], "both corrected");
    assert.deepEqual(codes({ ...p, voucher_fy: null }), [], "a GoFrugal bill has no series year to check");
  });

  it("a supplier bill date in another financial year than the MRC date is flagged for review", () => {
    const list = purchaseDiscrepancies(local({ mmh_mrc_dt: "2026-10-16", mmh_dist_bill_dt: "2026-01-16" }));
    assert.deepEqual(list.map((d) => `${d.code}:${d.severity}`), ["BILL_DATE_OTHER_FY:review"]);
    assert.match(list[0].message, /2026-01-16 is in FY 2025-26, the MRC date 2026-10-16 in FY 2026-27/);
    assert.equal(hasBlockingDiscrepancy(list), false, "a date can be right; it does not block");
  });

  it("a bill dated after the MRC date is flagged; 31 March / 1 April is the year boundary", () => {
    assert.deepEqual(codes(local({ mmh_mrc_dt: "2026-10-16", mmh_dist_bill_dt: "2026-10-20" })), ["BILL_DATE_AFTER_MRC:review"]);
    assert.deepEqual(codes(local({ mmh_mrc_dt: "2026-04-01", mmh_dist_bill_dt: "2026-03-31" })), ["BILL_DATE_OTHER_FY:review"]);
    assert.deepEqual(codes(local({ mmh_mrc_dt: "2027-03-31", mmh_dist_bill_dt: "2026-04-01" })), []);
  });

  it("dates from the database (Date, or JSON timestamps of IST midnight) are read as their local day", () => {
    assert.equal(dayOf(new Date(2026, 3, 1)), "2026-04-01");
    assert.equal(dayOf("2026-04-01"), "2026-04-01");
    assert.equal(financialYearOf("2026-03-31"), 2025);
    assert.equal(financialYearOf("2026-04-01"), 2026);
  });

  it("a GSTIN that is not 15 characters is flagged for review", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "34ABC" })), ["GSTIN_INVALID:review"]);
  });

  it("is the same file as the frontend's util/purchaseDiscrepancy.js", () => {
    const front = path.join(__dirname, "..", "..", "dailyneeds-store", "util", "purchaseDiscrepancy.js");
    if (!fs.existsSync(front)) return; // frontend not checked out next to the backend
    const code = (file) => fs.readFileSync(file, "utf8").replace(/^\/\*\*[\s\S]*?\*\//, "");
    assert.equal(code(front), code(path.join(__dirname, "purchase_discrepancy.js")));
  });
});
