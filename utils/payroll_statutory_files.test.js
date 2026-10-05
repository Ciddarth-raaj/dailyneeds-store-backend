/**
 * Payroll Reports - ECR and ESIC contribution file validation, pure.
 *
 *   node --test utils/payroll_statutory_files.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const S = require("./payroll_statutory_files");
const { buildEcr } = require("./epfo_ecr");
const { periodOf } = require("./payroll_report_query");

const SEPT = periodOf(2026, 9);

const pfCalc = (over = {}) => ({
  employee_id: 1,
  status: "APPROVED_LOCKED",
  is_complete: 1,
  pf_status: "APPLIED",
  total_earnings: "16000.00",
  pf_wage: "15000.00",
  eps_wage: "15000.00",
  edli_wage: "15000.00",
  employee_pf: "1800.00",
  employer_eps: "1250.00",
  employer_epf: "550.00",
  ncp_days: 2,
  ...over,
});
const emp = (id, over = {}) => ({ employee_id: id, employee_name: `Employee ${id}`, uan: "100200300400", pf_applicable: 1, ...over });

describe("EPF / ECR validation", () => {
  it("ready + blocked = considered, and blocked employees carry their reasons", () => {
    const v = S.validateEpf({
      period: SEPT,
      rows: [
        { employee: emp(1), calculation: pfCalc() },
        { employee: emp(2, { uan: "" }), calculation: pfCalc({ employee_id: 2 }) },
        { employee: emp(3, { uan: "12345" }), calculation: pfCalc({ employee_id: 3 }) },
        { employee: emp(4), calculation: pfCalc({ employee_id: 4, pf_status: "PENDING" }) },
        { employee: emp(5), calculation: pfCalc({ employee_id: 5, ncp_days: null }) },
        { employee: emp(6), calculation: pfCalc({ employee_id: 6, employee_pf: "999.00" }) },
        { employee: emp(7), calculation: pfCalc({ employee_id: 7, status: "CALCULATED" }) },
        { employee: emp(8), calculation: pfCalc({ employee_id: 8, pf_status: "NOT_APPLICABLE" }) },
        { employee: emp(9), calculation: null },
      ],
    });
    assert.equal(v.summary.considered, 8, "a NOT_APPLICABLE month is not a member");
    assert.equal(v.summary.ready + v.summary.blocked, v.summary.considered);
    assert.equal(v.summary.ready, 1);
    const codes = Object.fromEntries(v.blocked.map((b) => [b.employee_id, b.reasons.map((r) => r.code)]));
    assert.deepEqual(codes[2], ["UAN_MISSING"]);
    assert.deepEqual(codes[3], ["UAN_INVALID"]);
    assert.ok(codes[4].includes("PF_PENDING"));
    assert.ok(codes[5].includes("NCP_MISSING"), "an unstored NCP is never filed as 0");
    assert.ok(codes[6].includes("CONTRIBUTION_MISMATCH"));
    assert.ok(codes[7].includes("NOT_APPROVED"));
    assert.ok(codes[9].includes("NOT_CALCULATED"));
  });

  it("the file holds the ready members only, in the payrun's own ECR line format", () => {
    const rows = [{ employee: emp(1), calculation: pfCalc() }, { employee: emp(2, { uan: "" }), calculation: pfCalc({ employee_id: 2 }) }];
    const v = S.validateEpf({ period: SEPT, rows });
    const expected = buildEcr({ rows: [rows[0]] }).lines;
    assert.deepEqual(v.lines, expected);
    assert.equal(v.text.split("\n").length, 1);
    assert.equal(v.lines[0].split("#~#").length, 11, "ECR 2.0 has eleven fields");
  });

  it("the current UAN is used only when the payrun snapshot has none", () => {
    const v = S.validateEpf({ period: SEPT, rows: [{ employee: emp(1, { uan: null }), calculation: pfCalc(), live_uan: "999888777666" }] });
    assert.ok(v.text.startsWith("999888777666#~#"));
  });
});

const esiCalc = (over = {}) => ({
  employee_id: 1,
  status: "APPROVED_LOCKED",
  is_complete: 1,
  esi_status: "APPLIED",
  salary_days: 26,
  esi_wage: "15000.00",
  employee_esi: "113.00",
  employer_esi: "488.00",
  ...over,
});
const esiEmp = (id, over = {}) => ({ employee_id: id, employee_name: `Employee-${id} (A.)`, esi_number: "1234567890", esi_applicable: 1, ...over });

describe("ESI / ESIC contribution file validation", () => {
  it("blocks missing / invalid IP numbers, invalid days and wages, and zero days without a reason", () => {
    const v = S.validateEsi({
      period: SEPT,
      rows: [
        { employee: esiEmp(1), calculation: esiCalc() },
        { employee: esiEmp(2, { esi_number: "" }), calculation: esiCalc({ employee_id: 2 }) },
        { employee: esiEmp(3, { esi_number: "12AB" }), calculation: esiCalc({ employee_id: 3 }) },
        { employee: esiEmp(4), calculation: esiCalc({ employee_id: 4, salary_days: 40 }) },
        { employee: esiEmp(5), calculation: esiCalc({ employee_id: 5, esi_wage: null }) },
        { employee: esiEmp(6), calculation: esiCalc({ employee_id: 6, salary_days: 0, esi_wage: "0.00", employee_esi: "0", employer_esi: "0" }) },
        { employee: esiEmp(7), calculation: esiCalc({ employee_id: 7, esi_status: "PENDING" }) },
        { employee: esiEmp(8), calculation: esiCalc({ employee_id: 8, esi_status: "NOT_APPLICABLE" }) },
      ],
    });
    assert.equal(v.summary.considered, 7);
    assert.equal(v.summary.ready + v.summary.blocked, v.summary.considered);
    const codes = Object.fromEntries(v.blocked.map((b) => [b.employee_id, b.reasons.map((r) => r.code)]));
    assert.deepEqual(codes[2], ["IP_MISSING"]);
    assert.deepEqual(codes[3], ["IP_INVALID"]);
    assert.ok(codes[4].includes("DAYS_INVALID"));
    assert.ok(codes[5].includes("WAGES_INVALID"));
    assert.deepEqual(codes[6], ["ZERO_REASON_MISSING"]);
    assert.ok(codes[7].includes("ESI_PENDING"));
    assert.equal(v.file_rows.length, 1);
  });

  it("an explicit reason clears a zero-day row, and a reason needing a last working day demands one", () => {
    const rows = [{ employee: esiEmp(6), calculation: esiCalc({ employee_id: 6, salary_days: 0, esi_wage: "0", employee_esi: "0", employer_esi: "0" }) }];
    const onLeave = S.validateEsi({ period: SEPT, rows, overrides: { 6: { reason_code: 1 } } });
    assert.equal(onLeave.summary.ready, 1);
    assert.deepEqual(onLeave.file_rows[0].slice(2), [0, 0, 1, ""]);

    const left = S.validateEsi({ period: SEPT, rows, overrides: { 6: { reason_code: 2 } } });
    assert.deepEqual(left.blocked[0].reasons.map((r) => r.code), ["LWD_MISSING"]);
    const leftWithDate = S.validateEsi({ period: SEPT, rows, overrides: { 6: { reason_code: 2, last_working_day: "2026-08-31" } } });
    assert.equal(leftWithDate.summary.ready, 1);
    assert.equal(leftWithDate.file_rows[0][5], "31/08/2026");
  });

  it("somebody who left during the month is reason 2 with their last working day, from the payrun snapshot", () => {
    const v = S.validateEsi({ period: SEPT, rows: [{ employee: esiEmp(1, { resignation_date: "2026-09-12" }), calculation: esiCalc({ salary_days: 10, esi_wage: "5000", employee_esi: "38", employer_esi: "163" }) }] });
    assert.equal(v.summary.ready, 1);
    assert.deepEqual(v.file_rows[0].slice(4), [2, "12/09/2026"]);
  });

  it("the file is the fixed ESIC layout: IP number, name in letters only, days, wages, reason, last working day", () => {
    const v = S.validateEsi({ period: SEPT, rows: [{ employee: esiEmp(1), calculation: esiCalc() }] });
    assert.equal(v.headers.length, 6);
    assert.match(v.headers[0], /IP Number/);
    assert.deepEqual(v.file_rows[0], ["1234567890", "EMPLOYEE A", 26, 15000, 0, ""]);
  });

  it("an employee share of zero (low-wage exemption) is not a mismatch; a wrong employer share is", () => {
    const ok = S.validateEsi({ period: SEPT, rows: [{ employee: esiEmp(1), calculation: esiCalc({ employee_esi: "0" }) }] });
    assert.equal(ok.summary.ready, 1);
    const bad = S.validateEsi({ period: SEPT, rows: [{ employee: esiEmp(1), calculation: esiCalc({ employer_esi: "100" }) }] });
    assert.deepEqual(bad.blocked[0].reasons.map((r) => r.code), ["CONTRIBUTION_MISMATCH"]);
  });
});
