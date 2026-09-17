/**
 * THE MIGRATION-TO-RELOAD WINDOW, proven against the OLD matcher.
 *
 *   node --test usecase/telegram_mapping_expand_transition.test.js
 *
 * The deploy sequence is `git pull -> npm install -> db-migrate up -> pm2
 * reload`, so for the minutes between the migration and the reload THE OLD
 * NODE PROCESS IS STILL SERVING REQUESTS against the NEW schema.
 *
 * This file runs the OLD matcher - loaded from the production commit, not
 * reimplemented here, so it cannot drift from what is actually running -
 * over rows the NEW code writes, and pins the one property that matters:
 *
 *   THE OLD PROCESS NEVER BROADENS A RULE. For a single-dimension rule it
 *   agrees with the new code exactly. For a multi-level rule it matches
 *   NOBODY, because under-reaching for a few minutes is recoverable and
 *   over-reaching means telling real people to join a group they do not
 *   belong in.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");

const { legacyShadowOf } = require("../repository/telegram_group_mapping");
const { ruleOf, matchesDimension } = require("../utils/telegram_group_mapping");

/**
 * THE OLD MATCHER, COMPILED FROM THE PRODUCTION COMMIT.
 *
 * `git show origin/main-autodeploy:utils/telegram_group_mapping.js` is what
 * the live process is running. Copying its logic into this file would prove
 * only that two copies agree; loading it proves the real thing is safe.
 */
const oldMatcher = (() => {
  let source;
  try {
    source = execFileSync(
      "git",
      ["show", "origin/main-autodeploy:utils/telegram_group_mapping.js"],
      { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (err) {
    return null; // No git object available (shallow clone); the suite skips.
  }
  const compiled = new Module("old-telegram-group-mapping", null);
  compiled.filename = path.join(__dirname, "..", "utils", "telegram_group_mapping.js");
  compiled.paths = Module._nodeModulePaths(path.join(__dirname, "..", "utils"));
  compiled._compile(source, compiled.filename);
  return compiled.exports;
})();

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

/** Every combination of the fixture's three dimensions. */
const PEOPLE = [];
for (const store_id of [5, 6]) {
  for (const department_id of [3, 4]) {
    for (const designation_id of [7, 8]) {
      PEOPLE.push(emp({ employee_id: PEOPLE.length + 1, store_id, department_id, designation_id }));
    }
  }
}

/** A row exactly as `repository#create` writes it after the expand migration. */
const newRow = (dims = {}, id = 1) => {
  const rule = {
    rule_outlet_id: Number(dims.outlet_id || 0),
    rule_department_id: Number(dims.department_id || 0),
    rule_designation_id: Number(dims.designation_id || 0),
  };
  const shadow = legacyShadowOf(rule);
  return {
    telegram_group_mapping_id: id,
    telegram_group_id: 10,
    mapping_type: shadow.mapping_type,
    // The usecase replaces the placeholder with the row's own id.
    target_id: shadow.composite ? id : shadow.target_id,
    ...rule,
  };
};

/** A row the OLD process wrote during the window: NULL composite columns. */
const legacyRow = (mapping_type, target_id, id = 99) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: 10,
  mapping_type,
  target_id,
  rule_outlet_id: null,
  rule_department_id: null,
  rule_designation_id: null,
});

const covers = (matcher, row) => PEOPLE.filter((p) => matcher(p, row)).map((p) => p.employee_id);

describe("the OLD matcher is loaded from the production commit", () => {
  it("is available, and is not this branch's copy", { skip: !oldMatcher }, () => {
    assert.equal(typeof oldMatcher.matchesDimension, "function");
    // The old one has no composite decoder at all - that is what makes it old.
    assert.equal(typeof oldMatcher.ruleOf, "undefined");
  });
});

describe("a SINGLE-dimension rule: old and new agree exactly", () => {
  for (const [label, dims] of [
    ["All Employees", {}],
    ["Outlet 5", { outlet_id: 5 }],
    ["Department 3", { department_id: 3 }],
    ["Designation 7", { designation_id: 7 }],
  ]) {
    it(`${label} covers the same people in both processes`, { skip: !oldMatcher }, () => {
      const row = newRow(dims);
      assert.deepEqual(
        covers(oldMatcher.matchesDimension, row),
        covers(matchesDimension, row),
        label
      );
      assert.ok(covers(matchesDimension, row).length > 0, "the case must match somebody");
    });
  }

  it("carries an EXACT legacy shadow, not a neutral one", () => {
    assert.equal(newRow({ outlet_id: 5 }).mapping_type, "OUTLET");
    assert.equal(newRow({ outlet_id: 5 }).target_id, 5);
    assert.equal(newRow({}).mapping_type, "ALL_EMPLOYEES");
    assert.equal(newRow({}).target_id, 0);
  });
});

describe("a MULTI-LEVEL rule: the old process matches NOBODY", () => {
  const MULTI = [
    ["outlet + designation", { outlet_id: 5, designation_id: 7 }],
    ["outlet + department", { outlet_id: 5, department_id: 3 }],
    ["department + designation", { department_id: 3, designation_id: 7 }],
    ["all three", { outlet_id: 5, department_id: 3, designation_id: 7 }],
  ];

  for (const [label, dims] of MULTI) {
    it(`${label}: the old process covers nobody at all`, { skip: !oldMatcher }, () => {
      const row = newRow(dims);
      assert.deepEqual(covers(oldMatcher.matchesDimension, row), [], label);
    });

    it(`${label}: the old process NEVER covers more than the new one`, { skip: !oldMatcher }, () => {
      // THE SAFETY PROPERTY, stated directly. Under-reaching is recoverable;
      // broadening means somebody is told to join a group they do not belong
      // in, by a process nobody can see is wrong.
      const row = newRow(dims);
      const oldSet = new Set(covers(oldMatcher.matchesDimension, row));
      const newSet = covers(matchesDimension, row);
      for (const id of oldSet) {
        assert.ok(newSet.includes(id), `old process reached employee ${id} the new rule does not`);
      }
    });

    it(`${label}: and the NEW process reads it correctly`, () => {
      const row = newRow(dims);
      const expected = PEOPLE.filter(
        (p) =>
          (!dims.outlet_id || p.store_id === dims.outlet_id) &&
          (!dims.department_id || p.department_id === dims.department_id) &&
          (!dims.designation_id || p.designation_id === dims.designation_id)
      ).map((p) => p.employee_id);
      assert.deepEqual(covers(matchesDimension, row), expected);
      assert.ok(expected.length > 0);
    });
  }

  it("never claims to be one of the dimensions it narrows", () => {
    // The two lossy encodings, named and refused: OUTLET would broaden it to
    // everybody at that outlet, DESIGNATION to every cashier in the company.
    const row = newRow({ outlet_id: 5, designation_id: 7 });
    assert.equal(row.mapping_type, "COMPOSITE");
    for (const lossy of ["OUTLET", "DEPARTMENT", "DESIGNATION", "ALL_EMPLOYEES"]) {
      assert.notEqual(row.mapping_type, lossy);
    }
  });

  it("ALL_EMPLOYEES would be the worst shadow of all, and is never used", () => {
    const row = newRow({ outlet_id: 5, designation_id: 7 });
    assert.notEqual(row.mapping_type, "ALL_EMPLOYEES");
  });

  it("several multi-level rules on one group get DISTINCT legacy pairs", () => {
    // `uq_tgm_group_type_target` is kept for the old process, so the shadows
    // must not collide.
    const rows = [
      newRow({ outlet_id: 5, designation_id: 7 }, 1),
      newRow({ outlet_id: 5, department_id: 3 }, 2),
      newRow({ outlet_id: 6, designation_id: 8 }, 3),
    ];
    const pairs = rows.map((r) => `${r.telegram_group_id}|${r.mapping_type}|${r.target_id}`);
    assert.equal(new Set(pairs).size, rows.length);
  });
});

describe("a row the OLD process wrote during the window", () => {
  for (const [type, target] of [
    ["ALL_EMPLOYEES", 0],
    ["OUTLET", 5],
    ["DEPARTMENT", 3],
    ["DESIGNATION", 7],
  ]) {
    it(`${type} is read correctly by the NEW code from its legacy pair`, () => {
      // Its composite columns are NULL because the old INSERT never named
      // them. Reading NULL as 0 would make this row mean ALL EMPLOYEES.
      const row = legacyRow(type, target);
      const expected = PEOPLE.filter(
        (p) =>
          type === "ALL_EMPLOYEES" ||
          (type === "OUTLET" && p.store_id === target) ||
          (type === "DEPARTMENT" && p.department_id === target) ||
          (type === "DESIGNATION" && p.designation_id === target)
      ).map((p) => p.employee_id);
      assert.deepEqual(covers(matchesDimension, row), expected, type);
    });

    it(`${type} means the same thing to both processes`, { skip: !oldMatcher }, () => {
      const row = legacyRow(type, target);
      assert.deepEqual(covers(oldMatcher.matchesDimension, row), covers(matchesDimension, row));
    });
  }

  it("a legacy OUTLET row is NOT silently widened to everybody", () => {
    // The single most dangerous misreading available: NULL treated as the
    // unrestricted sentinel. An operator adding a one-outlet rule during the
    // window would have created a company-wide one.
    const row = legacyRow("OUTLET", 5);
    const reached = covers(matchesDimension, row);
    assert.ok(reached.length > 0);
    assert.ok(reached.length < PEOPLE.length, "it must not reach everybody");
    assert.deepEqual(ruleOf(row), { OUTLET: 5, DEPARTMENT: 0, DESIGNATION: 0 });
  });
});

describe("a COMPOSITE row read WITHOUT its composite columns", () => {
  it("matches nobody rather than everybody", () => {
    // Any future reader that selects only the legacy pair - an old report, a
    // half-migrated cache - must fail closed. `COMPOSITE` is not a dimension
    // and is emphatically not ALL_EMPLOYEES.
    const bare = { mapping_type: "COMPOSITE", target_id: 4 };
    assert.deepEqual(covers(matchesDimension, bare), []);
  });
});
