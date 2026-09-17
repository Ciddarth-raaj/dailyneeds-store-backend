/**
 * Telegram Group Mapping - who a group's rules resolve to. Phase 3A.
 *
 *   node --test usecase/telegram_group_mapping.test.js
 *
 * The rules under test, in the order they matter:
 *
 *   EMPLOYMENT IS DATED, NOT `status`. A resigned employee carrying
 *   `status = 1` is the production trap this whole file exists to pin.
 *   THE RULE IS GLOBAL, EVERY EMPLOYEE NUMBER IS SCOPED. A branch manager
 *   sees the same rule as HR and counts only their own branch's staff.
 *   A MISSING TARGET IS NOT A ZERO COUNT. They are different states.
 *   NOTHING IS INFERRED FROM A GROUP'S NAME.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildMapping = require("./telegram_group_mapping");
const {
  MAPPING_TYPE,
  ALL_EMPLOYEES_TARGET_ID,
  TARGET_STATE,
  TARGET_WARNING,
  MAPPING_MESSAGES,
  COUNTS_SCOPE,
  PREVIEW_MESSAGES,
} = require("../constants/telegram_group_mapping");
const { RULE_COLUMNS } = require("../repository/telegram_group_mapping");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

const TODAY = "2026-09-16";
const NOW = new Date("2026-09-16T04:00:00Z"); // 09:30 IST

/** An employee employed since 2020 unless the test says otherwise. */
const emp = (over = {}) => ({
  employee_id: 1,
  employee_name: "Raj",
  store_id: 5,
  designation_id: 7,
  department_id: 3,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  outlet_name: "ECR",
  designation_name: "Cashier",
  department_name: "Operations",
  ...over,
});

const GROUP = {
  telegram_group_id: 10,
  group_name: "Cashiers",
  category: "HR",
  used_for: "Daily notices",
  outlet_id: 9,
  outlet_name: "Moolakulam",
  bot_is_admin: true,
  is_active: true,
};

/**
 * A repository standing in for MySQL. `calls` records every read so the
 * no-N+1 assertions can count them rather than trust a comment.
 */
const makeRepo = ({
  mappings = [],
  employees = [],
  connected = [],
  targets = {},
  createThrows = null,
} = {}) => {
  const calls = { snapshot: 0, connected: 0, resolveTargets: 0, byGroup: 0, created: [], deleted: [] };
  return {
    calls,
    getByGroup: async () => {
      calls.byGroup += 1;
      return mappings;
    },
    getByIdForGroup: async (groupId, id) =>
      mappings.find((m) => m.telegram_group_mapping_id === id && m.telegram_group_id === groupId) ||
      null,
    findDuplicateRule: async (groupId, wanted) =>
      mappings.find(
        (m) =>
          m.telegram_group_id === groupId &&
          RULE_COLUMNS.every((c) => Number(m[c] || 0) === Number((wanted || {})[c] || 0))
      ) || null,
    resolveTargets: async (idsByType) => {
      calls.resolveTargets += 1;
      const out = new Map();
      for (const [type, ids] of Object.entries(idsByType || {})) {
        if (!ids || ids.length === 0) continue;
        const found = new Map();
        for (const id of ids) {
          const row = (targets[type] || {})[id];
          if (row) found.set(Number(id), row);
        }
        out.set(type, found);
      }
      return out;
    },
    getEmployeeSnapshot: async () => {
      calls.snapshot += 1;
      return employees;
    },
    getConnectedEmployeeIds: async (ids) => {
      calls.connected += 1;
      return new Set(connected.filter((id) => ids.includes(id)));
    },
    /**
     * Phase 3C wraps the mapping writes in a transaction, so that the
     * reconciliation job they enqueue commits with them. The double has to
     * offer one for the same reason the real repository does - and it runs
     * the callback, so a test that forgets to commit fails here rather than
     * passing against a stub that swallowed the work.
     */
    withTransaction: async (fn) => {
      calls.transactions += 1;
      return fn({ query: async () => ({ affectedRows: 1 }) });
    },
    create: async (row) => {
      if (createThrows) throw createThrows;
      calls.created.push(row);
      return { telegram_group_mapping_id: 99 };
    },
    delete: async (groupId, id) => {
      calls.deleted.push({ groupId, id });
      const hit = mappings.find(
        (m) => m.telegram_group_mapping_id === id && m.telegram_group_id === groupId
      );
      return { affectedRows: hit ? 1 : 0 };
    },
  };
};

const makeRegistry = (group = GROUP) => ({ getById: async (id) => (group && group.telegram_group_id === id ? group : null) });

const build = (repoOpts, group) =>
  buildMapping(makeRepo(repoOpts), makeRegistry(group), { now: () => NOW });

/**
 * A STORED mapping row, in the shape the table now holds: three dimensions,
 * 0 meaning unrestricted.
 *
 * The single-dimension call `mapping(1, MAPPING_TYPE.OUTLET, 5)` still reads
 * the same way and still means the same rule - it just stores it as
 * (5, 0, 0). The tests below that predate multi-level rules therefore assert
 * unchanged behaviour against the new storage, which is the point: a rule
 * that meant "outlet 5" before must still mean exactly that.
 */
const mapping = (id, type, target = ALL_EMPLOYEES_TARGET_ID) =>
  rule(id, type && type !== MAPPING_TYPE.ALL_EMPLOYEES ? { [FIELD_OF[type]]: target } : {});

/** A stored row for an arbitrary composite rule. `{outlet_id, ...}` in. */
const rule = (id, dims = {}) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: 10,
  rule_outlet_id: Number(dims.outlet_id || 0),
  rule_department_id: Number(dims.department_id || 0),
  rule_designation_id: Number(dims.designation_id || 0),
});

const FIELD_OF = {
  [MAPPING_TYPE.OUTLET]: "outlet_id",
  [MAPPING_TYPE.DEPARTMENT]: "department_id",
  [MAPPING_TYPE.DESIGNATION]: "designation_id",
};

/** One dimension off a described mapping row. */
const dim = (row, dimension) => row.rule_dimensions.find((d) => d.dimension === dimension);

const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };
const ownBranches = (ids) => ({ kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: ids });

/* ============================================================ persistence */

describe("adding a mapping", () => {
  it("stores 0 - never NULL - on every dimension left unrestricted", async () => {
    const repo = makeRepo();
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    // No dimension at all IS "All Employees". There is no type to name.
    await usecase.addMapping(10, {});

    assert.equal(repo.calls.created.length, 1);
    assert.deepEqual(repo.calls.created[0].rule, {
      rule_outlet_id: ALL_EMPLOYEES_TARGET_ID,
      rule_department_id: ALL_EMPLOYEES_TARGET_ID,
      rule_designation_id: ALL_EMPLOYEES_TARGET_ID,
    });
    for (const column of RULE_COLUMNS) {
      assert.notEqual(repo.calls.created[0].rule[column], null, column);
    }
  });

  it("treats absent, null and empty string on a dimension as All", async () => {
    // The screen's own dropdown sends "" for All, so all three spellings
    // must land on the same stored rule rather than on three of them.
    for (const blank of [undefined, null, ""]) {
      const repo = makeRepo();
      const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
      await usecase.addMapping(10, { outlet_id: blank, department_id: blank });
      assert.deepEqual(repo.calls.created[0].rule, {
        rule_outlet_id: 0,
        rule_department_id: 0,
        rule_designation_id: 0,
      });
    }
  });

  it("stores a rule that narrows ALL THREE dimensions", async () => {
    const repo = makeRepo({
      targets: {
        OUTLET: { 5: { name: "ECR", active: true } },
        DEPARTMENT: { 3: { name: "Operations", active: true } },
        DESIGNATION: { 7: { name: "Cashier", active: true } },
      },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    const ok = await usecase.addMapping(10, { outlet_id: 5, department_id: 3, designation_id: 7 });
    assert.equal(ok.code, 200);
    assert.deepEqual(repo.calls.created[0].rule, {
      rule_outlet_id: 5,
      rule_department_id: 3,
      rule_designation_id: 7,
    });
  });

  it("stores a rule that narrows TWO of the three, leaving the middle open", async () => {
    const repo = makeRepo({
      targets: {
        OUTLET: { 5: { name: "ECR", active: true } },
        DESIGNATION: { 7: { name: "Cashier", active: true } },
      },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.addMapping(10, { outlet_id: 5, designation_id: 7 });
    assert.deepEqual(repo.calls.created[0].rule, {
      rule_outlet_id: 5,
      rule_department_id: 0,
      rule_designation_id: 7,
    });
  });

  for (const [field, dimension, label] of [
    ["outlet_id", "OUTLET", "outlet"],
    ["department_id", "DEPARTMENT", "department"],
    ["designation_id", "DESIGNATION", "designation"],
  ]) {
    it(`${field} must be a positive id that EXISTS`, async () => {
      const targets = { [dimension]: { 5: { name: "Something", active: true } } };
      const usecase = build({ targets });

      for (const bad of [0, -1, "abc", 2.5, {}]) {
        await assert.rejects(
          () => usecase.addMapping(10, { [field]: bad }),
          new RegExp(`Select a valid ${label}`),
          `${field} ${JSON.stringify(bad)} must be refused`
        );
      }
      await assert.rejects(
        () => usecase.addMapping(10, { [field]: 404 }),
        new RegExp(`That ${label} no longer exists`)
      );
      const ok = await usecase.addMapping(10, { [field]: 5 });
      assert.equal(ok.code, 200);
    });
  }

  it("refuses the WHOLE rule when any one dimension is unknown", async () => {
    // Partial acceptance would store a BROADER rule than the operator asked
    // for - dropping the designation leaves "everybody at outlet 5".
    const repo = makeRepo({ targets: { OUTLET: { 5: { name: "ECR", active: true } } } });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await assert.rejects(
      () => usecase.addMapping(10, { outlet_id: 5, designation_id: 404 }),
      /designation no longer exists/
    );
    assert.equal(repo.calls.created.length, 0, "nothing may be stored");
  });

  it("an INACTIVE target is still mappable", async () => {
    // Retiring a department does not retire the people assigned to it.
    const repo = makeRepo({ targets: { DEPARTMENT: { 3: { name: "Old", active: false } } } });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    assert.equal((await usecase.addMapping(10, { department_id: 3 })).code, 200);
  });

  it("rejects an identical rule with a sentence, not a driver error", async () => {
    const usecase = build({
      mappings: [rule(1, { outlet_id: 5, designation_id: 7 })],
      targets: {
        OUTLET: { 5: { name: "ECR", active: true } },
        DESIGNATION: { 7: { name: "Cashier", active: true } },
      },
    });
    await assert.rejects(
      () => usecase.addMapping(10, { outlet_id: 5, designation_id: 7 }),
      (err) => err.message === PREVIEW_MESSAGES.DUPLICATE_RULE
    );
  });

  it("a rule differing on ONE dimension is not a duplicate", async () => {
    const repo = makeRepo({
      mappings: [rule(1, { outlet_id: 5, designation_id: 7 })],
      targets: {
        OUTLET: { 5: { name: "ECR", active: true } },
        DESIGNATION: { 7: { name: "Cashier", active: true } },
      },
      // Same outlet, same designation, but a department named as well - a
      // strictly narrower rule, and a different one.
    });
    repo.resolveTargets = async () =>
      new Map([
        ["OUTLET", new Map([[5, { name: "ECR", active: true }]])],
        ["DEPARTMENT", new Map([[3, { name: "Ops", active: true }]])],
        ["DESIGNATION", new Map([[7, { name: "Cashier", active: true }]])],
      ]);
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    assert.equal(
      (await usecase.addMapping(10, { outlet_id: 5, department_id: 3, designation_id: 7 })).code,
      200
    );
  });

  it("the ALL-EMPLOYEES rule can only be added once, by the same guard", async () => {
    const usecase = build({ mappings: [rule(1, {})] });
    await assert.rejects(
      () => usecase.addMapping(10, {}),
      (err) => err.message === PREVIEW_MESSAGES.DUPLICATE_RULE
    );
  });

  it("turns the UNIQUE index violation into the same sentence", async () => {
    // Two requests can pass the pre-check in the same instant; the index is
    // what actually decides, and the loser must not see ER_DUP_ENTRY.
    const err = new Error("ER_DUP_ENTRY: Duplicate entry");
    err.code = "ER_DUP_ENTRY";
    const usecase = build({ createThrows: err });
    await assert.rejects(
      () => usecase.addMapping(10, {}),
      (e) => e.message === PREVIEW_MESSAGES.DUPLICATE_RULE && e.name === "ValidationError"
    );
  });

  it("does not disguise an unrelated database failure as a duplicate", async () => {
    const usecase = build({ createThrows: new Error("ER_LOCK_WAIT_TIMEOUT") });
    await assert.rejects(() => usecase.addMapping(10, {}), /LOCK_WAIT/);
  });

  it("allows several DIFFERENT mappings on one group", async () => {
    const repo = makeRepo({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      targets: { DESIGNATION: { 7: { name: "Cashier", active: true } } },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.addMapping(10, { designation_id: 7 });
    assert.equal(repo.calls.created.length, 1);
  });

  it("refuses to map onto a group that does not exist", async () => {
    const usecase = buildMapping(makeRepo(), makeRegistry(null), { now: () => NOW });
    await assert.rejects(() => usecase.addMapping(10, {}), /not found/);
  });
});

describe("deleting a mapping", () => {
  it("deletes one belonging to this group", async () => {
    const repo = makeRepo({ mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)] });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    const result = await usecase.deleteMapping(10, 1);
    assert.equal(result.code, 200);
    assert.deepEqual(repo.calls.deleted, [{ groupId: 10, id: 1 }]);
  });

  it("refuses a mapping id that is not this group's, without saying it exists", async () => {
    const usecase = build({ mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)] });
    await assert.rejects(
      () => usecase.deleteMapping(10, 777),
      (err) => err.message === MAPPING_MESSAGES.MAPPING_NOT_FOUND && err.httpCode === 404
    );
  });

  it("scopes the delete by group in the query, not afterwards", async () => {
    const repo = makeRepo({ mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)] });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.deleteMapping(10, 1).catch(() => {});
    assert.equal(repo.calls.deleted[0].groupId, 10, "the group must be part of the delete");
  });
});

/* =========================================================== employment */

describe("employment is DATED, never `status`", () => {
  const outletMapping = [mapping(1, MAPPING_TYPE.OUTLET, 5)];
  const targets = { OUTLET: { 5: { name: "ECR", active: true } } };

  const countFor = async (employee) => {
    const usecase = build({ mappings: outletMapping, employees: [employee], targets });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    return result.mappings[0].matched_employees;
  };

  it("EXCLUDES a resigned employee who still carries status = 1", async () => {
    // The production trap. `status` is not maintained on resignation, so a
    // status-based rule keeps leavers in store groups indefinitely.
    assert.equal(await countFor(emp({ status: 1, resignation_date: "2026-09-15" })), 0);
  });

  it("INCLUDES a date-valid employee whose status is 0", async () => {
    assert.equal(await countFor(emp({ status: 0, resignation_date: null })), 1);
  });

  it("excludes somebody who has not joined yet", async () => {
    assert.equal(await countFor(emp({ date_of_joining: "2026-09-17" })), 0);
  });

  it("includes somebody joining today", async () => {
    assert.equal(await countFor(emp({ date_of_joining: TODAY })), 1);
  });

  it("includes somebody ON their resignation date, as employedOn() defines it", async () => {
    // Not a rule invented here - the shared helper treats the resignation
    // date as a day still worked, and this pins that this code agrees.
    assert.equal(await countFor(emp({ resignation_date: TODAY })), 1);
    assert.equal(await countFor(emp({ resignation_date: "2026-09-15" })), 0);
  });

  it("does NOT exclude an employee exempt from biometric attendance", async () => {
    // eligibleOn() would have dropped them. Being exempt from punching is
    // not being off the staff.
    assert.equal(await countFor(emp({ attendance_required: 0 })), 1);
  });

  it("applies the dated rule to ALL_EMPLOYEES too, not just targeted types", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
      employees: [emp({ employee_id: 1 }), emp({ employee_id: 2, resignation_date: "2020-06-01" })],
    });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.mappings[0].matched_employees, 1);
    assert.equal(result.total_matched, 1);
  });

  it("uses the INDIAN business date, not the host's", async () => {
    // 2026-09-16T19:00Z is already 17 September in India. Somebody joining
    // on the 17th is employed there and not here.
    const late = buildMapping(
      makeRepo({
        mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
        employees: [emp({ date_of_joining: "2026-09-17" })],
      }),
      makeRegistry(),
      { now: () => new Date("2026-09-16T19:00:00Z") }
    );
    const result = await late.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.as_of_date, "2026-09-17");
    assert.equal(result.mappings[0].matched_employees, 1);
  });
});

/* ============================================================== union */

describe("several mappings", () => {
  const employees = [
    emp({ employee_id: 1, store_id: 5, designation_id: 7 }),
    emp({ employee_id: 2, store_id: 5, designation_id: 9 }),
    emp({ employee_id: 3, store_id: 8, designation_id: 7 }),
    emp({ employee_id: 4, store_id: 8, designation_id: 9 }),
  ];
  const mappings = [mapping(1, MAPPING_TYPE.OUTLET, 5), mapping(2, MAPPING_TYPE.DESIGNATION, 7)];
  const targets = {
    OUTLET: { 5: { name: "ECR", active: true } },
    DESIGNATION: { 7: { name: "Cashier", active: true } },
  };

  it("is OR, not AND", async () => {
    const usecase = build({ mappings, employees, targets });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    // 1 and 2 by outlet, 1 and 3 by designation -> {1,2,3}, not just {1}.
    assert.equal(result.total_matched, 3);
  });

  it("counts each rule independently, even where they overlap", async () => {
    const usecase = build({ mappings, employees, targets });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.mappings[0].matched_employees, 2);
    assert.equal(result.mappings[1].matched_employees, 2);
    assert.equal(result.total_matched, 3, "2 + 2 is 4 rows but 3 people");
  });

  it("returns a person matched three times exactly once", async () => {
    const usecase = build({
      mappings: [
        mapping(1, MAPPING_TYPE.ALL_EMPLOYEES),
        mapping(2, MAPPING_TYPE.OUTLET, 5),
        mapping(3, MAPPING_TYPE.DESIGNATION, 7),
      ],
      employees: [emp({ employee_id: 1 })],
      targets,
    });
    const result = await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(result.employees.length, 1);
    assert.equal(result.total_matched, 1);
  });

  it("can show one mapping's own population", async () => {
    const usecase = build({ mappings, employees, targets });
    const result = await usecase.getMatchedEmployees(10, { mapping_id: 2, scope: ALL_BRANCHES });
    assert.deepEqual(result.employees.map((e) => e.employee_id).sort(), [1, 3]);
  });

  it("refuses a mapping_id belonging to another group", async () => {
    const usecase = build({ mappings, employees, targets });
    await assert.rejects(
      () => usecase.getMatchedEmployees(10, { mapping_id: 4242, scope: ALL_BRANCHES }),
      /Mapping not found/
    );
  });
});

/* =========================================================== targets */

describe("a target's lifecycle", () => {
  const employees = [emp({ employee_id: 1, store_id: 5 })];

  it("ACTIVE target: no warning", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: { 5: { name: "ECR", active: true } } },
    });
    const row = (await usecase.getMappings(10, { scope: ALL_BRANCHES })).mappings[0];
    assert.equal(dim(row, "OUTLET").state, TARGET_STATE.ACTIVE);
    assert.equal(row.target_warning, null);
    assert.equal(dim(row, "OUTLET").name, "ECR");
    assert.equal(row.rule_label, "Outlet: ECR");
    // The two dimensions this rule does not narrow are "All", which is a
    // state of its own and not a missing target.
    assert.equal(dim(row, "DEPARTMENT").state, TARGET_STATE.NOT_APPLICABLE);
    assert.equal(dim(row, "DEPARTMENT").name, "All");
  });

  it("INACTIVE target: mapping preserved, warned, and STILL MATCHING", async () => {
    // Retiring an outlet does not retire the people assigned to it. Showing
    // zero would hide them.
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: { 5: { name: "ECR (closed)", active: false } } },
    });
    const row = (await usecase.getMappings(10, { scope: ALL_BRANCHES })).mappings[0];
    assert.equal(dim(row, "OUTLET").state, TARGET_STATE.INACTIVE);
    assert.equal(row.target_warning, TARGET_WARNING.INACTIVE);
    assert.equal(row.matched_employees, 1, "the stored target id still matches");
  });

  it("MISSING target: mapping preserved and warned differently", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: {} },
    });
    const row = (await usecase.getMappings(10, { scope: ALL_BRANCHES })).mappings[0];
    assert.equal(dim(row, "OUTLET").state, TARGET_STATE.MISSING);
    assert.equal(row.target_warning, TARGET_WARNING.MISSING);
    // The rule still reads as a rule, naming the id it can no longer name.
    assert.equal(row.rule_label, "Outlet: #5");
    assert.notEqual(TARGET_WARNING.MISSING, TARGET_WARNING.INACTIVE);
  });

  it("a VALID target matching nobody carries NO warning", async () => {
    // The distinction the whole design turns on: zero is not broken.
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees: [emp({ employee_id: 1, store_id: 99 })],
      targets: { OUTLET: { 5: { name: "ECR", active: true } } },
    });
    const row = (await usecase.getMappings(10, { scope: ALL_BRANCHES })).mappings[0];
    assert.equal(row.matched_employees, 0);
    assert.equal(row.target_warning, null);
    assert.equal(dim(row, "OUTLET").state, TARGET_STATE.ACTIVE);
  });

  it("ALL_EMPLOYEES has no target to be broken", async () => {
    const usecase = build({ mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)], employees });
    const row = (await usecase.getMappings(10, { scope: ALL_BRANCHES })).mappings[0];
    // Nothing narrowed, so there is no target to be broken on ANY dimension.
    for (const dimension of ["OUTLET", "DEPARTMENT", "DESIGNATION"]) {
      assert.equal(dim(row, dimension).state, TARGET_STATE.NOT_APPLICABLE, dimension);
      assert.equal(dim(row, dimension).id, null, dimension);
    }
    assert.equal(row.target_warning, null);
    assert.equal(row.is_all_employees, true);
    assert.equal(row.rule_label, "All Employees");
    assert.deepEqual(row.rule, { outlet_id: null, department_id: null, designation_id: null });
  });
});

/* ====================================================== group state */

describe("an inactive Telegram group", () => {
  const inactive = { ...GROUP, is_active: false };

  it("keeps its mappings and says why the screen still works", async () => {
    const usecase = build(
      { mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)], employees: [emp()] },
      inactive
    );
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.mappings.length, 1);
    assert.equal(result.group.is_active, false);
    assert.match(result.group.inactive_notice, /No Telegram membership action will be performed/);
  });

  it("still accepts a new mapping", async () => {
    const repo = makeRepo();
    const usecase = buildMapping(repo, makeRegistry(inactive), { now: () => NOW });
    const result = await usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES });
    assert.equal(result.code, 200);
  });

  it("an ACTIVE group carries no banner", async () => {
    const usecase = build({ mappings: [], employees: [] });
    assert.equal((await usecase.getMappings(10, { scope: ALL_BRANCHES })).group.inactive_notice, null);
  });
});

/* ============================================================= scope */

describe("the rule is global, every employee number is scoped", () => {
  const employees = [
    emp({ employee_id: 1, store_id: 5, employee_name: "Anitha", designation_id: 7, department_id: 3 }),
    emp({ employee_id: 2, store_id: 8, employee_name: "Bala", designation_id: 7, department_id: 3 }),
    emp({ employee_id: 3, store_id: 8, employee_name: "Chitra", designation_id: 9, department_id: 4 }),
  ];
  const all = [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)];

  it("HR/Admin counts the company", async () => {
    const result = await build({ mappings: all, employees }).getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.mappings[0].matched_employees, 3);
    assert.equal(result.total_matched, 3);
    assert.equal(result.counts_scope, COUNTS_SCOPE.ALL);
  });

  it("a branch manager counts ONLY their own branch", async () => {
    const result = await build({ mappings: all, employees }).getMappings(10, {
      scope: ownBranches([8]),
    });
    assert.equal(result.mappings[0].matched_employees, 2, "not the company's 3");
    assert.equal(result.total_matched, 2);
    assert.equal(result.counts_scope, COUNTS_SCOPE.BRANCH);
  });

  it("NO company-wide figure appears ANYWHERE in a manager's response", async () => {
    // The whole point of the correction: the forbidden number is not hidden,
    // it is never computed. Serialize the entire body and look for it.
    const result = await build({ mappings: all, employees }).getMappings(10, {
      scope: ownBranches([8]),
    });
    const numbers = JSON.stringify(result).match(/\d+/g).map(Number);
    assert.ok(!numbers.includes(3), "the company-wide count of 3 must not appear");
    assert.ok(!("scope_limited" in result), "the stale flag is gone");
    assert.ok(!("visible_count" in result), "there is no total to be a subset of");
  });

  it("ALL_EMPLOYEES counts only the manager's currently employed staff", async () => {
    const withLeaver = [
      ...employees,
      emp({ employee_id: 4, store_id: 8, resignation_date: "2026-09-15" }),
      emp({ employee_id: 5, store_id: 5, employee_name: "Elsewhere" }),
    ];
    const result = await build({ mappings: all, employees: withLeaver }).getMappings(10, {
      scope: ownBranches([8]),
    });
    // Branch 8 has Bala, Chitra and a leaver. Employment and scope BOTH apply.
    assert.equal(result.total_matched, 2);
  });

  it("an OUTLET rule for ANOTHER branch reveals no count from it", async () => {
    // The manager sees the rule names outlet 5, and that it counts nobody
    // they may see. They never learn outlet 5 has one employee.
    const result = await build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: { 5: { name: "ECR", active: true } } },
    }).getMappings(10, { scope: ownBranches([8]) });

    assert.equal(result.mappings[0].matched_employees, 0);
    assert.equal(dim(result.mappings[0], "OUTLET").name, "ECR", "the RULE is shown in full");
    assert.equal(dim(result.mappings[0], "OUTLET").state, TARGET_STATE.ACTIVE);
  });

  it("a DESIGNATION rule spanning outlets exposes only the manager's own", async () => {
    // Designation 7 is held by Anitha (branch 5) and Bala (branch 8).
    const result = await build({
      mappings: [mapping(1, MAPPING_TYPE.DESIGNATION, 7)],
      employees,
      targets: { DESIGNATION: { 7: { name: "Cashier", active: true } } },
    }).getMappings(10, { scope: ownBranches([8]) });
    assert.equal(result.mappings[0].matched_employees, 1, "not the company's 2");
    assert.equal(dim(result.mappings[0], "DESIGNATION").name, "Cashier");
  });

  it("a DEPARTMENT rule spanning outlets exposes only the manager's own", async () => {
    // Department 3 is Anitha (branch 5) and Bala (branch 8).
    const result = await build({
      mappings: [mapping(1, MAPPING_TYPE.DEPARTMENT, 3)],
      employees,
      targets: { DEPARTMENT: { 3: { name: "Operations", active: true } } },
    }).getMappings(10, { scope: ownBranches([8]) });
    assert.equal(result.mappings[0].matched_employees, 1);
  });

  it("the MAPPING RULES are identical for HR and for the manager", async () => {
    const mappings = [
      mapping(1, MAPPING_TYPE.ALL_EMPLOYEES),
      mapping(2, MAPPING_TYPE.OUTLET, 5),
      mapping(3, MAPPING_TYPE.DESIGNATION, 7),
    ];
    const targets = {
      OUTLET: { 5: { name: "ECR", active: true } },
      DESIGNATION: { 7: { name: "Cashier", active: true } },
    };
    const strip = (r) =>
      r.mappings.map((m) => ({
        id: m.telegram_group_mapping_id,
        type: m.mapping_type,
        target_id: m.target_id,
        target_name: m.target_name,
        target_state: m.target_state,
        target_warning: m.target_warning,
      }));

    const hr = await build({ mappings, employees, targets }).getMappings(10, { scope: ALL_BRANCHES });
    const mgr = await build({ mappings, employees, targets }).getMappings(10, {
      scope: ownBranches([8]),
    });
    assert.deepEqual(strip(mgr), strip(hr), "configuration is not branch-scoped, only its arithmetic");
    assert.notDeepEqual(
      mgr.mappings.map((m) => m.matched_employees),
      hr.mappings.map((m) => m.matched_employees)
    );
  });

  it("reports the THREE scopes distinctly - NONE is not a kind of BRANCH", async () => {
    // Two of these render as zero and mean different things: "nobody in your
    // branch matches" is an observation, "we could not look" is not.
    const cases = [
      [ALL_BRANCHES, COUNTS_SCOPE.ALL],
      [ownBranches([8]), COUNTS_SCOPE.BRANCH],
      [{ kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] }, COUNTS_SCOPE.NONE],
      [ownBranches([]), COUNTS_SCOPE.NONE],
      [undefined, COUNTS_SCOPE.NONE],
      [{ kind: "SOMETHING_NEW" }, COUNTS_SCOPE.NONE],
    ];
    for (const [scope, expected] of cases) {
      const result = await build({ mappings: all, employees }).getMappings(10, { scope });
      assert.equal(result.counts_scope, expected, `scope ${JSON.stringify(scope)}`);
      const list = await build({ mappings: all, employees }).getMatchedEmployees(10, { scope });
      assert.equal(list.counts_scope, expected, `matched-employees, scope ${JSON.stringify(scope)}`);
    }
  });

  it("an OWN_BRANCHES scope with no usable branch is NONE, not BRANCH", async () => {
    // It cannot be a branch answer, because there is no branch.
    for (const ids of [[], null, undefined, ["x"], [NaN]]) {
      const result = await build({ mappings: all, employees }).getMappings(10, {
        scope: { kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: ids },
      });
      assert.equal(result.counts_scope, COUNTS_SCOPE.NONE, `store_ids ${JSON.stringify(ids)}`);
      assert.equal(result.total_matched, 0);
    }
  });

  it("the label always describes the rule that produced the numbers", async () => {
    // countsScope and visibleEmployees must agree: a BRANCH label over an
    // empty population, or a NONE label over a counted one, is a lie either
    // way round.
    for (const scope of [
      ALL_BRANCHES,
      ownBranches([8]),
      ownBranches([]),
      { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] },
      undefined,
    ]) {
      const result = await build({ mappings: all, employees }).getMappings(10, { scope });
      if (result.counts_scope === COUNTS_SCOPE.NONE) {
        assert.equal(result.total_matched, 0, "NONE must have counted nothing");
      } else {
        assert.ok(result.total_matched > 0, "ALL and BRANCH counted a real population here");
      }
    }
  });

  it("the mapping RULES are returned unchanged under NONE", async () => {
    // The configuration is not employee information. Somebody who may open
    // the screen still sees every rule in full.
    const mappings = [
      mapping(1, MAPPING_TYPE.ALL_EMPLOYEES),
      mapping(2, MAPPING_TYPE.OUTLET, 5),
    ];
    const targets = { OUTLET: { 5: { name: "ECR", active: true } } };
    const strip = (r) =>
      r.mappings.map((m) => ({
        id: m.telegram_group_mapping_id,
        type: m.mapping_type,
        label: m.mapping_type_label,
        target_id: m.target_id,
        target_name: m.target_name,
        target_state: m.target_state,
        target_warning: m.target_warning,
      }));

    const hr = await build({ mappings, employees, targets }).getMappings(10, { scope: ALL_BRANCHES });
    const none = await build({ mappings, employees, targets }).getMappings(10, {
      scope: { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] },
    });
    assert.deepEqual(strip(none), strip(hr));
    assert.equal(none.group.group_name, hr.group.group_name);
    assert.equal(none.total_matched, 0);
  });

  it("NONE computes no unauthorized total to distinguish itself", async () => {
    const repo = makeRepo({ mappings: all, employees });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    const result = await usecase.getMappings(10, {
      scope: { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] },
    });
    const numbers = JSON.stringify(result).match(/\d+/g).map(Number);
    assert.ok(!numbers.includes(3), "the company-wide count must not appear anywhere");
    assert.equal(repo.calls.connected, 1, "still bounded, still no per-employee lookup");
  });

  it("a NONE scope counts NOTHING and lists nobody", async () => {
    const none = { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] };
    const mappingsResult = await build({ mappings: all, employees }).getMappings(10, { scope: none });
    assert.equal(mappingsResult.total_matched, 0);
    assert.equal(mappingsResult.total_connected, 0);
    assert.equal(mappingsResult.mappings[0].matched_employees, 0);

    const list = await build({ mappings: all, employees }).getMatchedEmployees(10, { scope: none });
    assert.equal(list.employees.length, 0);
    assert.equal(list.total_matched, 0);
  });

  it("a missing scope argument counts nothing, rather than everything", async () => {
    assert.equal((await build({ mappings: all, employees }).getMappings(10, {})).total_matched, 0);
    assert.equal((await build({ mappings: all, employees }).getMappings(10)).total_matched, 0);
    assert.equal(
      (await build({ mappings: all, employees }).getMatchedEmployees(10, {})).employees.length,
      0
    );
  });

  it("an OWN_BRANCHES scope with no branches counts nothing", async () => {
    const result = await build({ mappings: all, employees }).getMappings(10, {
      scope: ownBranches([]),
    });
    assert.equal(result.total_matched, 0);
  });

  it("an employee with no branch is invisible to a branch-scoped caller", async () => {
    const result = await build({
      mappings: all,
      employees: [emp({ employee_id: 9, store_id: null })],
    }).getMappings(10, { scope: ownBranches([5]) });
    assert.equal(result.total_matched, 0, "there is no branch on which they could be authorized");
  });

  it("the employee LIST and the COUNT agree for the same caller", async () => {
    const scope = ownBranches([8]);
    const counts = await build({ mappings: all, employees }).getMappings(10, { scope });
    const list = await build({ mappings: all, employees }).getMatchedEmployees(10, { scope });
    assert.equal(counts.total_matched, list.total_matched);
    assert.equal(list.total_matched, list.employees.length);
    assert.deepEqual(list.employees.map((e) => e.employee_name), ["Bala", "Chitra"]);
  });
});

/* =========================================================== telegram */

describe("the Telegram Connected column", () => {
  const employees = [emp({ employee_id: 1 }), emp({ employee_id: 2 })];
  const mappings = [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)];

  it("is Yes only for an employee with a live identity", async () => {
    const usecase = build({ mappings, employees, connected: [1] });
    const result = await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    const byId = new Map(result.employees.map((e) => [e.employee_id, e.telegram_connected]));
    assert.equal(byId.get(1), true);
    assert.equal(byId.get(2), false);
  });

  it("does not change who matches the mapping", async () => {
    const connectedNone = await build({ mappings, employees, connected: [] }).getMappings(10, { scope: ALL_BRANCHES });
    const connectedAll = await build({ mappings, employees, connected: [1, 2] }).getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(connectedNone.total_matched, connectedAll.total_matched);
    assert.equal(connectedNone.mappings[0].matched_employees, connectedAll.mappings[0].matched_employees);
  });

  it("reports how many of the population are ready", async () => {
    const result = await build({ mappings, employees, connected: [2] }).getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.total_matched, 2);
    assert.equal(result.total_connected, 1);
  });

  it("the CONNECTED count is branch-scoped too", async () => {
    // "9 of the 34 Store Managers are on Telegram" is a fact about other
    // branches' readiness, so it narrows with everything else.
    const branched = [
      emp({ employee_id: 1, store_id: 5 }),
      emp({ employee_id: 2, store_id: 8 }),
      emp({ employee_id: 3, store_id: 8 }),
    ];
    const hr = await build({ mappings, employees: branched, connected: [1, 2, 3] }).getMappings(10, {
      scope: ALL_BRANCHES,
    });
    const mgr = await build({ mappings, employees: branched, connected: [1, 2, 3] }).getMappings(10, {
      scope: ownBranches([8]),
    });
    assert.equal(hr.total_connected, 3);
    assert.equal(mgr.total_connected, 2, "not the company's 3");
  });

  it("the connected lookup stays bulk under scoping", async () => {
    const repo = makeRepo({
      mappings,
      employees: Array.from({ length: 50 }, (_, i) => emp({ employee_id: i + 1, store_id: 8 })),
      connected: [1, 2],
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.getMappings(10, { scope: ownBranches([8]) });
    assert.equal(repo.calls.connected, 1, "one identity read, never one per employee");
    assert.equal(repo.calls.snapshot, 1);
  });
});

/* ============================================================ privacy */

describe("what a matched employee row may contain", () => {
  it("is exactly six fields, and they are the approved six", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
      employees: [emp()],
      connected: [1],
    });
    const [row] = (await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES })).employees;
    assert.deepEqual(Object.keys(row).sort(), [
      "department_name",
      "designation_name",
      "employee_id",
      "employee_name",
      "outlet_name",
      "telegram_connected",
    ]);
  });

  it("leaks nothing sensitive even when the snapshot row carries it", async () => {
    // The row is built by naming what goes IN. A future column on
    // new_employee cannot appear here by accident.
    const loaded = emp({
      primary_contact_number: "9000000001",
      salary: 45000,
      aadhaar_card_no: "1111 2222 3333",
      pan_no: "ABCDE1234F",
      account_no: "123456789",
      esi_number: "31000",
      pf_number: "PF1",
      permanent_address: "somewhere",
      dob: "1990-01-01",
      telegram_username: "raj_t",
      telegram_user_id: 555,
      private_chat_id: 777,
      token_hash: "deadbeef",
    });
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
      employees: [loaded],
      connected: [1],
    });
    const result = await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    const body = JSON.stringify(result);

    for (const secret of [
      "9000000001", "45000", "1111 2222 3333", "ABCDE1234F", "123456789",
      "31000", "PF1", "somewhere", "1990-01-01", "raj_t", "555", "777", "deadbeef",
    ]) {
      assert.ok(!body.includes(secret), `the response must not contain ${secret}`);
    }
  });

  it("the mapping list names no employee at all", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
      employees: [emp({ employee_name: "Raj Kumar" })],
    });
    const body = JSON.stringify(await usecase.getMappings(10, { scope: ALL_BRANCHES }));
    assert.ok(!body.includes("Raj Kumar"), "the rules screen shows counts, not people");
  });

  it("the group summary carries no chat id", async () => {
    const usecase = build({ mappings: [], employees: [] }, { ...GROUP, chat_id: "-1001234567890" });
    const body = JSON.stringify((await usecase.getMappings(10, { scope: ALL_BRANCHES })).group);
    assert.ok(!body.includes("-1001234567890"));
  });
});

/* ========================================================== inference */

describe("a group's NAME creates no membership", () => {
  it("a group called Cashiers with no mappings matches NOBODY", async () => {
    const usecase = build({
      mappings: [],
      employees: [
        emp({ employee_id: 1, designation_name: "Cashier", designation_id: 7 }),
        emp({ employee_id: 2, designation_name: "Cashier", designation_id: 7 }),
      ],
    });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(result.group.group_name, "Cashiers");
    assert.equal(result.mappings.length, 0);
    assert.equal(result.total_matched, 0);

    const list = await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(list.employees.length, 0);
    assert.equal(list.total_matched, 0);
  });

  it("the registry's own outlet does NOT become an outlet mapping", async () => {
    // GROUP.outlet_id is 9. These employees are at outlet 9. Without a
    // mapping row, none of them belongs.
    const usecase = build({
      mappings: [],
      employees: [emp({ employee_id: 1, store_id: 9 }), emp({ employee_id: 2, store_id: 9 })],
    });
    assert.equal((await usecase.getMappings(10, { scope: ALL_BRANCHES })).total_matched, 0);
  });

  it("the category and Used For text create nothing", async () => {
    const usecase = build(
      { mappings: [], employees: [emp()] },
      { ...GROUP, category: "HR", used_for: "All cashiers and store managers" }
    );
    assert.equal((await usecase.getMappings(10, { scope: ALL_BRANCHES })).total_matched, 0);
  });
});

/* ======================================================== performance */

describe("no N+1", () => {
  it("the Map screen is AT MOST SIX reads: 1 mappings + <=3 masters + 1 snapshot + 1 identity", async () => {
    // The bound the comments now state. `resolveTargets` batches by MASTER,
    // so three types present is three reads and one type present is one -
    // never one per mapping.
    const repo = makeRepo({
      mappings: [
        mapping(1, MAPPING_TYPE.ALL_EMPLOYEES),
        mapping(2, MAPPING_TYPE.OUTLET, 1),
        mapping(3, MAPPING_TYPE.OUTLET, 2),
        mapping(4, MAPPING_TYPE.DESIGNATION, 3),
        mapping(5, MAPPING_TYPE.DEPARTMENT, 3),
      ],
      employees: [emp()],
      targets: {
        OUTLET: { 1: { name: "A", active: true }, 2: { name: "B", active: true } },
        DESIGNATION: { 3: { name: "C", active: true } },
        DEPARTMENT: { 3: { name: "D", active: true } },
      },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.getMappings(10, { scope: ALL_BRANCHES });

    assert.equal(repo.calls.byGroup, 1);
    assert.equal(repo.calls.resolveTargets, 1, "one batched call covering every master");
    assert.equal(repo.calls.snapshot, 1);
    assert.equal(repo.calls.connected, 1);
  });

  it("one employee snapshot and one identity read, whatever the mapping count", async () => {
    const employees = Array.from({ length: 200 }, (_, i) =>
      emp({ employee_id: i + 1, store_id: (i % 5) + 1, designation_id: (i % 7) + 1 })
    );
    const mappings = [
      mapping(1, MAPPING_TYPE.ALL_EMPLOYEES),
      mapping(2, MAPPING_TYPE.OUTLET, 1),
      mapping(3, MAPPING_TYPE.OUTLET, 2),
      mapping(4, MAPPING_TYPE.DESIGNATION, 3),
      mapping(5, MAPPING_TYPE.DEPARTMENT, 3),
    ];
    const repo = makeRepo({
      mappings,
      employees,
      connected: [1, 2, 3],
      targets: {
        OUTLET: { 1: { name: "A", active: true }, 2: { name: "B", active: true } },
        DESIGNATION: { 3: { name: "C", active: true } },
        DEPARTMENT: { 3: { name: "D", active: true } },
      },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });

    assert.equal(repo.calls.snapshot, 1, "one employee read for five mappings");
    assert.equal(repo.calls.connected, 1, "one identity read for 200 employees");
    assert.equal(repo.calls.resolveTargets, 1, "targets resolved in one batched call");
    assert.equal(result.mappings.length, 5);
  });

  it("every count on one response comes from ONE snapshot and one date", async () => {
    const repo = makeRepo({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES), mapping(2, MAPPING_TYPE.OUTLET, 5)],
      employees: [emp()],
      targets: { OUTLET: { 5: { name: "ECR", active: true } } },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    const result = await usecase.getMappings(10, { scope: ALL_BRANCHES });
    assert.equal(repo.calls.snapshot, 1);
    assert.equal(result.as_of_date, TODAY);
  });

  it("the employee list is one snapshot too", async () => {
    const repo = makeRepo({
      mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)],
      employees: [emp(), emp({ employee_id: 2 })],
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(repo.calls.snapshot, 1);
    assert.equal(repo.calls.connected, 1, "not one status call per employee");
  });
});
