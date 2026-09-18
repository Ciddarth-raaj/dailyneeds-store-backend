/**
 * Reports — the Employee Master field catalogue, held against the Employee
 * Master itself.
 *
 *   node --test constants/employee_report_catalogue.test.js
 *
 * ============================ THE DEFECT THIS PINS ========================
 *
 * The catalogue was written against the employee master as it stood when the
 * reports foundation shipped and then stopped tracking it. Eleven columns were
 * added to `new_employee` afterwards - employment type, grade, the four
 * statutory facts, the work shift, attendance required and the sync provenance
 * pair - and Reports knew about none of them. Nothing failed: a report simply
 * could not say what kind of employment somebody was on, and nobody found out
 * from a test.
 *
 * SO THE SWEEP IS MACHINE-CHECKED NOW. `EMPLOYEE_MASTER_COLUMNS` in
 * `repository/employee.js` is the Employee Master's own result contract, and
 * `repository/employee_detail_columns.test.js` already holds THAT against the
 * migrations. This file holds the CATALOGUE against it: every column is either
 * selected by a field here or named below with the reason it is not. Add a
 * column to the employee master and this test fails until somebody has
 * decided, in writing, whether it is reportable.
 *
 * It is a classification check, not a permission check - who may read what is
 * `usecase/employee_report.test.js`.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const catalogue = require("./employee_report_catalogue");
const { EMPLOYEE_MASTER_COLUMNS } = require("../repository/employee");

/** `new_employee.x` -> `x`. */
const bare = (qualified) => String(qualified).split(".").pop();

const MASTER_COLUMNS = EMPLOYEE_MASTER_COLUMNS.map(bare);

/**
 * EVERY `new_employee` COLUMN THAT IS DELIBERATELY NOT REPORTABLE, and why.
 *
 * This is the half of the audit a catalogue cannot state by itself: a field
 * that is absent looks exactly like a field that was forgotten. Naming them
 * here makes the difference visible, and makes forgetting one fail.
 */
const NOT_REPORTABLE = {
  employee_image: "a base64 LONGTEXT blob; not meaningful in a spreadsheet cell",
  introducer_name: "recruitment referral notes - operational/internal",
  introducer_details: "the same, as LONGTEXT free text",
  salary:
    "LEGACY - an undated free-text VARCHAR nothing owns. The current APPROVED " +
    "employee_salary structure is reported instead, behind view_salary",
  esi: "deprecated - superseded by esi_number and esi_applicable",
  pf: "deprecated - superseded by pf_number, pf_applicable and previous_pf_member",
  uniform_qty: "operational/internal issue tracking",
  online_portal: "auth/internal - a portal access flag",
  telegram_username: "operational/internal messaging handle",
  aadhaar_card_no: "SECURITY - a full Aadhaar must never be exportable",
  aadhaar_card_name: "SECURITY - the C2 verified name is reported instead, gated",
  aadhaar_card_image: "SECURITY - document storage internals",
  shift_code: "sync artefact duplicating shift_id; the resolved name is exported",
  special_break_override_minutes:
    "attendance engine configuration, set on the attendance screens behind " +
    "manage_employee_break_override; it is not on the Employee Master at all",
  source_system: "sync provenance - which system delivered this row",
  source_employee_code: "sync provenance - that system's own identifier",
  created_at: "row metadata",
  updated_at: "row metadata",
};

/**
 * Every `new_employee` column some catalogue field reads.
 *
 * THE JOIN TEXT COUNTS TOO. `store_id`, `department_id`, `designation_id`,
 * `shift_id` and `default_work_shift_id` are never SELECTed - the catalogue
 * exports the resolved LABEL, which is what the Employee Master displays - so
 * the only place they appear is the ON clause of the join that resolves them.
 * A sweep that read the select list alone would report five reported columns
 * as missing.
 */
const selectedColumns = () => {
  const found = new Set();
  const sql = catalogue.FIELDS.map(
    (f) => `${f.select} ${f.filter_select || ""} ${f.join ? catalogue.JOINS[f.join] : ""}`
  ).join(" ");
  for (const column of MASTER_COLUMNS) {
    if (new RegExp(`new_employee\\.${column}\\b`).test(sql)) found.add(column);
  }
  return found;
};

/* ===================================== the sweep is complete and honest == */

test("EVERY EMPLOYEE MASTER COLUMN IS EITHER REPORTABLE OR REFUSED BY NAME", () => {
  const selected = selectedColumns();
  const unaccounted = MASTER_COLUMNS.filter(
    (c) => !selected.has(c) && !(c in NOT_REPORTABLE)
  );
  assert.deepStrictEqual(
    unaccounted,
    [],
    "a column was added to the Employee Master and never classified for Reports: " +
      "either give it a catalogue entry or say here why it has none"
  );
});

test("nothing is BOTH reported and refused", () => {
  const selected = selectedColumns();
  const contradictory = Object.keys(NOT_REPORTABLE).filter((c) => selected.has(c));
  assert.deepStrictEqual(contradictory, [], "a column cannot be excluded and selected");
});

test("the refusal list names only columns that exist", () => {
  const ghosts = Object.keys(NOT_REPORTABLE).filter((c) => !MASTER_COLUMNS.includes(c));
  assert.deepStrictEqual(ghosts, [], "a reason for a column that is gone is dead weight");
});

test("THE COLUMNS THIS TASK ADDED ARE ACTUALLY REACHABLE", () => {
  // The eleven that arrived after the reports foundation, plus the two the
  // first sweep set aside and this one revisited.
  const expected = {
    employment_type: "employment_type",
    grade: "grade",
    attendance_required: "attendance_required",
    work_shift: "default_work_shift_id",
    pf_applicable: "pf_applicable",
    esi_applicable: "esi_applicable",
    previous_pf_member: "previous_pf_member",
    previous_eps_member: "previous_eps_member",
    payment_type: "payment_type",
    marriage_date: "marriage_date",
    resignation_date: "resignation_date",
  };
  for (const [key, column] of Object.entries(expected)) {
    const field = catalogue.getField(key);
    assert.ok(field, `${key} must be a catalogue field`);
    assert.strictEqual(field.enabled, true, `${key} must be enabled`);
    const sql = `${field.select} ${field.join ? catalogue.JOINS[field.join] : ""}`;
    assert.ok(sql.includes(column), `${key} must read ${column}, not something near it`);
  }
});

/* ================================================= the values they export */

test("a nullable statutory flag exports three answers, never two", () => {
  const field = catalogue.getField("pf_applicable");
  assert.strictEqual(field.transform(1), "Yes");
  assert.strictEqual(field.transform(0), "No");
  assert.strictEqual(field.transform(null), "Not recorded");
  assert.strictEqual(field.transform(undefined), "Not recorded");
});

test("ATTENDANCE REQUIRED IS NOT NULL, SO IT HAS ONLY TWO", () => {
  const field = catalogue.getField("attendance_required");
  assert.strictEqual(field.transform(1), "Yes");
  assert.strictEqual(field.transform(0), "No");
  // The column is NOT NULL DEFAULT 1; the default is the answer, not a gap.
  assert.strictEqual(field.transform(null), "Yes");
});

test("A MONEY COLUMN LEAVES AS STORED, AND AN UNRESOLVED ONE LEAVES BLANK", () => {
  const gross = catalogue.getField("monthly_gross");
  assert.strictEqual(gross.transform("45000.00"), "45000.00", "no symbol, no grouping");
  // PENDING is not zero. A contribution nobody has worked out and a
  // contribution of nothing are different facts.
  assert.strictEqual(catalogue.getField("employer_esi").transform(null), null);
  assert.strictEqual(catalogue.getField("employer_esi").transform(""), null);
});

test("the work shift is the resolved NAME, not the foreign key", () => {
  const field = catalogue.getField("work_shift");
  assert.strictEqual(field.select, "work_shift.shift_name");
  assert.match(catalogue.JOINS.work_shift, /work_shift\.work_shift_id = new_employee\.default_work_shift_id/);
});

/* =========================== the salary join cannot multiply a row ======= */

test("THE SALARY JOIN PINS ONE ROW, SO PREVIEW AND EXPORT STILL AGREE", () => {
  // `employee_salary` holds one row per revision. A plain join on employee_id
  // would turn one employee into one row per revision - and the count the
  // preview shows comes from the SAME builder, so the two would disagree
  // silently. Joining on the primary key chosen by a correlated subquery is
  // what keeps it at most one.
  const join = catalogue.JOINS.current_salary;
  assert.match(join, /employee_salary\.salary_id = \(/, "joined on the primary key");
  assert.match(join, /LIMIT 1\)/);
  assert.match(join, /s\.status = 'APPROVED'/, "PENDING is not current; REJECTED never was");
  assert.match(join, /s\.effective_from <= CURDATE\(\)/, "a future revision is not current yet");
  assert.match(
    join,
    /ORDER BY s\.effective_from DESC, s\.salary_id DESC/,
    "two rows on one date resolve to the later, deterministically"
  );
  assert.ok(!/\?/.test(join), "no placeholder, and therefore no caller value, in a join");
});

test("every join is fixed text naming a table this file knows", () => {
  const tables = [
    "outlets", "department", "designation", "shift_master", "work_shift",
    "employee_aadhaar_identity", "employee_bank_verification", "employee_salary",
  ];
  for (const [name, sql] of Object.entries(catalogue.JOINS)) {
    assert.match(sql, /^LEFT JOIN /, `${name} must be a LEFT JOIN`);
    assert.ok(
      tables.some((t) => sql.includes(t)),
      `${name} joins a table this test does not know about`
    );
  }
});

/* ============================== the seeded reports still reconcile ======= */

test("EVERY FIELD KEY THE SEEDED SYSTEM TEMPLATES NAME STILL EXISTS", () => {
  // The reports-foundation migration seeds five built-in reports by field KEY.
  // Renaming or dropping a key here would not break a query - it would
  // reconcile the column away with a warning, which is worse: the report would
  // keep running and quietly stop showing what it is named after.
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "migrations/mysql/migrations/sqls/20260909160000-reports-foundation-up.sql"
    ),
    "utf8"
  );
  const seeded = new Set();
  for (const match of sql.matchAll(/CAST\('\[([^\]]*)\]'\s+AS\s+JSON\)/g)) {
    for (const key of match[1].split(",")) seeded.add(key.trim().replace(/"/g, ""));
  }
  assert.ok(seeded.size >= 10, "the seeded keys were parsed out of the migration");
  for (const key of seeded) {
    const field = catalogue.getField(key);
    assert.ok(field, `the built-in reports name '${key}', which no longer exists`);
    assert.strictEqual(field.enabled, true, `'${key}' is named by a built-in report but disabled`);
  }
});

test("a built-in report's own columns resolve for an administrator", () => {
  const { resolveFields } = require("../usecase/employee_report");
  const admin = { permissions: [], isAdmin: true };
  const activeList = [
    "employee_id", "employee_name", "outlet", "department", "designation",
    "shift", "date_of_joining",
  ];
  const { fields, warnings } = resolveFields(activeList, admin, "reconcile");
  assert.deepStrictEqual(fields.map((f) => f.key), activeList, "order is the contract");
  assert.deepStrictEqual(warnings, [], "nothing was reconciled away");
});
