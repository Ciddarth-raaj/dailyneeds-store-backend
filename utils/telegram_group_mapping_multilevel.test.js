/**
 * MULTI-LEVEL MAPPING RULES - the matcher, in isolation.
 *
 *   node --test utils/telegram_group_mapping_multilevel.test.js
 *
 * The rules under test:
 *
 *   THE DIMENSIONS COMBINE WITH AND. Every dimension added makes the
 *   population SMALLER. If any of these ever became OR, a rule naming a
 *   designation would silently include that designation company-wide, and
 *   the failure would be a disclosure rather than an error.
 *   0 MEANS UNRESTRICTED, and an employee sitting in no department is
 *   OUTSIDE a rule that names one - not inside it.
 *   THE LEGACY ENCODING STILL DECODES TO THE SAME RULE IT ALWAYS MEANT, so
 *   the migration cannot change who a pre-existing mapping covers.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ruleOf,
  ruleLabel,
  isAllEmployees,
  matchesDimension,
  matchesMapping,
} = require("./telegram_group_mapping");
const { MAPPING_TYPE } = require("../constants/telegram_group_mapping");

const TODAY = "2026-09-16";

/** Outlet 5, department 3, designation 7, employed since 2020. */
const emp = (over = {}) => ({
  employee_id: 1,
  store_id: 5,
  department_id: 3,
  designation_id: 7,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  ...over,
});

const rule = (dims = {}) => ({
  rule_outlet_id: Number(dims.outlet_id || 0),
  rule_department_id: Number(dims.department_id || 0),
  rule_designation_id: Number(dims.designation_id || 0),
});

describe("the three dimensions combine with AND", () => {
  it("all three narrowed: every one must agree", () => {
    const r = rule({ outlet_id: 5, department_id: 3, designation_id: 7 });
    assert.equal(matchesDimension(emp(), r), true);
    assert.equal(matchesDimension(emp({ store_id: 6 }), r), false);
    assert.equal(matchesDimension(emp({ department_id: 4 }), r), false);
    assert.equal(matchesDimension(emp({ designation_id: 8 }), r), false);
  });

  it("is NOT or - matching one dimension is not enough", () => {
    // THE RULE THIS FILE EXISTS FOR. Under OR, "Cashiers at ECR" would
    // include every cashier in the company.
    const r = rule({ outlet_id: 5, designation_id: 7 });
    assert.equal(matchesDimension(emp({ store_id: 99, designation_id: 7 }), r), false);
    assert.equal(matchesDimension(emp({ store_id: 5, designation_id: 99 }), r), false);
  });

  it("each dimension added can only SHRINK the population", () => {
    const people = [
      emp({ employee_id: 1, store_id: 5, department_id: 3, designation_id: 7 }),
      emp({ employee_id: 2, store_id: 5, department_id: 3, designation_id: 8 }),
      emp({ employee_id: 3, store_id: 5, department_id: 4, designation_id: 7 }),
      emp({ employee_id: 4, store_id: 6, department_id: 3, designation_id: 7 }),
    ];
    const count = (dims) => people.filter((p) => matchesDimension(p, rule(dims))).length;

    const nothing = count({});
    const outlet = count({ outlet_id: 5 });
    const outletDept = count({ outlet_id: 5, department_id: 3 });
    const allThree = count({ outlet_id: 5, department_id: 3, designation_id: 7 });

    assert.equal(nothing, 4);
    assert.ok(outlet <= nothing, `${outlet} <= ${nothing}`);
    assert.ok(outletDept <= outlet, `${outletDept} <= ${outlet}`);
    assert.ok(allThree <= outletDept, `${allThree} <= ${outletDept}`);
    assert.deepEqual([nothing, outlet, outletDept, allThree], [4, 3, 2, 1]);
  });

  it("an unrestricted dimension matches everybody on it, including NULL", () => {
    const r = rule({ outlet_id: 5 });
    assert.equal(matchesDimension(emp({ department_id: null, designation_id: null }), r), true);
  });

  it("a NARROWED dimension excludes an employee who has none", () => {
    // They are in no department, so they are not in the one the rule names.
    // Treating NULL as a wildcard would put unassigned staff in every group.
    assert.equal(matchesDimension(emp({ department_id: null }), rule({ department_id: 3 })), false);
    assert.equal(matchesDimension(emp({ store_id: undefined }), rule({ outlet_id: 5 })), false);
  });

  it("nothing narrowed matches everybody - that IS All Employees", () => {
    assert.equal(matchesDimension(emp(), rule({})), true);
    assert.equal(
      matchesDimension(emp({ store_id: null, department_id: null, designation_id: null }), rule({})),
      true
    );
    assert.equal(isAllEmployees(rule({})), true);
    assert.equal(isAllEmployees(rule({ outlet_id: 5 })), false);
  });

  it("employment is still a SECOND question the dimensions cannot answer", () => {
    const r = rule({ outlet_id: 5, designation_id: 7 });
    const leaver = emp({ status: 1, resignation_date: "2026-01-01" });
    assert.equal(matchesDimension(leaver, r), true, "the dimensions do agree");
    assert.equal(matchesMapping(leaver, r, TODAY), false, "and they are still gone");
    assert.equal(matchesMapping(emp(), r, TODAY), true);
  });
});

describe("the legacy encoding decodes to the rule it always meant", () => {
  it("ALL_EMPLOYEES is the rule that narrows nothing", () => {
    const legacy = { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES, target_id: 0 };
    assert.deepEqual(ruleOf(legacy), ruleOf(rule({})));
    assert.equal(matchesDimension(emp({ store_id: 99 }), legacy), true);
  });

  for (const [type, field, column] of [
    [MAPPING_TYPE.OUTLET, "outlet_id", "store_id"],
    [MAPPING_TYPE.DEPARTMENT, "department_id", "department_id"],
    [MAPPING_TYPE.DESIGNATION, "designation_id", "designation_id"],
  ]) {
    it(`${type} narrows exactly its own dimension and nothing else`, () => {
      const legacy = { mapping_type: type, target_id: 5 };
      assert.deepEqual(ruleOf(legacy), ruleOf(rule({ [field]: 5 })));
      assert.equal(matchesDimension(emp({ [column]: 5 }), legacy), true);
      assert.equal(matchesDimension(emp({ [column]: 6 }), legacy), false);
    });
  }

  it("a legacy row and its migrated row cover EXACTLY the same people", () => {
    // The migration's whole promise, checked against a population rather
    // than against the SQL that performs it.
    const people = [];
    for (const store_id of [5, 6]) {
      for (const department_id of [3, 4]) {
        for (const designation_id of [7, 8]) {
          people.push(emp({ employee_id: people.length + 1, store_id, department_id, designation_id }));
        }
      }
    }
    const cases = [
      [{ mapping_type: MAPPING_TYPE.ALL_EMPLOYEES, target_id: 0 }, rule({})],
      [{ mapping_type: MAPPING_TYPE.OUTLET, target_id: 5 }, rule({ outlet_id: 5 })],
      [{ mapping_type: MAPPING_TYPE.DEPARTMENT, target_id: 3 }, rule({ department_id: 3 })],
      [{ mapping_type: MAPPING_TYPE.DESIGNATION, target_id: 7 }, rule({ designation_id: 7 })],
    ];
    for (const [legacy, migrated] of cases) {
      const before = people.filter((p) => matchesDimension(p, legacy)).map((p) => p.employee_id);
      const after = people.filter((p) => matchesDimension(p, migrated)).map((p) => p.employee_id);
      assert.deepEqual(after, before, JSON.stringify(legacy));
      assert.ok(before.length > 0, "the case must actually match somebody");
    }
  });

  it("a targeted legacy row on the sentinel matches NOBODY, not everybody", () => {
    // A row that should never have been written. Its failure must stay
    // visible rather than becoming the largest population there is.
    const broken = { mapping_type: MAPPING_TYPE.OUTLET, target_id: 0 };
    assert.equal(matchesDimension(emp(), broken), false);
    assert.equal(matchesDimension(emp({ store_id: 0 }), broken), false);
  });

  it("the COMPOSITE columns win when a stale mapping_type sits beside them", () => {
    // After the migration the composite columns are the truth. Reading the
    // leftover would make a two-dimension rule silently match one.
    const mixed = {
      mapping_type: MAPPING_TYPE.OUTLET,
      target_id: 99,
      ...rule({ outlet_id: 5, designation_id: 7 }),
    };
    assert.deepEqual(ruleOf(mixed), { OUTLET: 5, DEPARTMENT: 0, DESIGNATION: 7 });
    assert.equal(matchesDimension(emp(), mixed), true);
  });
});

describe("the rule reads back as a sentence", () => {
  const resolved = new Map([
    ["OUTLET", new Map([[5, { name: "ECR", active: true }]])],
    ["DEPARTMENT", new Map([[3, { name: "Operations", active: true }]])],
    ["DESIGNATION", new Map([[7, { name: "Cashier", active: true }]])],
  ]);

  it("names every narrowed dimension, in cascade order", () => {
    assert.equal(
      ruleLabel(rule({ outlet_id: 5, department_id: 3, designation_id: 7 }), resolved),
      "Outlet: ECR + Department: Operations + Designation: Cashier"
    );
  });

  it("omits the dimensions left open", () => {
    assert.equal(ruleLabel(rule({ outlet_id: 5, designation_id: 7 }), resolved), "Outlet: ECR + Designation: Cashier");
  });

  it("nothing narrowed is All Employees", () => {
    assert.equal(ruleLabel(rule({}), resolved), "All Employees");
  });

  it("a deleted target still reads as a rule, by id", () => {
    assert.equal(ruleLabel(rule({ outlet_id: 404 }), resolved), "Outlet: #404");
    assert.equal(ruleLabel(rule({ outlet_id: 5 }), undefined), "Outlet: #5");
  });

  it("accepts the resolver's Map, which is what callers actually hold", () => {
    // Indexing a Map with [dimension] yields undefined and every rule would
    // read as "#5" with nothing failing. This is that regression.
    assert.match(ruleLabel(rule({ outlet_id: 5 }), resolved), /ECR/);
  });
});
