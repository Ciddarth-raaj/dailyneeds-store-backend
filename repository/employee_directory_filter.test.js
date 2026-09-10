/**
 * The employee directory's resigned-name exclusion.
 *
 *   node --test repository/employee_directory_filter.test.js
 *
 * THE DEFECT THIS PINS. The exclusion used to be written as
 *
 *     (new_employee.employee_name NOT IN (?) OR ? IS NULL)
 *
 * with the SAME array bound to both placeholders. The `mysql` driver expands
 * an array into a comma list, so with two resigned names the second arm became
 *
 *     'Ada', 'Grace' IS NULL
 *
 * which MySQL rejects: ER_OPERAND_COLUMNS (1241). It survived in production
 * only because the list was empty or held a single name - `NULL IS NULL` and
 * `'Ada' IS NULL` are both legal - so the directory worked until the SECOND
 * resignation, at which point every load of the employee list returned a 500.
 *
 * C2's Resign action writes a row to `resignation` on every use, so this was
 * two resignations away from breaking the HR employee list.
 *
 * These tests build the query the way the driver actually renders it, rather
 * than inspecting the template, because the template looked fine.
 */
const test = require("node:test");
const assert = require("node:assert");
const mysql = require("mysql");

const buildRepo = require("./employee");

/**
 * Capture the SQL and parameters `get()` would send, without a database.
 * `get` never resolves here - the fake driver just records the call.
 */
function capture(resignation, filters) {
  let captured = null;
  const repo = buildRepo({
    query: (sql, params) => {
      captured = { sql, params };
    },
  });
  repo.get(resignation, filters).catch(() => {});
  assert.ok(captured, "the repository must have issued a query");
  return captured;
}

/** What the driver actually puts on the wire. */
const rendered = (resignation, filters) => {
  const { sql, params } = capture(resignation, filters);
  return mysql.format(sql, params).replace(/\s+/g, " ").trim();
};

/* ================================================= the regression itself */
test("NO RESIGNATIONS: the exclusion is absent entirely", () => {
  const sql = rendered([], {});
  assert.ok(!/employee_name NOT IN/.test(sql), "nothing to exclude, so no predicate");
  // And with no filters either, there is no WHERE at all - an empty WHERE is a
  // syntax error, not a wide query.
  assert.ok(!/\bWHERE\b/.test(sql), sql.slice(0, 200));
});

test("ONE RESIGNATION: excluded, with a single bound list", () => {
  const sql = rendered(["Ada Lovelace"], {});
  assert.match(sql, /WHERE new_employee\.employee_name NOT IN \('Ada Lovelace'\)/);
  assert.ok(!/IS NULL/.test(sql), "the broken second arm is gone");
});

test("TWO RESIGNATIONS NO LONGER PRODUCE ER_OPERAND_COLUMNS", () => {
  // The exact case that broke: two names, one placeholder.
  const sql = rendered(["Ada Lovelace", "Grace Hopper"], {});
  assert.match(
    sql,
    /WHERE new_employee\.employee_name NOT IN \('Ada Lovelace', 'Grace Hopper'\)/
  );
  // The shape that MySQL rejected must not appear anywhere.
  assert.ok(!/'Ada Lovelace', 'Grace Hopper' IS NULL/.test(sql));
  assert.ok(!/IS NULL/.test(sql));
});

test("THREE OR MORE RESIGNATIONS behave the same way", () => {
  const names = ["Ada", "Grace", "Katherine", "Dorothy"];
  const sql = rendered(names, {});
  assert.match(sql, /NOT IN \('Ada', 'Grace', 'Katherine', 'Dorothy'\)/);
  assert.ok(!/IS NULL/.test(sql));
});

test("the parameter count matches the placeholder count at every size", () => {
  // The original bound the list twice for one logical value, which is what
  // let the mismatch hide.
  for (const names of [[], ["A"], ["A", "B"], ["A", "B", "C"]]) {
    const { sql, params } = capture(names, {});
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.strictEqual(
      params.length,
      placeholders,
      `${names.length} name(s): ${params.length} params for ${placeholders} placeholders`
    );
  }
});

/* ========================================= the filters are still intact */
test("the store and designation filters are unchanged, and still in order", () => {
  const sql = rendered(["Ada"], { store_ids: [2, 3], designation_ids: [15] });
  assert.match(
    sql,
    /WHERE new_employee\.employee_name NOT IN \('Ada'\) AND new_employee\.store_id IN \(2, 3\) AND new_employee\.designation_id IN \(15\)/
  );
});

test("filters work with no resignations recorded", () => {
  const sql = rendered([], { store_ids: [2] });
  assert.match(sql, /WHERE new_employee\.store_id IN \(2\)/);
  assert.ok(!/employee_name NOT IN/.test(sql));
});

test("a non-array resignation list is tolerated, as before", () => {
  for (const odd of [undefined, null]) {
    const sql = rendered(odd, {});
    assert.ok(!/employee_name NOT IN/.test(sql));
  }
});

/* ============================ the legacy name matching is NOT redesigned */
test("MATCHING IS STILL BY employee_name, deliberately", () => {
  // The name-keyed weakness of `resignation` is pre-existing debt: two people
  // who share a name share the exclusion. Fixing that means keying the table
  // by the permanent employee_id, which is a data migration and a behaviour
  // change - not something to slip into a hotfix for a crash.
  const sql = rendered(["Ada"], {});
  assert.match(sql, /new_employee\.employee_name NOT IN/);
  assert.ok(!/employee_id NOT IN/.test(sql), "the hotfix does not re-key the exclusion");
});
