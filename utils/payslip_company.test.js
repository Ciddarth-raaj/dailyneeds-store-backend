/**
 * WHICH COMPANY ISSUES A PAYSLIP.
 *
 *   node --test utils/payslip_company.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolvePayslipCompany, payslipCompanyStatus } = require("./payslip_company");

const ROW = (over = {}) => ({
  company_id: 1, company_name: "Daily Needs Departmental Store", reg_address: "188/1 Iyyanar Koil Street",
  pf_number: "TN/MAS/0012345", esi_number: "51000123450001001", status: 1, ...over,
});

describe("the payslip issuer comes from Company Details", () => {
  it("the one active record, with its PF / ESI establishment codes and where it came from", () => {
    assert.deepEqual(resolvePayslipCompany([ROW(), ROW({ company_id: 2, status: 0 })]), {
      name: "Daily Needs Departmental Store", address: "188/1 Iyyanar Koil Street",
      pf_establishment_code: "TN/MAS/0012345", esi_establishment_code: "51000123450001001", source: "company_details:1",
    });
  });

  it("several active records are refused unless PAYSLIP_COMPANY_ID chooses one", () => {
    const rows = [ROW(), ROW({ company_id: 2, company_name: "Other" })];
    assert.throws(() => resolvePayslipCompany(rows), (e) => e.code === "PAYSLIP_COMPANY_NOT_CONFIGURED");
    assert.equal(resolvePayslipCompany(rows, { PAYSLIP_COMPANY_ID: "2" }).name, "Other");
  });

  it("PAYSLIP_COMPANY_ID naming an inactive or missing record is refused", () => {
    assert.throws(() => resolvePayslipCompany([ROW({ status: 0 })], { PAYSLIP_COMPANY_ID: "1" }), /does not name an active company/);
    assert.throws(() => resolvePayslipCompany([ROW()], { PAYSLIP_COMPANY_ID: "9" }), /does not name an active company/);
  });

  it("no hardcoded fallback: no record and no configured name is a refusal", () => {
    assert.throws(() => resolvePayslipCompany([]), (e) => e.name === "ValidationError" && /Company Details/.test(e.message));
  });

  it("PAYSLIP_COMPANY_NAME / _ADDRESS override only when somebody set them", () => {
    const r = resolvePayslipCompany([ROW()], { PAYSLIP_COMPANY_NAME: "DNDS Pvt Ltd", PAYSLIP_COMPANY_ADDRESS: "Pondicherry" });
    assert.deepEqual([r.name, r.address, r.pf_establishment_code, r.source], ["DNDS Pvt Ltd", "Pondicherry", "TN/MAS/0012345", "company_details:1"]);
    const envOnly = resolvePayslipCompany([], { PAYSLIP_COMPANY_NAME: "DNDS Pvt Ltd" });
    assert.deepEqual([envOnly.name, envOnly.source, envOnly.pf_establishment_code], ["DNDS Pvt Ltd", "env", null]);
    assert.equal(resolvePayslipCompany([ROW()], { PAYSLIP_COMPANY_NAME: "  " }).name, "Daily Needs Departmental Store");
  });
});

describe("the Payroll screen's payslip company status - the same decision as Publish", () => {
  it("no record, or none active: not configured, with the screen's message", () => {
    for (const rows of [[], [ROW({ status: 0 })], [ROW({ company_name: "  " })]]) {
      const s = payslipCompanyStatus(rows);
      assert.equal(s.configured, false);
      assert.equal(s.reason, "NONE");
      assert.equal(s.message, "Payslip publishing is unavailable until Company Details is configured.");
      assert.equal(s.company, null);
    }
  });

  it("several active: not configured until one is chosen", () => {
    const s = payslipCompanyStatus([ROW(), ROW({ company_id: 2 })]);
    assert.deepEqual([s.configured, s.reason, s.active_count], [false, "MULTIPLE", 2]);
  });

  it("exactly one active: configured, naming it and nothing sensitive", () => {
    const s = payslipCompanyStatus([ROW(), ROW({ company_id: 2, status: 0 })]);
    assert.equal(s.configured, true);
    assert.deepEqual(s.company, {
      company_id: 1, name: "Daily Needs Departmental Store",
      has_pf_establishment_code: true, has_esi_establishment_code: true, source: "company_details",
    });
    assert.ok(!JSON.stringify(s).includes("TN/MAS/0012345"));
  });

  it("the env override stays an emergency override and is reported as such", () => {
    const s = payslipCompanyStatus([], { PAYSLIP_COMPANY_NAME: "Override" });
    assert.deepEqual([s.configured, s.company.source, s.company.company_id], [true, "env", null]);
  });
});
