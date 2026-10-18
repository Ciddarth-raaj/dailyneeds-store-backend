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

  it("an unregistered supplier (blank GSTIN) is valid: zero tax raises nothing", () => {
    const nil = { PERC: 0, TAXABLE: 1000, VALUE: 0 };
    assert.deepEqual(codes(local({ supplier_gstn: "", sgst: [nil], cgst: [nil] })), []);
    assert.deepEqual(codes(local({ supplier_gstn: "0", sgst: [nil], cgst: [nil] })), []);
    assert.deepEqual(codes(local({ supplier_gstn: "", sgst: [], cgst: [] })), [], "nothing about the blank GSTIN itself");
  });

  it("Warehouse MRC 6392 (k.r.candles), unregistered, IGST 5% on the bill: Accounts must review the tax treatment", () => {
    const p = local({ supplier_gstn: "", sgst: [], cgst: [], igst: [{ PERC: 5, TAXABLE: 4271.49, VALUE: 213.57 }] });
    const list = purchaseDiscrepancies(p);
    assert.deepEqual(list.map((d) => `${d.code}:${d.severity}`), ["UNREGISTERED_SUPPLIER_TAX:block"]);
    assert.match(list[0].message, /Unregistered supplier \(no GSTIN\) with GST on the bill: IGST 5% on 4271\.49 \(213\.57\)/);
    assert.match(list[0].message, /if the supplier is registered, enter its GSTIN; if not, enter the bill without input tax/);
    assert.doesNotMatch(list[0].message, /invalid|missing GSTIN/i, "the blank GSTIN is not the finding");
  });

  it("an unregistered supplier with CGST/SGST: flagged too - exported as is it would claim input tax", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "" })), ["UNREGISTERED_SUPPLIER_TAX:block"]);
  });

  it("an unregistered supplier's IGST nil-rated line carries no tax: nothing flagged", () => {
    assert.deepEqual(
      codes(local({ supplier_gstn: "", sgst: [], cgst: [], igst: [{ PERC: 0, TAXABLE: 500, VALUE: 0 }] })),
      []
    );
  });

  it("Accounts' corrections clear it: the bill as nil-rated (no input tax), or the supplier's GSTIN if registered", () => {
    const igst = [{ PERC: 5, TAXABLE: 4271.49, VALUE: 213.57 }];
    const nil = [{ PERC: 0, TAXABLE: 4485, VALUE: 0 }];
    assert.deepEqual(codes(local({ supplier_gstn: "", igst: [], sgst: nil, cgst: nil })), [], "unregistered, tax as cost");
    assert.deepEqual(codes(local({ supplier_gstn: "33KRCAN0000K1Z5", sgst: [], cgst: [], igst })), [], "registered other-state");
  });

  it("a registered supplier: CGST/SGST versus IGST is never flagged - the bill stays as the supplier issued it", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "29CCCCC0000C1Z5" })), [], "CGST/SGST from another state");
    assert.deepEqual(codes(local({ igst: [{ PERC: 18, TAXABLE: 100, VALUE: 18 }] })), [], "IGST from a Puducherry GSTIN");
    assert.deepEqual(codes(local({ supplier_gstn: "33BBBBB0000B1Z5", sgst: [], cgst: [], igst: [{ PERC: 18, TAXABLE: 100, VALUE: 18 }] })), []);
  });

  it("bill 811 (ID Fresh Food, 33AAICM3930G1ZO): GoFrugal's 0% CGST/SGST lines beside the IGST - no warning", () => {
    const bill = {
      supplier_gstn: "33AAICM3930G1ZO",
      cgst: [{ PERC: 0, TAXABLE: 2911.22, VALUE: 0 }],
      sgst: [{ PERC: 0, TAXABLE: 2911.22, VALUE: 0 }],
      igst: [{ PERC: 0, TAXABLE: 2340.04, VALUE: 0 }, { PERC: 5, TAXABLE: 571.18, VALUE: 28.56 }],
      mmh_mrc_dt: "2026-10-10",
      mmh_dist_bill_dt: "2026-10-10",
    };
    assert.deepEqual(purchaseDiscrepancies(bill), []);
  });

  it("a malformed GSTIN is flagged for review, not blocked", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "34ABC" })), ["GSTIN_INVALID:review"]);
  });

  it("GoFrugal bills keep their old approval behaviour: the same findings, as review only", () => {
    const { asLegacy } = require("./purchase_discrepancy");
    const legacy = asLegacy(purchaseDiscrepancies(local({ supplier_gstn: "", igst: [{ PERC: 5, TAXABLE: 100, VALUE: 5 }], sgst: [], cgst: [] })));
    assert.deepEqual(legacy.map((d) => `${d.code}:${d.severity}`), ["UNREGISTERED_SUPPLIER_TAX:review"]);
    assert.equal(hasBlockingDiscrepancy(legacy), false);
  });

  it("an empty 0% line of the other kind is not tax", () => {
    assert.deepEqual(codes(local({ igst: [{ PERC: 0, TAXABLE: 0, VALUE: 0 }] })), []);
  });

  it("reads tax stored as JSON text", () => {
    assert.deepEqual(codes(local({ supplier_gstn: "", sgst: "[]", cgst: "[]", igst: '[{"PERC":5,"TAXABLE":100,"VALUE":5}]' })), ["UNREGISTERED_SUPPLIER_TAX:block"]);
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

  it("is the same file as the frontend's util/purchaseDiscrepancy.js", () => {
    const front = path.join(__dirname, "..", "..", "dailyneeds-store", "util", "purchaseDiscrepancy.js");
    if (!fs.existsSync(front)) return; // frontend not checked out next to the backend
    const code = (file) => fs.readFileSync(file, "utf8").replace(/^\/\*\*[\s\S]*?\*\//, "");
    assert.equal(code(front), code(path.join(__dirname, "purchase_discrepancy.js")));
  });
});
