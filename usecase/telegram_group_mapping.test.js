/**
 * Telegram Group Mapping - who a group's rules resolve to. Phase 3A.
 *
 *   node --test usecase/telegram_group_mapping.test.js
 *
 * The rules under test, in the order they matter:
 *
 *   EMPLOYMENT IS DATED, NOT `status`. A resigned employee carrying
 *   `status = 1` is the production trap this whole file exists to pin.
 *   COUNTS ARE GLOBAL, NAMES ARE SCOPED. The same rule shows 34 to everybody
 *   and lists 12 to a branch manager.
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
} = require("../constants/telegram_group_mapping");
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
    findDuplicate: async (groupId, type, target) =>
      mappings.find(
        (m) => m.telegram_group_id === groupId && m.mapping_type === type && m.target_id === target
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

const mapping = (id, type, target = ALL_EMPLOYEES_TARGET_ID) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: 10,
  mapping_type: type,
  target_id: target,
});

const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };
const ownBranches = (ids) => ({ kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: ids });

/* ============================================================ persistence */

describe("adding a mapping", () => {
  it("stores target_id 0 for ALL_EMPLOYEES, never NULL", async () => {
    const repo = makeRepo();
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES });

    assert.equal(repo.calls.created.length, 1);
    assert.equal(repo.calls.created[0].target_id, ALL_EMPLOYEES_TARGET_ID);
    assert.notEqual(repo.calls.created[0].target_id, null);
  });

  it("refuses a target alongside ALL_EMPLOYEES instead of ignoring it", async () => {
    const usecase = build({});
    await assert.rejects(
      () => usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES, target_id: 5 }),
      /takes no target/
    );
  });

  for (const type of [MAPPING_TYPE.OUTLET, MAPPING_TYPE.DESIGNATION, MAPPING_TYPE.DEPARTMENT]) {
    it(`${type} requires a positive target that exists`, async () => {
      const targets = { [type]: { 5: { name: "Something", active: true } } };
      const usecase = build({ targets });

      for (const bad of [undefined, null, "", 0, -1, "abc", 2.5, {}]) {
        await assert.rejects(
          () => usecase.addMapping(10, { mapping_type: type, target_id: bad }),
          /Select what this mapping applies to/,
          `target_id ${JSON.stringify(bad)} must be refused`
        );
      }
      await assert.rejects(
        () => usecase.addMapping(10, { mapping_type: type, target_id: 404 }),
        /no longer exists/
      );
      const ok = await usecase.addMapping(10, { mapping_type: type, target_id: 5 });
      assert.equal(ok.code, 200);
    });
  }

  it("refuses an unsupported mapping type", async () => {
    const usecase = build({});
    for (const type of ["SELECTED_EMPLOYEES", "MANUAL", "ROLE", "USER", "", null, "outlet"]) {
      await assert.rejects(
        () => usecase.addMapping(10, { mapping_type: type, target_id: 1 }),
        /Mapping Type must be one of/,
        `${type} must not be accepted`
      );
    }
  });

  it("rejects a duplicate with a sentence, not a driver error", async () => {
    const usecase = build({ mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)] });
    await assert.rejects(
      () => usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES }),
      (err) => err.message === MAPPING_MESSAGES.DUPLICATE
    );
  });

  it("turns the UNIQUE index violation into the same sentence", async () => {
    // Two requests can pass the pre-check in the same instant; the index is
    // what actually decides, and the loser must not see ER_DUP_ENTRY.
    const err = new Error("ER_DUP_ENTRY: Duplicate entry");
    err.code = "ER_DUP_ENTRY";
    const usecase = build({ createThrows: err });
    await assert.rejects(
      () => usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES }),
      (e) => e.message === MAPPING_MESSAGES.DUPLICATE && e.name === "ValidationError"
    );
  });

  it("does not disguise an unrelated database failure as a duplicate", async () => {
    const usecase = build({ createThrows: new Error("ER_LOCK_WAIT_TIMEOUT") });
    await assert.rejects(() => usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES }), /LOCK_WAIT/);
  });

  it("allows several DIFFERENT mappings on one group", async () => {
    const repo = makeRepo({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      targets: { DESIGNATION: { 7: { name: "Cashier", active: true } } },
    });
    const usecase = buildMapping(repo, makeRegistry(), { now: () => NOW });
    await usecase.addMapping(10, { mapping_type: MAPPING_TYPE.DESIGNATION, target_id: 7 });
    assert.equal(repo.calls.created.length, 1);
  });

  it("refuses to map onto a group that does not exist", async () => {
    const usecase = buildMapping(makeRepo(), makeRegistry(null), { now: () => NOW });
    await assert.rejects(() => usecase.addMapping(10, { mapping_type: MAPPING_TYPE.ALL_EMPLOYEES }), /not found/);
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
    const result = await usecase.getMappings(10);
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
    const result = await usecase.getMappings(10);
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
    const result = await late.getMappings(10);
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
    const result = await usecase.getMappings(10);
    // 1 and 2 by outlet, 1 and 3 by designation -> {1,2,3}, not just {1}.
    assert.equal(result.total_matched, 3);
  });

  it("counts each rule independently, even where they overlap", async () => {
    const usecase = build({ mappings, employees, targets });
    const result = await usecase.getMappings(10);
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
    const row = (await usecase.getMappings(10)).mappings[0];
    assert.equal(row.target_state, TARGET_STATE.ACTIVE);
    assert.equal(row.target_warning, null);
    assert.equal(row.target_name, "ECR");
  });

  it("INACTIVE target: mapping preserved, warned, and STILL MATCHING", async () => {
    // Retiring an outlet does not retire the people assigned to it. Showing
    // zero would hide them.
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: { 5: { name: "ECR (closed)", active: false } } },
    });
    const row = (await usecase.getMappings(10)).mappings[0];
    assert.equal(row.target_state, TARGET_STATE.INACTIVE);
    assert.equal(row.target_warning, TARGET_WARNING.INACTIVE);
    assert.equal(row.matched_employees, 1, "the stored target id still matches");
  });

  it("MISSING target: mapping preserved and warned differently", async () => {
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees,
      targets: { OUTLET: {} },
    });
    const row = (await usecase.getMappings(10)).mappings[0];
    assert.equal(row.target_state, TARGET_STATE.MISSING);
    assert.equal(row.target_warning, TARGET_WARNING.MISSING);
    assert.notEqual(TARGET_WARNING.MISSING, TARGET_WARNING.INACTIVE);
  });

  it("a VALID target matching nobody carries NO warning", async () => {
    // The distinction the whole design turns on: zero is not broken.
    const usecase = build({
      mappings: [mapping(1, MAPPING_TYPE.OUTLET, 5)],
      employees: [emp({ employee_id: 1, store_id: 99 })],
      targets: { OUTLET: { 5: { name: "ECR", active: true } } },
    });
    const row = (await usecase.getMappings(10)).mappings[0];
    assert.equal(row.matched_employees, 0);
    assert.equal(row.target_warning, null);
    assert.equal(row.target_state, TARGET_STATE.ACTIVE);
  });

  it("ALL_EMPLOYEES has no target to be broken", async () => {
    const usecase = build({ mappings: [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)], employees });
    const row = (await usecase.getMappings(10)).mappings[0];
    assert.equal(row.target_state, TARGET_STATE.NOT_APPLICABLE);
    assert.equal(row.target_warning, null);
    assert.equal(row.target_id, null);
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
    const result = await usecase.getMappings(10);
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
    assert.equal((await usecase.getMappings(10)).group.inactive_notice, null);
  });
});

/* ============================================================= scope */

describe("global counts, scoped names", () => {
  const employees = [
    emp({ employee_id: 1, store_id: 5, employee_name: "Anitha" }),
    emp({ employee_id: 2, store_id: 8, employee_name: "Bala" }),
    emp({ employee_id: 3, store_id: 8, employee_name: "Chitra" }),
  ];
  const mappings = [mapping(1, MAPPING_TYPE.ALL_EMPLOYEES)];

  it("HR/Admin sees every name", async () => {
    const usecase = build({ mappings, employees });
    const result = await usecase.getMatchedEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(result.total_matched, 3);
    assert.equal(result.visible_count, 3);
    assert.equal(result.scope_limited, false);
  });

  it("a branch manager sees the SAME total but only their own names", async () => {
    const usecase = build({ mappings, employees });
    const result = await usecase.getMatchedEmployees(10, { scope: ownBranches([8]) });
    assert.equal(result.total_matched, 3, "the company-wide count must not shrink");
    assert.equal(result.visible_count, 2);
    assert.equal(result.scope_limited, true);
    assert.deepEqual(result.employees.map((e) => e.employee_name), ["Bala", "Chitra"]);
  });

  it("the count is identical for the manager and for HR", async () => {
    const hr = await build({ mappings, employees }).getMatchedEmployees(10, { scope: ALL_BRANCHES });
    const mgr = await build({ mappings, employees }).getMatchedEmployees(10, {
      scope: ownBranches([5]),
    });
    assert.equal(hr.total_matched, mgr.total_matched);
    assert.notEqual(hr.visible_count, mgr.visible_count);
  });

  it("a NONE scope returns no names at all - it fails CLOSED", async () => {
    const usecase = build({ mappings, employees });
    const result = await usecase.getMatchedEmployees(10, {
      scope: { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: [] },
    });
    assert.equal(result.employees.length, 0);
    assert.equal(result.total_matched, 3, "the count is still the truth");
  });

  it("a missing scope argument returns no names, rather than all of them", async () => {
    const usecase = build({ mappings, employees });
    assert.equal((await usecase.getMatchedEmployees(10, {})).employees.length, 0);
    assert.equal((await usecase.getMatchedEmployees(10)).employees.length, 0);
  });

  it("an employee with no branch is not visible to a branch-scoped caller", async () => {
    const usecase = build({ mappings, employees: [emp({ employee_id: 9, store_id: null })] });
    const result = await usecase.getMatchedEmployees(10, { scope: ownBranches([5]) });
    assert.equal(result.employees.length, 0);
    assert.equal(result.total_matched, 1);
  });

  it("the mapping screen's counts do not vary by actor at all", async () => {
    // getMappings takes no scope: there are no names in it to scope.
    const result = await build({ mappings, employees }).getMappings(10);
    assert.equal(result.total_matched, 3);
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
    const connectedNone = await build({ mappings, employees, connected: [] }).getMappings(10);
    const connectedAll = await build({ mappings, employees, connected: [1, 2] }).getMappings(10);
    assert.equal(connectedNone.total_matched, connectedAll.total_matched);
    assert.equal(connectedNone.mappings[0].matched_employees, connectedAll.mappings[0].matched_employees);
  });

  it("reports how many of the population are ready", async () => {
    const result = await build({ mappings, employees, connected: [2] }).getMappings(10);
    assert.equal(result.total_matched, 2);
    assert.equal(result.total_connected, 1);
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
    const body = JSON.stringify(await usecase.getMappings(10));
    assert.ok(!body.includes("Raj Kumar"), "the rules screen shows counts, not people");
  });

  it("the group summary carries no chat id", async () => {
    const usecase = build({ mappings: [], employees: [] }, { ...GROUP, chat_id: "-1001234567890" });
    const body = JSON.stringify((await usecase.getMappings(10)).group);
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
    const result = await usecase.getMappings(10);
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
    assert.equal((await usecase.getMappings(10)).total_matched, 0);
  });

  it("the category and Used For text create nothing", async () => {
    const usecase = build(
      { mappings: [], employees: [emp()] },
      { ...GROUP, category: "HR", used_for: "All cashiers and store managers" }
    );
    assert.equal((await usecase.getMappings(10)).total_matched, 0);
  });
});

/* ======================================================== performance */

describe("no N+1", () => {
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
    const result = await usecase.getMappings(10);

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
    const result = await usecase.getMappings(10);
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
