/**
 * The employee-directory population, extracted without changing it.
 *
 *   node --test repository/employee_scope.test.js
 *
 * This is a REFACTOR test before it is a feature test. The clause and the
 * parameter order below are transcribed from what `repository/employee.js#get`
 * builds inline in production, so if the move altered the population even
 * slightly - a reordered parameter, a dropped condition - this fails rather
 * than the HR directory quietly showing a different set of people.
 *
 * The reference is production AFTER the `1f7c11a` hotfix: the resigned-name
 * exclusion is omitted entirely when there is nothing to exclude, rather than
 * written as `(... NOT IN (?) OR ? IS NULL)` with the same array bound twice -
 * a shape MySQL rejects at two or more names. `employee_directory_filter.test.js`
 * pins that defect specifically, against rendered SQL; this file pins the
 * clause and the separation of concepts.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  buildEmployeeScope,
  buildReportAccessScope,
  accessScope,
  directoryPopulation,
  lookupFilters,
} = require("./employee_scope");

/** Whitespace differs between a template literal and a joined string. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

/* ===================================== the clause, exactly as it is ===== */
test("with no resignations and no filters, there is no clause at all", () => {
  const { where, params } = buildEmployeeScope([], {});
  // Not a wide predicate - no predicate. A bare `WHERE` is a syntax error, so
  // the clause has to be empty rather than trivially true.
  assert.strictEqual(norm(where), "");
  assert.deepStrictEqual(params, []);
});

test("resigned names are excluded, bound once", () => {
  const { where, params } = buildEmployeeScope(["Ramesh Kumar", "Suresh"], {});
  assert.strictEqual(norm(where), "WHERE new_employee.employee_name NOT IN (?)");
  assert.deepStrictEqual(params, [["Ramesh Kumar", "Suresh"]]);
});

test("a store filter stands alone when nobody has resigned", () => {
  const { where, params } = buildEmployeeScope([], { store_ids: [2, 3] });
  assert.strictEqual(norm(where), "WHERE new_employee.store_id IN (?)");
  assert.deepStrictEqual(params, [[2, 3]]);
});

test("a designation filter likewise", () => {
  const { where, params } = buildEmployeeScope([], { designation_ids: [15] });
  assert.strictEqual(norm(where), "WHERE new_employee.designation_id IN (?)");
  assert.deepStrictEqual(params, [[15]]);
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
    "WHERE new_employee.employee_name NOT IN (?) " +
      "AND new_employee.store_id IN (?) AND new_employee.designation_id IN (?)"
  );
  assert.deepStrictEqual(params, [["Gone"], [2], [15]]);
});

test("empty or absent filter arrays add nothing", () => {
  for (const filters of [{}, null, undefined, { store_ids: [] }, { designation_ids: [] }]) {
    const { where, params } = buildEmployeeScope([], filters);
    assert.strictEqual(norm(where), "", JSON.stringify(filters));
    assert.deepStrictEqual(params, []);
  }
});

test("a non-array resignation list is tolerated, as the original was", () => {
  for (const odd of [undefined, null, "Ada", 7]) {
    const { where, params } = buildEmployeeScope(odd, {});
    assert.strictEqual(norm(where), "");
    assert.deepStrictEqual(params, []);
  }
});

test("EVERY PLACEHOLDER HAS EXACTLY ONE PARAMETER", () => {
  // The pre-hotfix clause bound one logical value to two placeholders, which
  // is what let the mismatch hide until the second resignation.
  const cases = [
    [[], {}],
    [["A"], {}],
    [["A", "B"], {}],
    [["A", "B", "C"], { store_ids: [1] }],
    [[], { store_ids: [1], designation_ids: [2] }],
    [["A"], { store_ids: [1], designation_ids: [2] }],
  ];
  for (const [names, filters] of cases) {
    const { where, params } = buildEmployeeScope(names, filters);
    assert.strictEqual(
      params.length,
      (where.match(/\?/g) || []).length,
      `${names.length} name(s), filters ${JSON.stringify(filters)}`
    );
  }
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
  const { where, params } = buildEmployeeScope(["'; DROP TABLE new_employee; --"], {
    store_ids: ["2 OR 1=1"],
  });
  assert.ok(!where.includes("DROP"), "no value is interpolated into SQL");
  assert.ok(!where.includes("1=1"));
  assert.strictEqual((where.match(/\?/g) || []).length, 2, "values travel as placeholders");
  assert.strictEqual(params.length, 2);
});

/* ============== access scope and directory population are separate ====== */
test("ACCESS SCOPE AND DIRECTORY POPULATION ARE DIFFERENT CONCEPTS", () => {
  // Authorization: which rows the caller may reach. Empty today, and that is
  // a finding rather than an omission - there is no per-actor row restriction
  // on the HR directory.
  assert.deepStrictEqual(accessScope({ userId: 21, isAdmin: false }), {
    conditions: [],
    params: [],
  });
  assert.deepStrictEqual(accessScope(null), { conditions: [], params: [] });

  // Population: a legacy rule belonging to one screen.
  const pop = directoryPopulation(["Gone"]);
  assert.deepStrictEqual(pop.conditions, ["new_employee.employee_name NOT IN (?)"]);
  assert.deepStrictEqual(pop.params, [["Gone"]]);

  // And nothing to exclude means no condition, not a true one.
  assert.deepStrictEqual(directoryPopulation([]), { conditions: [], params: [] });
});

test("THE POPULATION RULE IS STILL KEYED BY NAME, DELIBERATELY", () => {
  // Pre-existing debt, recorded rather than fixed here: re-keying `resignation`
  // by the permanent `employee_id` is a data migration and a behaviour change.
  const { conditions } = directoryPopulation(["Gone"]);
  assert.match(conditions[0], /employee_name/);
  assert.ok(!/employee_id/.test(conditions[0]));
});

test("lookup filters are narrowing, and belong to neither concept", () => {
  assert.deepStrictEqual(lookupFilters({}), { conditions: [], params: [] });
  const both = lookupFilters({ store_ids: [2], designation_ids: [15] });
  assert.deepStrictEqual(both.conditions, [
    "new_employee.store_id IN (?)",
    "new_employee.designation_id IN (?)",
  ]);
  assert.deepStrictEqual(both.params, [[2], [15]]);
});

test("A REPORT GETS AUTHORIZATION BUT NOT THE RESIGNATION EXCLUSION", () => {
  // The whole point of the separation. If the report inherited the
  // directory's population rule, a "Resigned" report would return nothing
  // and "All" would quietly mean "all except the ones who left".
  const scope = buildReportAccessScope({ store_ids: [2] }, { userId: 21 });
  assert.deepStrictEqual(scope.conditions, ["new_employee.store_id IN (?)"]);
  assert.deepStrictEqual(scope.params, [[2]]);

  const joined = scope.conditions.join(" ");
  assert.ok(!/employee_name NOT IN/.test(joined), "no resignation exclusion");
  assert.ok(!/resignation/i.test(joined));
});

test("an unfiltered report constrains nothing at all", () => {
  const scope = buildReportAccessScope({}, null);
  assert.deepStrictEqual(scope, { conditions: [], params: [] });
});

test("THE DIRECTORY STILL COMPOSES BOTH", () => {
  const { where, params } = buildEmployeeScope(["Gone"], {
    store_ids: [2],
    designation_ids: [15],
  });
  assert.strictEqual(
    norm(where),
    "WHERE new_employee.employee_name NOT IN (?) " +
      "AND new_employee.store_id IN (?) AND new_employee.designation_id IN (?)"
  );
  assert.deepStrictEqual(params, [["Gone"], [2], [15]]);
});
