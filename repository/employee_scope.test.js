/**
 * The employee-directory population, extracted without changing it.
 *
 *   node --test repository/employee_scope.test.js
 *
 * This is a REFACTOR test before it is a feature test. The clause and the
 * parameter order below are transcribed from what `repository/employee.js#get`
 * built inline before the extraction, so if the move altered the population
 * even slightly - a reordered parameter, a dropped arm of the resignation
 * predicate - this fails rather than the HR directory quietly showing a
 * different set of people.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { buildEmployeeScope } = require("./employee_scope");

/** Whitespace differs between a template literal and a joined string. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

/* ===================================== the clause, exactly as it was ==== */
test("with no resignations and no filters, nobody is excluded", () => {
  const { where, params } = buildEmployeeScope([], {});
  assert.strictEqual(
    norm(where),
    "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL)"
  );
  // Both NULL: `NOT IN (NULL)` is NULL, and the `? IS NULL` arm makes the
  // predicate true. That is how the original made an empty list a no-op.
  assert.deepStrictEqual(params, [null, null]);
});

test("resigned names are excluded, and passed twice in order", () => {
  const { where, params } = buildEmployeeScope(["Ramesh Kumar", "Suresh"], {});
  assert.strictEqual(
    norm(where),
    "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL)"
  );
  assert.deepStrictEqual(params, [
    ["Ramesh Kumar", "Suresh"],
    ["Ramesh Kumar", "Suresh"],
  ]);
});

test("a store filter is ANDed on, after the resignation parameters", () => {
  const { where, params } = buildEmployeeScope([], { store_ids: [2, 3] });
  assert.strictEqual(
    norm(where),
    "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL) AND new_employee.store_id IN (?)"
  );
  assert.deepStrictEqual(params, [null, null, [2, 3]]);
});

test("a designation filter likewise", () => {
  const { where, params } = buildEmployeeScope([], { designation_ids: [15] });
  assert.strictEqual(
    norm(where),
    "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL) AND new_employee.designation_id IN (?)"
  );
  assert.deepStrictEqual(params, [null, null, [15]]);
});

test("BOTH FILTERS KEEP STORE BEFORE DESIGNATION", () => {
  // Parameter order is the contract. Swapping these two would filter stores
  // by designation ids and vice versa - a silently wrong population rather
  // than an error.
  const { where, params } = buildEmployeeScope(["Gone"], {
    store_ids: [2],
    designation_ids: [15],
  });
  assert.strictEqual(
    norm(where),
    "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL) " +
      "AND new_employee.store_id IN (?) AND new_employee.designation_id IN (?)"
  );
  assert.deepStrictEqual(params, [["Gone"], ["Gone"], [2], [15]]);
});

test("empty or absent filter arrays add nothing", () => {
  for (const filters of [{}, null, undefined, { store_ids: [] }, { designation_ids: [] }]) {
    const { where, params } = buildEmployeeScope([], filters);
    assert.strictEqual(
      norm(where),
      "WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL)",
      JSON.stringify(filters)
    );
    assert.deepStrictEqual(params, [null, null]);
  }
});

test("a non-array resignation list is tolerated, as the original was", () => {
  const { params } = buildEmployeeScope(undefined, {});
  assert.deepStrictEqual(params, [null, null]);
});

/* ============================== the rule is stated once, not twice ====== */
test("THE DIRECTORY QUERY USES THE SHARED SCOPE RATHER THAN ITS OWN CLAUSE", () => {
  const src = fs.readFileSync(path.join(__dirname, "employee.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /buildEmployeeScope\(\s*resignation,\s*filters\s*\)/);
  // And it no longer builds the predicate itself: exactly one occurrence of
  // the resignation clause remains in the repository layer, in employee_scope.
  const inline = code.match(/employee_name NOT IN \(\?\)/g) || [];
  assert.strictEqual(inline.length, 0, "the clause must live only in employee_scope.js");
});

test("no caller-supplied string can reach the clause", () => {
  // Filters contribute bound parameters only; the SQL text is fixed.
  const { where } = buildEmployeeScope(["'; DROP TABLE new_employee; --"], {
    store_ids: ["2 OR 1=1"],
  });
  assert.ok(!where.includes("DROP"), "no value is interpolated into SQL");
  assert.ok(!where.includes("1=1"));
  assert.strictEqual((where.match(/\?/g) || []).length, 3, "values travel as placeholders");
});
