/**
 * Payroll Reports - the catalogue and the one query path, pure.
 *
 *   node --test utils/payroll_report_query.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const Q = require("./payroll_report_query");
const catalogue = require("../constants/payroll_report_catalogue");
const { REPORT_TYPES, REPORT_TYPE_ORDER } = require("../constants/payroll_report_types");
const employeeCatalogue = require("../constants/employee_report_catalogue");

const PAYROLL_READER = { userId: 7, isAdmin: false, permissions: ["view_reports", "view_employees", "view_payroll", "view_salary"] };
const SENSITIVE_READER = { ...PAYROLL_READER, permissions: [...PAYROLL_READER.permissions, "view_employee_sensitive"] };
const ADMIN = { userId: 1, isAdmin: true, permissions: [] };
const SEPT = Q.periodOf(2026, 9);

const build = (keys, extra = {}) =>
  Q.buildQuery({
    reportType: "PAYROLL_REGISTER",
    fields: Q.resolveFields(keys, ADMIN).fields,
    filters: Q.resolveFilters({}),
    period: SEPT,
    store_ids: null,
    ...extra,
  });

describe("the catalogue", () => {
  it("every report type's default columns exist in the catalogue", () => {
    for (const k of REPORT_TYPE_ORDER) {
      for (const key of REPORT_TYPES[k].default_fields) assert.ok(catalogue.getField(key), `${k}: ${key}`);
    }
  });

  it("every field names a known source and every join resolves", () => {
    for (const f of catalogue.FIELDS) {
      assert.ok(catalogue.SOURCE_LABEL[f.source], f.key);
      const joins = Array.isArray(f.join) ? f.join : f.join ? [f.join] : [];
      for (const j of joins) assert.ok(catalogue.JOINS[j], `${f.key} -> ${j}`);
    }
  });

  it("Employee Master fields are offered from the Employee Master catalogue itself, with its permissions", () => {
    const pan = catalogue.getField("em_pan_no");
    assert.ok(pan, "PAN is selectable from the Employee Master group");
    assert.equal(pan.permission, employeeCatalogue.getField("pan_no").permission);
    assert.ok(catalogue.getField("em_mobile"));
    assert.ok(catalogue.getField("em_gender"));
    assert.ok(catalogue.getField("em_email"));
    assert.ok(catalogue.getField("em_employment_type"));
    assert.ok(catalogue.getField("em_attendance_calculation_mode"));
    // Never the current salary structure, and never a snapshotted key twice.
    assert.equal(catalogue.getField("em_monthly_gross"), null);
    assert.equal(catalogue.getField("em_outlet"), null);
    // And never a full Aadhaar - it has no entry anywhere.
    assert.equal(catalogue.FIELDS.some((f) => /aadhaar_(number|card_no)/.test(f.key)), false);
  });

  it("identifier and bank fields require view_employee_sensitive", () => {
    for (const key of ["uan", "pf_member_id", "esi_number", "bank_name", "bank_account_number", "bank_ifsc", "em_pan_no"]) {
      assert.equal(catalogue.getField(key).permission, "view_employee_sensitive", key);
    }
  });
});

describe("field access", () => {
  it("a caller without the sensitive key does not even see the sensitive fields", () => {
    const keys = Q.discoverFields(PAYROLL_READER).map((f) => f.key);
    for (const k of ["uan", "esi_number", "bank_account_number", "em_pan_no", "em_aadhaar_last4"]) {
      assert.equal(keys.includes(k), false, k);
    }
    assert.ok(keys.includes("net_pay"));
    assert.ok(keys.includes("em_mobile"));
    const withKey = Q.discoverFields(SENSITIVE_READER).map((f) => f.key);
    assert.ok(withKey.includes("uan") && withKey.includes("bank_account_number") && withKey.includes("em_pan_no"));
  });

  it("naming an unauthorized field is refused in strict mode, with the same message as an unknown one", () => {
    const forbidden = assert.throws(() => Q.resolveFields(["employee_id", "uan"], PAYROLL_READER, "strict"), (e) => e.code === "UNKNOWN_FIELD");
    void forbidden;
    assert.throws(() => Q.resolveFields(["employee_id", "nope"], PAYROLL_READER, "strict"), (e) => e.code === "UNKNOWN_FIELD");
  });

  it("reconcile mode drops an unauthorized field from a saved layout with a warning", () => {
    const { fields, warnings } = Q.resolveFields(["employee_id", "uan", "net_pay"], PAYROLL_READER, "reconcile");
    assert.deepEqual(fields.map((f) => f.key), ["employee_id", "net_pay"]);
    assert.equal(warnings.length, 1);
  });

  it("default columns are narrowed to what the caller may see", () => {
    assert.equal(Q.defaultFieldKeys("BANK", PAYROLL_READER).includes("bank_account_number"), false);
    assert.ok(Q.defaultFieldKeys("BANK", SENSITIVE_READER).includes("bank_account_number"));
  });
});

describe("the query", () => {
  it("reads EVERY payrun employee of the requested month; figures only from approved & locked rows", () => {
    const q = build(["employee_id", "net_pay"]);
    assert.match(q.sql, /FROM payrun_employee pe\nLEFT JOIN payrun_employee_calculation c/);
    assert.match(q.sql, /pe\.period_year = \? AND pe\.period_month = \?/);
    assert.deepEqual(q.params.slice(0, 2), [2026, 9]);
    // No status condition in the WHERE: a row is never dropped for its lock state.
    assert.doesNotMatch(q.sql.slice(q.sql.indexOf("WHERE")), /APPROVED_LOCKED/);
    // ...but every calculation figure is shown only when it is final.
    assert.match(q.sql, /IF\(c\.status = 'APPROVED_LOCKED', c\.net_pay, NULL\) AS c1_v/);
    assert.match(q.sql, /pe\.employee_id AS c0_v/);
    assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("nothing about the employee today filters the population", () => {
    const q = build(["employee_id", "em_mobile"]);
    const where = q.sql.slice(q.sql.indexOf("WHERE"));
    assert.doesNotMatch(where, /new_employee\.status|resignation|is_active/);
  });

  it("a historical month is read by its own year and month", () => {
    const q = build(["employee_id"], { period: Q.periodOf(2025, 3) });
    assert.deepEqual(q.params.slice(0, 2), [2025, 3]);
  });

  it("selects columns in exactly the requested order", () => {
    const keys = ["net_pay", "employee_name", "gross_salary", "employee_id"];
    const q = build(keys);
    const aliases = [...q.sql.matchAll(/AS c(\d+)_/g)].map((m) => Number(m[1]));
    assert.deepEqual(aliases, [0, 1, 2, 3]);
    const fields = Q.resolveFields(keys, ADMIN).fields;
    const row = Q.presentRow({ c0_v: "100.50", c1_v: "Asha", c2_v: "200", c3_v: 9 }, fields);
    assert.deepEqual(Object.keys(row), keys);
    assert.equal(row.net_pay, 100.5);
  });

  it("the branch scope fails closed and outlet filters only narrow", () => {
    assert.match(build(["employee_id"], { store_ids: [] }).sql, /1 = 0/);
    const scoped = build(["employee_id"], { store_ids: [2, 3] });
    assert.match(scoped.sql, /pe\.store_id IN \(\?\)/);
    assert.ok(scoped.params.some((p) => Array.isArray(p) && p.join() === "2,3"));
    const both = build(["employee_id"], { store_ids: [2], filters: Q.resolveFilters({ outlet_ids: [9] }) });
    assert.equal((both.sql.match(/pe\.store_id IN \(\?\)/g) || []).length, 2, "scope AND filter, never filter instead of scope");
  });

  it("each report type adds its population and nothing else", () => {
    const fields = Q.resolveFields(["employee_id"], ADMIN).fields;
    const of = (t) => Q.buildQuery({ reportType: t, fields, filters: Q.resolveFilters({}), period: SEPT, store_ids: null }).sql;
    assert.match(of("EPF"), /IF\(c\.payrun_calculation_id IS NULL, COALESCE\(pe\.pf_applicable, 0\) = 1, COALESCE\(c\.pf_status, ''\) <> 'NOT_APPLICABLE'\)/);
    assert.match(of("ESI"), /esi_status/);
    assert.match(of("BANK"), /pe\.pay_type\) = 'BANK'/);
    assert.match(of("OT"), /COALESCE\(c\.approved_ot_minutes, 0\) > 0/);
  });

  it("only the joins the selected fields need are added; Employee Master joins hang off new_employee", () => {
    assert.doesNotMatch(build(["employee_id", "net_pay"]).sql, /JOIN new_employee|attendance_monthly_payroll/);
    const em = build(["employee_id", "em_attendance_calculation_mode"]).sql;
    assert.ok(em.indexOf("LEFT JOIN new_employee") < em.indexOf("LEFT JOIN employee_attendance_calculation_mode"));
    const adc = build(["absent_days"]);
    assert.match(adc.sql, /attendance_day_calculation/);
    assert.deepEqual(adc.params.slice(0, 2), ["2026-09-01", "2026-09-30"], "the date range is bound, before the WHERE params");
  });

  it("attendance month figures are gated on the summary being the one the payrun read", () => {
    assert.match(build(["present_days"]).sql, /amp\.calculated_at = c\.attendance_calculated_at/);
  });

  it("the count needs no joins, totals sum only stored amounts", () => {
    const count = build(["employee_id", "absent_days"], { mode: "count" });
    assert.doesNotMatch(count.sql, /attendance_day_calculation/);
    const totals = build(["employee_name", "net_pay", "basic"], { mode: "totals" });
    assert.match(totals.sql, /SUM\(IF\(c\.status = 'APPROVED_LOCKED', c\.net_pay, NULL\)\) AS t1/);
    assert.match(count.sql, /SUM\(c\.status = 'APPROVED_LOCKED'\) AS finalized_count/);
    assert.doesNotMatch(totals.sql, /t2/);
  });

  it("sorting is by a selected field's own expression, then employee id", () => {
    const q = build(["outlet", "employee_id"], { display: Q.resolveDisplay({ sort_by: "outlet", sort_dir: "desc" }, ["outlet", "employee_id"]) });
    assert.match(q.sql, /ORDER BY pe\.store_name DESC, pe\.employee_id ASC/);
    assert.equal(Q.resolveDisplay({ sort_by: "net_pay" }, ["outlet"]).sort_by, null, "cannot sort by an unselected column");
  });

  it("earned components are the payslip's balanced split of the stored salary earnings", () => {
    const fields = Q.resolveFields(["basic", "hra", "conveyance", "special_allowance"], ADMIN).fields;
    const raw = {};
    fields.forEach((f, i) => {
      Object.assign(raw, { [`c${i}_earnings`]: "15000.00", [`c${i}_basic`]: "10000", [`c${i}_hra`]: "5000", [`c${i}_conveyance`]: "0", [`c${i}_special_allowance`]: "5000" });
    });
    const row = Q.presentRow(raw, fields);
    assert.equal(row.basic + row.hra + row.conveyance + row.special_allowance, 15000);
  });

  it("department and designation filter on the payrun snapshot; employment type on the current master, without a join", () => {
    const q = build(["employee_id"], {
      filters: Q.resolveFilters({ department_ids: [3], designation_ids: [7, 8], employment_types: ["Contract", "Bogus"] }),
    });
    assert.match(q.sql, /pe\.department_id IN \(\?\)/);
    assert.match(q.sql, /pe\.designation_id IN \(\?\)/);
    assert.match(q.sql, /EXISTS \(SELECT 1 FROM new_employee fe WHERE fe\.employee_id = pe\.employee_id AND fe\.employment_type IN \(\?\)\)/);
    assert.ok(q.params.some((p) => Array.isArray(p) && p.join() === "7,8"));
    assert.ok(q.params.some((p) => Array.isArray(p) && p.join() === "Contract"), "an unknown employment type is dropped");
    assert.doesNotMatch(q.sql, /LEFT JOIN new_employee/);
    // The count applies exactly the same filters, so count and rows agree.
    const count = build(["employee_id"], { mode: "count", filters: Q.resolveFilters({ designation_ids: [7], employment_types: ["Permanent"] }) });
    assert.match(count.sql, /pe\.designation_id IN/);
    assert.match(count.sql, /fe\.employment_type IN/);
  });

  it("templates keep the new filters; a one-off search is still not kept", () => {
    assert.deepEqual(Q.persistableFilters({ department_ids: [3], designation_ids: [7], employment_types: ["Permanent"], search: "x" }), {
      outlet_ids: [], department_ids: [3], designation_ids: [7], employment_types: ["Permanent"], pay_type: null,
    });
  });
});
