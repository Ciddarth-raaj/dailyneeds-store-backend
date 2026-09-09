/**
 * Reports — the Employee Master catalogue and resolver.
 *
 *   node --test usecase/employee_report.test.js
 *
 * Bulk export is a sensitive read surface: one request can carry every
 * employee's PAN out of the building. So the tests that matter most are the
 * ones about what CANNOT happen -
 *
 *   no caller string becomes SQL
 *   full Aadhaar has no catalogue entry at all
 *   salary and payment type are not Employee Master fields
 *   an unauthorized field cannot be reached by asking for it directly
 *   the field cap cannot be bypassed
 */
const test = require("node:test");
const assert = require("node:assert");

const catalogue = require("../constants/employee_report_catalogue");
const { DATASET, ENABLED_DATASETS, isEnabledDataset } = require("../constants/report_datasets");
const {
  discoverFields,
  resolveFields,
  resolveFilters,
  buildQuery,
  presentRow,
  MAX_FIELDS,
} = require("./employee_report");

const perms = (...keys) => keys.map((permission_key) => ({ permission_key }));
const hrActor = { permissions: perms("view_employees"), isAdmin: false };
const sensitiveActor = {
  permissions: perms("view_employees", "view_employee_sensitive"),
  isAdmin: false,
};
const adminActor = { permissions: [], isAdmin: true };

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });

/* ============================================================= datasets */
test("only EMPLOYEE_MASTER is enabled", () => {
  assert.deepStrictEqual(ENABLED_DATASETS, [DATASET.EMPLOYEE_MASTER]);
  assert.strictEqual(isEnabledDataset("EMPLOYEE_MASTER"), true);
  for (const notYet of ["ATTENDANCE_DAILY", "ATTENDANCE_SUMMARY", "PAYROLL_REGISTER"]) {
    assert.strictEqual(isEnabledDataset(notYet), false, `${notYet} must not be selectable`);
  }
});

/* ==================================================== what cannot exist */
test("FULL AADHAAR HAS NO CATALOGUE ENTRY AT ALL", () => {
  // Not a gated entry, not a disabled one. A field that does not exist
  // cannot be exported by a bug in a permission check.
  for (const forbidden of catalogue.FORBIDDEN_KEYS) {
    assert.strictEqual(catalogue.getField(forbidden), null, `${forbidden} must not exist`);
  }
  const selects = catalogue.FIELDS.map((f) => f.select).join(" ");
  for (const column of ["aadhaar_card_no", "aadhaar_card_image", "aadhaar_ciphertext", "aadhaar_fingerprint"]) {
    assert.ok(!selects.includes(column), `no field may select ${column}`);
  }
});

test("SALARY AND PAYMENT TYPE ARE NOT EMPLOYEE MASTER FIELDS", () => {
  assert.strictEqual(catalogue.getField("salary"), null);
  assert.strictEqual(catalogue.getField("payment_type"), null);
  const selects = catalogue.FIELDS.map((f) => f.select).join(" ");
  assert.ok(!/new_employee\.salary/.test(selects), "salary is Payroll's, deferred");
  assert.ok(!/new_employee\.payment_type/.test(selects));
  // And no label smuggles them back in.
  for (const f of catalogue.FIELDS) {
    assert.ok(!/salary|payment type/i.test(f.label), `${f.key} label mentions pay`);
  }
});

test("the account number is exported masked, never whole", () => {
  const field = catalogue.getField("account_no");
  assert.ok(field.transform, "a transform is mandatory here");
  assert.strictEqual(field.transform("123456789012"), "********9012");
  assert.strictEqual(field.transform("1234"), "****");
  assert.strictEqual(field.transform(null), null);
  assert.strictEqual(field.sensitive, true);
});

/* ============================================================ discovery */
test("discovery hides fields the caller may not use", () => {
  const hrKeys = discoverFields(hrActor).map((f) => f.key);
  for (const gated of ["pan_no", "uan", "pf_number", "esi_number", "bank_name", "account_no", "ifsc"]) {
    assert.ok(!hrKeys.includes(gated), `${gated} must not be offered without sensitive access`);
  }
  // What they may see is still useful.
  for (const open of ["employee_id", "employee_name", "outlet", "department", "aadhaar_status", "bank_status"]) {
    assert.ok(hrKeys.includes(open), `${open} should be discoverable`);
  }
});

test("sensitive access reveals the gated fields, and admin too", () => {
  const keys = discoverFields(sensitiveActor).map((f) => f.key);
  for (const gated of ["pan_no", "uan", "pf_number", "esi_number", "bank_name", "account_no", "ifsc"]) {
    assert.ok(keys.includes(gated), `${gated} should be discoverable with the key`);
  }
  assert.deepStrictEqual(
    discoverFields(adminActor).map((f) => f.key).sort(),
    keys.sort(),
    "admin sees the same catalogue"
  );
});

test("discovery never leaks the SQL behind a field", () => {
  for (const entry of discoverFields(sensitiveActor)) {
    assert.deepStrictEqual(Object.keys(entry).sort(), [
      "default_selected", "group", "history_backed", "key", "label", "sensitive",
    ]);
  }
});

/* ==================================================== field validation */
test("AN UNAUTHORIZED FIELD CANNOT BE REACHED BY ASKING FOR IT DIRECTLY", () => {
  // The picker never offered it; the request is made anyway.
  throwsCode(() => resolveFields(["employee_id", "pan_no"], hrActor), "UNKNOWN_FIELD");
  // And with the key it works, so the refusal is the permission and not a typo.
  const { fields } = resolveFields(["employee_id", "pan_no"], sensitiveActor);
  assert.deepStrictEqual(fields.map((f) => f.key), ["employee_id", "pan_no"]);
});

test("an unknown or forbidden key is refused, not interpolated", () => {
  throwsCode(() => resolveFields(["no_such_field"], sensitiveActor), "UNKNOWN_FIELD");
  throwsCode(() => resolveFields(["salary"], adminActor), "UNKNOWN_FIELD");
  throwsCode(() => resolveFields(["aadhaar_card_no"], adminActor), "UNKNOWN_FIELD");
  throwsCode(() => resolveFields(["employee_id; DROP TABLE new_employee"], adminActor), "UNKNOWN_FIELD");
});

test("the refusal does not reveal whether the field exists", () => {
  let unauthorized;
  let unknown;
  try { resolveFields(["pan_no"], hrActor); } catch (e) { unauthorized = e.message; }
  try { resolveFields(["totally_made_up"], hrActor); } catch (e) { unknown = e.message; }
  assert.strictEqual(
    unauthorized.replace("pan_no", "X"),
    unknown.replace("totally_made_up", "X"),
    "one message for both, so the report is not an existence oracle"
  );
});

test("THE FIELD CAP CANNOT BE BYPASSED BY A DIRECT CALL", () => {
  const many = Array.from({ length: MAX_FIELDS + 1 }, () => "employee_id");
  throwsCode(() => resolveFields(many, adminActor), "TOO_MANY_FIELDS");
  // Checked on what was ASKED FOR: 200 junk keys of which few survive
  // reconciliation must not slip past the cap either.
  const padded = Array.from({ length: MAX_FIELDS + 5 }, (_, i) => `junk_${i}`);
  throwsCode(() => resolveFields(padded, adminActor, "reconcile"), "TOO_MANY_FIELDS");
});

test("an empty selection is refused", () => {
  throwsCode(() => resolveFields([], adminActor), "NO_FIELDS");
  throwsCode(() => resolveFields(null, adminActor), "NO_FIELDS");
});

test("SELECTED ORDER IS PRESERVED EXACTLY, and duplicates collapse", () => {
  const asked = ["designation", "employee_name", "employee_id", "employee_name"];
  const { fields } = resolveFields(asked, adminActor);
  assert.deepStrictEqual(fields.map((f) => f.key), ["designation", "employee_name", "employee_id"]);
});

/* ================================================ template reconciliation */
test("a template drops fields it may no longer use, and says so", () => {
  const { fields, warnings } = resolveFields(
    ["employee_id", "pan_no", "employee_name"],
    hrActor,
    "reconcile"
  );
  assert.deepStrictEqual(fields.map((f) => f.key), ["employee_id", "employee_name"]);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].type, "field_unavailable");
  assert.strictEqual(warnings[0].field, "pan_no");
  // Losing a column narrows what is shown; it cannot widen the population.
  assert.strictEqual(warnings[0].widens_result_set, false);
});

test("a template whose every field is gone is refused rather than run empty", () => {
  throwsCode(() => resolveFields(["pan_no", "uan"], hrActor, "reconcile"), "NO_USABLE_FIELDS");
});

/* ============================================================== filters */
test("the default employment status is Active", () => {
  assert.strictEqual(resolveFilters({}).status, "active");
  assert.strictEqual(resolveFilters().status, "active");
});

test("status accepts exactly the three business values", () => {
  for (const s of ["active", "inactive", "all"]) {
    assert.strictEqual(resolveFilters({ status: s }).status, s);
  }
  assert.strictEqual(resolveFilters({ status: "ACTIVE" }).status, "active");
  throwsCode(() => resolveFilters({ status: "terminated" }), "BAD_STATUS");
  throwsCode(() => resolveFilters({ status: "1=1" }), "BAD_STATUS");
});

test("lookup filters are positive integers, de-duplicated", () => {
  const f = resolveFilters({ outlet_ids: [2, 3, 3], department_ids: [1], designation_ids: [15] });
  assert.deepStrictEqual(f.outlet_ids, [2, 3]);
  assert.deepStrictEqual(f.department_ids, [1]);
  assert.deepStrictEqual(f.designation_ids, [15]);
});

test("A FILTER VALUE THAT IS NOT AN ID IS REFUSED, NEVER COERCED", () => {
  for (const bad of ["2 OR 1=1", "abc", "-1", "0", "1;--", 1.5]) {
    throwsCode(() => resolveFilters({ outlet_ids: [bad] }), "BAD_FILTER_VALUE");
  }
});

test("search is trimmed and bounded", () => {
  assert.strictEqual(resolveFilters({ search: "  Ramesh  " }).search, "Ramesh");
  assert.strictEqual(resolveFilters({ search: "x".repeat(500) }).search.length, 100);
});

/* ============================================== the query is structural */
test("NO CALLER STRING APPEARS IN THE SQL", () => {
  const { fields } = resolveFields(["employee_id", "employee_name", "outlet"], adminActor);
  const filters = resolveFilters({
    search: "'; DROP TABLE new_employee; --",
    outlet_ids: [2],
    status: "all",
  });
  const { sql, params } = buildQuery(fields, filters);

  assert.ok(!sql.includes("DROP"), "the search value is not in the SQL");
  assert.ok(!sql.includes("--"));
  // It is a bound parameter instead, wildcards added server-side.
  assert.ok(params.includes("%'; DROP TABLE new_employee; --%"));
  assert.ok(/LIKE \?/.test(sql));
});

test("the SELECT list comes from the catalogue, in the requested order", () => {
  const { fields } = resolveFields(["designation", "employee_id"], adminActor);
  const { sql } = buildQuery(fields, resolveFilters({}));
  const selectPart = sql.slice(0, sql.indexOf("FROM"));
  assert.ok(selectPart.indexOf("designation.designation_name AS c0") < selectPart.indexOf("new_employee.employee_id AS c1"));
});

test("only the joins the selected fields need are added", () => {
  const base = buildQuery(resolveFields(["employee_id"], adminActor).fields, resolveFilters({}));
  assert.ok(!/LEFT JOIN/.test(base.sql), "a base-only report joins nothing");

  const withLookups = buildQuery(
    resolveFields(["outlet", "department"], adminActor).fields,
    resolveFilters({})
  );
  assert.ok(/LEFT JOIN outlets/.test(withLookups.sql));
  assert.ok(/LEFT JOIN department/.test(withLookups.sql));
  assert.ok(!/shift_master/.test(withLookups.sql), "an unselected lookup is not joined");
});

test("pagination is bound, and the count query selects no columns", () => {
  const { fields } = resolveFields(["employee_id"], adminActor);
  const page = buildQuery(fields, resolveFilters({}), { limit: 25, offset: 50 });
  assert.ok(/LIMIT \? OFFSET \?/.test(page.sql));
  assert.deepStrictEqual(page.params.slice(-2), [25, 50]);

  const count = buildQuery(fields, resolveFilters({}), { count: true });
  assert.match(count.sql, /SELECT COUNT\(\*\) AS matching_count/);
  assert.ok(!/LIMIT/.test(count.sql));
});

test("COUNT AND ROWS SHARE ONE WHERE CLAUSE", () => {
  // The property that makes preview and export agree.
  const { fields } = resolveFields(["employee_id", "outlet"], adminActor);
  const filters = resolveFilters({ status: "active", outlet_ids: [2], search: "Ram" });

  const whereOf = (q) => q.sql.slice(q.sql.indexOf("WHERE"), q.sql.indexOf("ORDER BY") === -1 ? undefined : q.sql.indexOf("ORDER BY")).trim();
  const count = buildQuery(fields, filters, { count: true });
  const rows = buildQuery(fields, filters, { limit: 10, offset: 0 });

  assert.strictEqual(whereOf(count), whereOf(rows));
  // And the same bound values, ignoring the pagination pair.
  assert.deepStrictEqual(count.params, rows.params.slice(0, rows.params.length - 2));
});

test("status maps to the real column, and 'all' does not filter it", () => {
  const { fields } = resolveFields(["employee_id"], adminActor);
  assert.ok(/new_employee\.status = 1/.test(buildQuery(fields, resolveFilters({ status: "active" })).sql));
  assert.ok(/new_employee\.status <> 1/.test(buildQuery(fields, resolveFilters({ status: "inactive" })).sql));
  assert.ok(!/new_employee\.status/.test(buildQuery(fields, resolveFilters({ status: "all" })).sql));
});

/* ============================================================= rendering */
test("rows are presented by key, with transforms applied", () => {
  const { fields } = resolveFields(["employee_id", "employment_status", "account_no"], adminActor);
  const row = presentRow({ c0: 631, c1: 1, c2: "123456789012" }, fields);
  assert.deepStrictEqual(row, {
    employee_id: 631,
    employment_status: "Active",
    account_no: "********9012",
  });
});

test("a missing value becomes null rather than undefined", () => {
  const { fields } = resolveFields(["email"], adminActor);
  assert.deepStrictEqual(presentRow({}, fields), { email: null });
});

/* ====================================== forward-compatibility metadata */
test("history_backed marks the four placement fields, and nothing else", () => {
  const backed = catalogue.FIELDS.filter((f) => f.history_backed).map((f) => f.key).sort();
  assert.deepStrictEqual(backed, ["department", "designation", "outlet", "shift"]);
});

test("every field declares a group and a join footprint", () => {
  const footprints = ["base", "lookup", "c2_identity", "c2_bank", "derived"];
  for (const f of catalogue.FIELDS) {
    assert.ok(catalogue.GROUP_ORDER.includes(f.group), `${f.key} has an unknown group`);
    assert.ok(footprints.includes(f.join_footprint), `${f.key} has an unknown footprint`);
    assert.ok(f.select && typeof f.select === "string", `${f.key} needs a select`);
    if (f.join) assert.ok(catalogue.JOINS[f.join], `${f.key} names an undefined join`);
  }
});

/* ========== the report population is the status filter, not the directory's */
test("THE REPORT NEVER INHERITS THE DIRECTORY'S RESIGNATION EXCLUSION", () => {
  // If it did, "Resigned" would return nobody and "All" would quietly mean
  // "all except the ones who left" - wrong in a way a reader of the
  // spreadsheet cannot see.
  const { fields } = resolveFields(["employee_id"], adminActor);
  for (const status of ["active", "inactive", "all"]) {
    const { sql } = buildQuery(fields, resolveFilters({ status }));
    assert.ok(!/employee_name NOT IN/.test(sql), `${status}: no name exclusion`);
    assert.ok(!/resignation/i.test(sql), `${status}: the resignation table is not consulted`);
  }
});

test("'all' with no filters constrains nothing, and is still valid SQL", () => {
  const { fields } = resolveFields(["employee_id"], adminActor);
  const { sql, params } = buildQuery(fields, resolveFilters({ status: "all" }));
  assert.ok(!/WHERE/.test(sql), "an unfiltered All has no predicate at all");
  assert.deepStrictEqual(params, []);
  assert.match(sql, /ORDER BY new_employee\.employee_id ASC/);
});

test("'inactive' selects on the employment status column, including NULL", () => {
  const { fields } = resolveFields(["employee_id"], adminActor);
  const { sql } = buildQuery(fields, resolveFilters({ status: "inactive" }));
  assert.match(sql, /new_employee\.status <> 1 OR new_employee\.status IS NULL/);
});
