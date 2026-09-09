/**
 * Reports — the template repository.
 *
 *   node --test repository/report_template.test.js
 *
 * A fake connection captures the SQL and parameters, so these tests assert the
 * statements this layer actually issues. Three of them pin guarantees that are
 * enforced in the WHERE clause rather than in code above it, which is the
 * point: a rule in SQL cannot be forgotten by a later caller.
 */
const test = require("node:test");
const assert = require("node:assert");
const mysql = require("mysql");

const buildRepo = require("./report_template");
const { parseJson, present } = require("./report_template");

/** Capture what the repository sends, and answer with `rows`. */
function fake(rows = []) {
  const calls = [];
  const db = {
    query: (sql, params, cb) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rows);
    },
  };
  return { repo: buildRepo(db), calls };
}

const rendered = (call) => mysql.format(call.sql, call.params);

/* ============================================== visibility is in the SQL */

test("SOMEBODY ELSE'S PERSONAL TEMPLATE IS NEVER SELECTED", async () => {
  // Not "loaded and then hidden" - never fetched. A rule applied after the
  // rows arrive is one a later change to the presentation can drop.
  const { repo, calls } = fake();
  await repo.listVisible("EMPLOYEE_MASTER", { userId: 21 });

  const sql = rendered(calls[0]);
  assert.match(sql, /WHERE dataset_key = 'EMPLOYEE_MASTER'/);
  assert.match(sql, /is_system = 1 OR is_shared = 1 OR owner_user_id <=> 21/);
});

test("an actor with no user id matches no personal template", async () => {
  // `<=> NULL` is null-safe equality: it matches only rows whose owner is
  // NULL, and those are system templates, which the first arm already allows.
  // A plain `=` would have matched nothing at all, including for real users.
  const { repo, calls } = fake();
  await repo.listVisible("EMPLOYEE_MASTER", null);
  assert.match(rendered(calls[0]), /owner_user_id <=> NULL/);
});

test("findById deliberately has NO visibility predicate", async () => {
  // The usecase needs to tell "no such template" from "not yours" - and then
  // answer 404 to both. That decision belongs above this layer.
  const { repo, calls } = fake();
  await repo.findById(7);
  assert.match(rendered(calls[0]), /WHERE template_id = 7 LIMIT 1/);
  assert.ok(!/owner_user_id/.test(calls[0].sql));
});

/* ============================================== system templates are safe */

test("A SEEDED TEMPLATE CANNOT BE EDITED OR DELETED THROUGH THIS LAYER", async () => {
  const { repo, calls } = fake({ affectedRows: 0 });

  await repo.update(10, { template_name: "x", field_keys: [], filters: {} });
  await repo.remove(10);

  for (const call of calls) {
    assert.match(call.sql, /is_system = 0/, call.sql.slice(0, 80));
  }
});

test("create cannot mint a system template, whatever it is passed", async () => {
  const { repo, calls } = fake({ insertId: 1 });
  await repo.create({
    template_name: "Sneaky",
    dataset_key: "EMPLOYEE_MASTER",
    field_keys: ["employee_id"],
    filters: {},
    owner_user_id: 21,
    is_shared: 1,
    is_system: 1,
  });

  // `is_system` is a literal 0 in the statement, not a bound value.
  assert.match(calls[0].sql, /is_system\)\s*VALUES \(\?, \?, \?, \?, \?, \?, 0\)/);
});

test("an update cannot change a template's owner", async () => {
  const { repo, calls } = fake({ affectedRows: 1 });
  await repo.update(5, { template_name: "x", field_keys: [], filters: {}, is_shared: 0 });
  assert.ok(!/owner_user_id/.test(calls[0].sql), "ownership is not editable");
});

/* ============================================== JSON in and back out ==== */

test("field order survives a round trip, because order IS the column order", () => {
  const keys = ["designation", "employee_id", "outlet", "employee_name"];
  const row = present({
    template_id: "3",
    template_name: "T",
    dataset_key: "EMPLOYEE_MASTER",
    field_keys: JSON.stringify(keys),
    filters: JSON.stringify({ status: "active" }),
    owner_user_id: "21",
    is_shared: "0",
    is_system: "0",
  });
  assert.deepStrictEqual(row.field_keys, keys);
  assert.deepStrictEqual(row.filters, { status: "active" });
  assert.strictEqual(row.template_id, 3);
  assert.strictEqual(row.owner_user_id, 21);
});

test("the driver's parsed-object form and its string form both work", () => {
  // MySQL 8 hands back an object; some configurations hand back a string.
  assert.deepStrictEqual(parseJson(["a"], []), ["a"]);
  assert.deepStrictEqual(parseJson('["a"]', []), ["a"]);
  assert.deepStrictEqual(parseJson(null, []), []);
  // Corrupt JSON is not fatal: the template reconciles to nothing usable and
  // the caller is told, rather than the whole Reports list failing to load.
  assert.deepStrictEqual(parseJson("{not json", []), []);
});

test("values are bound as JSON text, never concatenated", async () => {
  const { repo, calls } = fake({ insertId: 1 });
  await repo.create({
    template_name: "T",
    dataset_key: "EMPLOYEE_MASTER",
    field_keys: ["employee_id"],
    filters: { search: "'; DROP TABLE report_template; --" },
    owner_user_id: 21,
    is_shared: 0,
  });
  assert.ok(!/DROP/.test(calls[0].sql));
  assert.ok(rendered(calls[0]).includes("DROP"), "the value is present, but quoted");
});

/* ============================================== the audit records shape = */

test("THE AUDIT INSERT HAS NO COLUMN FOR A VALUE", async () => {
  const { repo, calls } = fake({ insertId: 1 });
  await repo.logExport({
    dataset_key: "EMPLOYEE_MASTER",
    user_id: 21,
    employee_id: 631,
    field_keys: ["pan_no"],
    filters: { status: "active", search_used: true },
    row_count: 216,
    format: "xlsx",
    sensitive_fields_included: true,
    template_id: null,
  });

  const sql = calls[0].sql;
  for (const forbidden of ["employee_name", "pan_no", "account_no", "aadhaar", "salary", "mobile"]) {
    assert.ok(!new RegExp(forbidden, "i").test(sql), `audit insert names ${forbidden}`);
  }
  assert.match(sql, /row_count/);
  assert.match(sql, /sensitive_fields_included/);
});

/* ============================================== lookup reconciliation === */

test("the outlet lookup uses is_active, and the masters use status", async () => {
  // `outlets` spells it differently from `department` and `designation`.
  // Getting it wrong would mark every outlet inactive and flag every saved
  // filter, which reads as a bug in reconciliation rather than in a column
  // name.
  const cases = [
    ["outlet", /SELECT outlet_id AS id, is_active AS active FROM outlets/],
    ["department", /SELECT department_id AS id, status AS active FROM department/],
    ["designation", /SELECT designation_id AS id, status AS active FROM designation/],
  ];
  for (const [kind, expected] of cases) {
    const { repo, calls } = fake([]);
    await repo.resolveLookupIds(kind, [1, 2]);
    assert.match(calls[0].sql, expected, kind);
  }
});

test("an unknown lookup kind is rejected rather than interpolated", async () => {
  const { repo } = fake([]);
  await assert.rejects(
    () => repo.resolveLookupIds("new_employee; DROP TABLE outlets", [1]),
    /unknown lookup/
  );
});

test("no ids means no query at all", async () => {
  const { repo, calls } = fake([]);
  const result = await repo.resolveLookupIds("outlet", []);
  assert.strictEqual(calls.length, 0, "an empty IN () is a syntax error, so do not ask");
  assert.strictEqual(result.resolvable.size, 0);
});

test("A NULL status counts as ACTIVE, not as inactive", async () => {
  // Several master rows predate the column. Reading NULL as inactive would
  // flag every old outlet on every saved template.
  const { repo } = fake([
    { id: 1, active: null },
    { id: 2, active: 1 },
    { id: 3, active: 0 },
  ]);
  const { resolvable, active } = await repo.resolveLookupIds("outlet", [1, 2, 3]);

  assert.deepStrictEqual([...resolvable].sort(), [1, 2, 3]);
  assert.deepStrictEqual([...active].sort(), [1, 2]);
});

test("ids are deduplicated and bound as one list", async () => {
  const { repo, calls } = fake([]);
  await repo.resolveLookupIds("outlet", [2, 2, 3, "4", "not a number"]);
  assert.deepStrictEqual(calls[0].params[0], [2, 3, 4]);
});
