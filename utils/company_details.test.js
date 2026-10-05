/**
 * MASTER → COMPANY DETAILS - what may be written to `company_details`.
 *
 *   node --test utils/company_details.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateCompanyDetails, presentCompany, FIELDS } = require("./company_details");

const VALID = {
  company_name: "Daily Needs Departmental Store",
  reg_address: "188/1 Iyyanar Koil Street\nMuthirapalayam, Puducherry 605009",
  contact_number: "+91 413 222 3344",
  gst_number: "34aabcd1234e1z5",
  pan_number: "aabcd1234e",
  tan_number: "chea12345b",
  pf_number: "tn/mas/0012345",
  esi_number: "51000123450001001",
  payslip_active: true,
};
const fieldsOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.name, "ValidationError");
    return e.errors.map((x) => x.field);
  }
  assert.fail("expected a ValidationError");
};

describe("validating Company Details", () => {
  it("accepts a full record, normalising case and whitespace", () => {
    const { values, payslip_active } = validateCompanyDetails({ ...VALID, company_name: "  Daily   Needs  " });
    assert.equal(payslip_active, true);
    assert.equal(values.company_name, "Daily Needs");
    assert.equal(values.gst_number, "34AABCD1234E1Z5");
    assert.equal(values.pan_number, "AABCD1234E");
    assert.equal(values.tan_number, "CHEA12345B");
    assert.equal(values.pf_number, "TN/MAS/0012345");
    assert.equal(values.reg_address, "188/1 Iyyanar Koil Street\nMuthirapalayam, Puducherry 605009");
  });

  it("requires Company Name and Address, and only those", () => {
    assert.deepEqual(fieldsOf(() => validateCompanyDetails({})), ["company_name", "reg_address"]);
    const { values, payslip_active } = validateCompanyDetails({ company_name: "X", reg_address: "Y" });
    assert.equal(payslip_active, false);
    // The optional columns are NOT NULL in the table, so absent is ''.
    for (const k of ["contact_number", "gst_number", "pan_number", "tan_number", "pf_number", "esi_number"]) {
      assert.equal(values[k], "");
    }
  });

  it("PF / ESI establishment codes are optional on the record (required per payslip only where they apply)", () => {
    const { values } = validateCompanyDetails({ ...VALID, pf_number: "", esi_number: "" });
    assert.deepEqual([values.pf_number, values.esi_number], ["", ""]);
  });

  it("enforces the column lengths", () => {
    assert.deepEqual(fieldsOf(() => validateCompanyDetails({ ...VALID, company_name: "x".repeat(46) })), ["company_name"]);
    assert.deepEqual(fieldsOf(() => validateCompanyDetails({ ...VALID, reg_address: "x".repeat(501) })), ["reg_address"]);
    assert.deepEqual(fieldsOf(() => validateCompanyDetails({ ...VALID, pf_number: `TN/${"1".repeat(50)}` })), ["pf_number"]);
    for (const f of FIELDS) assert.ok((f.max || 45) <= (f.key === "reg_address" ? 500 : 45), f.key);
  });

  it("checks formats", () => {
    assert.deepEqual(
      fieldsOf(() =>
        validateCompanyDetails({
          ...VALID, contact_number: "call me", gst_number: "123", pan_number: "ABC", tan_number: "1234", pf_number: "!!", esi_number: "ESI-1",
        })
      ),
      ["contact_number", "gst_number", "pan_number", "tan_number", "pf_number", "esi_number"]
    );
  });

  it("only a real true marks it Active for Payslip", () => {
    for (const v of [true, 1, "1", "true"]) assert.equal(validateCompanyDetails({ ...VALID, payslip_active: v }).payslip_active, true);
    for (const v of [false, 0, "0", "", undefined, "yes"]) assert.equal(validateCompanyDetails({ ...VALID, payslip_active: v }).payslip_active, false);
  });

  it("presents a row with Active for Payslip from `status` and no logo payload", () => {
    const out = presentCompany({ company_id: "3", company_name: "X", reg_address: "Y", logo: "data:image/png;base64,AAAA", status: 1 });
    assert.equal(out.company_id, 3);
    assert.equal(out.payslip_active, true);
    assert.equal(out.has_logo, true);
    assert.equal(out.logo, undefined);
    assert.equal(presentCompany({ company_id: 4, status: 0 }).payslip_active, false);
  });
});
