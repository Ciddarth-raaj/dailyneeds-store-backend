/**
 * Reports — filtering on a selected column.
 *
 *   node --test usecase/employee_report_filters.test.js
 *
 * ================================================== WHAT THIS IS ABOUT =====
 *
 * A report you can build but not narrow is a spreadsheet you narrow by hand.
 * Every column a user may select and see, they may now filter on - with one
 * deliberate exception this file pins, below.
 *
 * The two things worth being careful about, and most of these tests are one
 * or the other:
 *
 *   AUTHORIZATION. A filter is a question, and a question with a count for an
 *   answer is an oracle. So a filter field goes through EXACTLY the check a
 *   selected field goes through - catalogue, enabled, permission - and it is
 *   re-derived on the server for every request. "The UI only offers what you
 *   may use" is not a control; a crafted body is the test.
 *
 *   SQL. No caller string becomes SQL, still. The field key selects a
 *   catalogue entry whose `select` expression this file owns, and the VALUE
 *   is always bound. These tests read the generated SQL and its parameter
 *   list to prove it.
 */
const test = require("node:test");
const assert = require("node:assert");

const resolver = require("./employee_report");
const catalogue = require("../constants/employee_report_catalogue");
const P = require("../constants/hr_permissions");

const admin = { isAdmin: true, permissions: [] };
const plain = { isAdmin: false, permissions: [{ permission_key: P.VIEW_EMPLOYEES }] };
const sensitive = {
  isAdmin: false,
  permissions: [
    { permission_key: P.VIEW_EMPLOYEES },
    { permission_key: P.VIEW_EMPLOYEE_SENSITIVE },
  ],
};

const fieldsFor = (keys, actor = admin) => resolver.resolveFields(keys, actor).fields;
const filtersFor = (raw, actor = admin) => resolver.resolveFilters(raw, actor);

/* ==================== 13-14. selected column = eligible filter =========== */

test("EVERY FIELD A USER MAY SEE IS FILTERABLE, EXCEPT THE MASKED TWO", () => {
  const seen = resolver.discoverFields(sensitive);
  const notFilterable = seen.filter((f) => !f.filter).map((f) => f.key);

  // The exception, and the reason it is one: both are exported MASKED or
  // PARTIAL. A filter on either compares the STORED value, so a permitted
  // user could ask "does anybody's account end 4321" and, by counting
  // results, walk the number. A masked column that can be filtered is not
  // masked.
  assert.deepStrictEqual(notFilterable.sort(), ["aadhaar_last4", "account_no"]);

  // Everything else offers a control.
  for (const f of seen.filter((x) => x.filter)) {
    assert.ok(
      ["id", "text", "enum", "master", "date"].includes(f.filter.type),
      `${f.key} has an unknown control type`
    );
    if (f.filter.type === "enum") {
      assert.ok(Array.isArray(f.filter.options) && f.filter.options.length, `${f.key} needs options`);
    }
  }
});

test("a field the user may NOT see is neither offered nor accepted", () => {
  // Not offered...
  const offered = resolver.discoverFields(plain).map((f) => f.key);
  assert.ok(!offered.includes("bank_name"), "bank_name must not be offered without the permission");

  // ...and not accepted, which is the half that matters.
  assert.throws(
    () => filtersFor({ field_filters: [{ field: "bank_name", value: "State Bank of India" }] }, plain),
    (err) => err.code === "UNKNOWN_FILTER_FIELD"
  );
});

test("an unfilterable-but-visible field is refused as a filter", () => {
  // `account_no` IS selectable by this actor. It is still not filterable, and
  // the refusal is the same one an unknown field gets.
  assert.ok(resolver.discoverFields(sensitive).some((f) => f.key === "account_no"));
  assert.throws(
    () => filtersFor({ field_filters: [{ field: "account_no", value: "1234" }] }, sensitive),
    (err) => err.code === "UNKNOWN_FILTER_FIELD"
  );
});

test("an unknown or forbidden key is refused, never interpolated", () => {
  for (const field of [
    "no_such_field",
    "salary",
    "aadhaar_card_no",
    "employee_name; DROP TABLE new_employee",
    "1=1",
  ]) {
    assert.throws(
      () => filtersFor({ field_filters: [{ field, value: "x" }] }, admin),
      (err) => err.code === "UNKNOWN_FILTER_FIELD",
      field
    );
  }
});

/* ==================== 15-17. the Bank/KYC acceptance case =============== */

test("BANK VERIFICATION STATUS = VERIFIED AND BANK NAME = SBI, AS ONE QUERY", () => {
  // The scenario named as the acceptance test, end to end through the
  // resolver: the selected columns of the Bank/KYC report, both filters, and
  // the SQL that comes out.
  const keys = [
    "employee_id",
    "employee_name",
    "outlet",
    "department",
    "designation",
    "bank_status",
    "bank_name",
  ];
  const fields = fieldsFor(keys, sensitive);
  const filters = filtersFor(
    {
      status: "active",
      field_filters: [
        { field: "bank_status", value: "VERIFIED" },
        { field: "bank_name", value: "State Bank of India" },
      ],
    },
    sensitive
  );

  const { sql, params } = resolver.buildQuery(fields, filters, { actor: sensitive });

  // AND, not OR. Both predicates are present and joined by AND.
  assert.match(sql, /COALESCE\(employee_bank_verification\.status, 'NOT_PROVIDED'\) = \?/);
  assert.match(sql, /new_employee\.bank_name LIKE \?/);
  assert.ok(!/\bOR\b/.test(sql.slice(sql.indexOf("WHERE"))), "filters must never be OR-ed");

  // Values are bound, in order, and never in the SQL text.
  assert.ok(params.includes("VERIFIED"));
  assert.ok(params.includes("%State Bank of India%"));
  assert.ok(!sql.includes("VERIFIED"), "no filter value may appear in the SQL");
  assert.ok(!sql.includes("State Bank"), "no filter value may appear in the SQL");

  // The columns come out in the order asked for - that IS the column order.
  const selected = [...sql.matchAll(/AS c(\d+)/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(selected, [0, 1, 2, 3, 4, 5, 6]);
});

test("the count and the page apply the same filters", () => {
  // The invariant the whole file rests on: one builder, so a filtered count
  // cannot disagree with the filtered rows or with an export.
  const fields = fieldsFor(["employee_id", "bank_status"], sensitive);
  const filters = filtersFor(
    { field_filters: [{ field: "bank_status", value: "VERIFIED" }] },
    sensitive
  );

  const count = resolver.buildQuery(fields, filters, { count: true, actor: sensitive });
  const page = resolver.buildQuery(fields, filters, { limit: 25, offset: 0, actor: sensitive });

  const whereOf = (s) => s.slice(s.indexOf("WHERE"), s.indexOf("ORDER BY") === -1 ? undefined : s.indexOf("ORDER BY"));
  assert.strictEqual(whereOf(count.sql).trim(), whereOf(page.sql).trim());
  // The page adds only its LIMIT/OFFSET parameters.
  assert.deepStrictEqual(page.params.slice(0, count.params.length), count.params);
});

test("A FILTERED COLUMN THAT IS NOT SELECTED STILL BRINGS ITS JOIN", () => {
  // Filtering by Bank Verification Status without showing the column needs
  // the table it lives in. Without this the query is invalid SQL rather than
  // wrong - but it is exactly the kind of thing that is missed.
  const fields = fieldsFor(["employee_id", "employee_name"], sensitive);
  const filters = filtersFor(
    { field_filters: [{ field: "bank_status", value: "VERIFIED" }] },
    sensitive
  );
  const { sql } = resolver.buildQuery(fields, filters, { actor: sensitive });
  assert.match(sql, /LEFT JOIN employee_bank_verification/);
});

test("a join is added once even when a field is both selected and filtered", () => {
  const fields = fieldsFor(["employee_id", "bank_status"], sensitive);
  const filters = filtersFor(
    { field_filters: [{ field: "bank_status", value: "VERIFIED" }] },
    sensitive
  );
  const { sql } = resolver.buildQuery(fields, filters, { actor: sensitive });
  assert.strictEqual((sql.match(/LEFT JOIN employee_bank_verification/g) || []).length, 1);
});

/* ==================== 25. no dynamic SQL, whatever the value ============ */

test("A FILTER VALUE IS ALWAYS A BOUND PARAMETER", () => {
  const injections = [
    "' OR 1=1 --",
    "'; DROP TABLE new_employee; --",
    "%",
    "_",
    "\\",
    'x" OR "1"="1',
  ];
  // The property, stated exactly: the SQL TEXT does not depend on the value.
  // Comparing generated SQL across wildly different values is a stronger
  // check than searching for a substring - `_` and `%` occur in legitimate
  // SQL, so a substring search proves nothing about them.
  const sqlFor = (value) => {
    const fields = fieldsFor(["employee_id"], sensitive);
    const filters = filtersFor({ field_filters: [{ field: "bank_name", value }] }, sensitive);
    return resolver.buildQuery(fields, filters, { actor: sensitive });
  };

  const baseline = sqlFor("State Bank of India");
  for (const value of injections) {
    const { sql, params } = sqlFor(value);
    assert.strictEqual(sql, baseline.sql, `the SQL must not change for: ${value}`);
    assert.ok(
      params.some((p) => typeof p === "string" && p.includes(value)),
      "the value must travel as a parameter instead"
    );
    // Note what this does and does not claim. The value cannot alter SQL
    // STRUCTURE - that is the security property. Inside the bound LIKE
    // pattern, a `%` or `_` the user typed still behaves as a LIKE wildcard,
    // exactly as it always has in the existing search box. That is a matching
    // nicety, not an injection path, and it is not silently "escaped" here.
    assert.ok(params.includes(`%${value}%`));
  }
});

test("the SQL structure comes from the catalogue, not from the request", () => {
  // Every predicate this builds is `<catalogue expression> <fixed operator> ?`.
  const fields = fieldsFor(["employee_id"], sensitive);
  const filters = filtersFor(
    {
      field_filters: [
        { field: "employee_name", value: "Ravi" },
        { field: "gender", value: "Male" },
        { field: "employee_id", value: "412" },
        { field: "date_of_joining", from: "2024-01-01", to: "2024-12-31" },
      ],
    },
    sensitive
  );
  const { sql, params } = resolver.buildQuery(fields, filters, { actor: sensitive });

  assert.match(sql, /new_employee\.employee_name LIKE \?/);
  assert.match(sql, /new_employee\.gender = \?/);
  assert.match(sql, /new_employee\.employee_id = \?/);
  assert.match(sql, /new_employee\.date_of_joining >= \?/);
  assert.match(sql, /new_employee\.date_of_joining <= \?/);
  for (const v of ["%Ravi%", "Male", "412", "2024-01-01", "2024-12-31"]) {
    assert.ok(params.includes(v), `${v} must be bound`);
  }
});

/* ==================== value validation ================================== */

test("an enum value not in the catalogue's own list is refused", () => {
  // The list is ours, so an unlisted value is a crafted request.
  assert.throws(
    () => filtersFor({ field_filters: [{ field: "bank_status", value: "TOTALLY_FINE" }] }, sensitive),
    (err) => err.code === "BAD_FILTER_VALUE"
  );
  // And a real one is accepted.
  for (const opt of catalogue.BANK_STATUS_OPTIONS) {
    const f = filtersFor({ field_filters: [{ field: "bank_status", value: opt.value }] }, sensitive);
    assert.strictEqual(f.field_filters.length, 1);
  }
});

test("a date must be a date, and a master filter must be positive ids", () => {
  assert.throws(
    () => filtersFor({ field_filters: [{ field: "date_of_joining", from: "01/01/2024" }] }, admin),
    (err) => err.code === "BAD_FILTER_VALUE"
  );
  assert.throws(
    () => filtersFor({ field_filters: [{ field: "outlet", value: [-1] }] }, admin),
    (err) => err.code === "BAD_FILTER_VALUE"
  );
});

test("an empty filter is not a filter", () => {
  // Clearing a control must not become `WHERE x LIKE '%%'`, which would still
  // exclude NULLs and quietly change the result.
  const filters = filtersFor(
    {
      field_filters: [
        { field: "bank_name", value: "   " },
        { field: "bank_status", value: "" },
        { field: "date_of_joining", from: "", to: "" },
      ],
    },
    sensitive
  );
  assert.strictEqual(filters.field_filters.length, 0);

  const { sql } = resolver.buildQuery(fieldsFor(["employee_id"], admin), filters, { actor: admin });
  assert.ok(!sql.includes("LIKE"), "an empty value must add no predicate");
});

/* ==================== the four that ride an existing key ================ */

test("OUTLET, DEPARTMENT, DESIGNATION AND STATUS DO NOT GROW A SECOND MECHANISM", () => {
  // Expressed as a field filter, they land on the filter keys the report API
  // already had - so the caller's own outlet scope keeps being applied in
  // exactly one place, rather than once for each way of asking.
  const filters = filtersFor(
    {
      field_filters: [
        { field: "outlet", value: [2, 3] },
        { field: "department", value: [7] },
        { field: "designation", value: [15] },
        { field: "employment_status", value: "inactive" },
      ],
    },
    admin
  );

  assert.deepStrictEqual(filters.outlet_ids, [2, 3]);
  assert.deepStrictEqual(filters.department_ids, [7]);
  assert.deepStrictEqual(filters.designation_ids, [15]);
  assert.strictEqual(filters.status, "inactive");
  // And none of them becomes an extra predicate of its own.
  assert.strictEqual(filters.field_filters.length, 0);

  const { sql } = resolver.buildQuery(fieldsFor(["employee_id"], admin), filters, { actor: admin });
  assert.strictEqual((sql.match(/department_id IN \(\?\)/g) || []).length, 1);
});

test("the existing filter shape still works unchanged", () => {
  // Nothing about the old request body changes: a caller sending only the
  // original keys gets exactly what it always did.
  const filters = filtersFor(
    { status: "all", outlet_ids: [4], department_ids: [1], designation_ids: [9], search: "Ravi" },
    admin
  );
  assert.strictEqual(filters.status, "all");
  assert.deepStrictEqual(filters.outlet_ids, [4]);
  assert.strictEqual(filters.search, "Ravi");
  assert.deepStrictEqual(filters.field_filters, []);
});

/* ==================== what gets stored ================================== */

test("A SAVED REPORT STORES FIELD KEYS AND VALUES, NEVER THE CATALOGUE", () => {
  // The resolver works with catalogue ENTRIES - they carry the SQL. What a
  // template stores is an instruction, so it re-reads the catalogue on every
  // run instead of carrying a stale copy of it.
  const filters = filtersFor(
    {
      status: "active",
      field_filters: [
        { field: "bank_status", value: "VERIFIED" },
        { field: "bank_name", value: "State Bank of India" },
        { field: "date_of_joining", from: "2024-01-01", to: "" },
      ],
    },
    sensitive
  );

  const stored = resolver.persistableFilters(filters);
  const json = JSON.stringify(stored);

  assert.deepStrictEqual(stored.field_filters, [
    { field: "bank_status", value: "VERIFIED" },
    { field: "bank_name", value: "State Bank of India" },
    { field: "date_of_joining", from: "2024-01-01", to: "" },
  ]);
  // Precise markers: "join" alone would match `date_of_joining`, which is a
  // field key and belongs in a stored template.
  for (const leaked of ['"select"', "new_employee", "COALESCE", '"join"', '"permission"', "transform"]) {
    assert.ok(!json.includes(leaked), `a stored template must not contain ${leaked}`);
  }
  // And it round-trips: what was stored resolves back to the same filters.
  const reread = filtersFor(stored, sensitive);
  assert.strictEqual(reread.field_filters.length, 3, "all three survive the round trip");
  assert.deepStrictEqual(
    reread.field_filters.map((f) => f.field.key),
    ["bank_status", "bank_name", "date_of_joining"]
  );
  assert.strictEqual(reread.status, "active");
});

test("a saved filter the reader may no longer use is dropped, and says it widens", () => {
  // A template is an instruction, not a promise that its author's permissions
  // are still yours. Dropping a filter returns MORE rows than the report
  // asked for, so the warning is marked as widening - which is what the
  // export path already makes acknowledgeable.
  const saved = { field_filters: [{ field: "bank_name", value: "State Bank of India" }] };

  const strict = () => resolver.resolveFieldFilters(saved.field_filters, plain, "strict");
  assert.throws(strict, (err) => err.code === "UNKNOWN_FILTER_FIELD");

  const reconciled = resolver.resolveFieldFilters(saved.field_filters, plain, "reconcile");
  assert.strictEqual(reconciled.field_filters.length, 0);
  assert.strictEqual(reconciled.warnings.length, 1);
  assert.strictEqual(reconciled.warnings[0].type, "filter_unavailable");
  assert.strictEqual(reconciled.warnings[0].widens_result_set, true);
});

/* ==================== limits ============================================ */

test("the number of filters is capped", () => {
  const many = Array.from({ length: 200 }, () => ({ field: "employee_name", value: "x" }));
  assert.throws(
    () => filtersFor({ field_filters: many }, admin),
    (err) => err.code === "TOO_MANY_FILTERS"
  );
});

test("the same field twice is one filter, not two predicates", () => {
  const filters = filtersFor(
    {
      field_filters: [
        { field: "bank_name", value: "State Bank of India" },
        { field: "bank_name", value: "HDFC" },
      ],
    },
    sensitive
  );
  assert.strictEqual(filters.field_filters.length, 1);
  assert.strictEqual(filters.field_filters[0].value, "State Bank of India");
});
