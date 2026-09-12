/**
 * Attendance Approver Setup - the usecase over a fake repository.
 *
 *   node --test usecase/attendance_approver_setup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUsecase = require("./attendance_approver_setup");

const EMPLOYEES = {
  1: { employee_id: 1, employee_name: "Store Staff", status: 1, store_id: 3, store_name: "DN3", designation_id: 5, designation_name: "SALES", department_id: 2, department_name: "STORE" },
  2: { employee_id: 2, employee_name: "Store Staff 2", status: 1, store_id: 3, store_name: "DN3", designation_id: 5, designation_name: "SALES", department_id: 2, department_name: "STORE" },
  11: { employee_id: 11, employee_name: "Store Manager", status: 1, store_id: 3, designation_name: "STORE MANAGER" },
  22: { employee_id: 22, employee_name: "Ops Manager", status: 1, designation_name: "OPERATIONS MANAGER" },
  33: { employee_id: 33, employee_name: "HR", status: 1, designation_name: "HR EXECUTIVE" },
  44: { employee_id: 44, employee_name: "New HR", status: 1, designation_name: "HR EXECUTIVE" },
  99: { employee_id: 99, employee_name: "Resigned Manager", status: 0, designation_name: "STORE MANAGER" },
};

function fakes(state = {}) {
  const calls = { saved: [], replaced: [], listed: [], counted: [] };
  const setups = new Map(Object.entries(state.setups || {}).map(([k, v]) => [Number(k), { is_active: 1, ...v }]));
  const repo = {
    calls,
    setups,
    getEmployeesByIds: async (ids) => ids.map((id) => EMPLOYEES[id]).filter(Boolean),
    getSetup: async (id) => setups.get(Number(id)) || null,
    getActiveSetup: async (id) => setups.get(Number(id)) || null,
    saveSetup: async (args) => {
      calls.saved.push(args);
      if (state.saveThrowsFor && state.saveThrowsFor.includes(args.setup.employee_id)) throw new Error("db down");
      setups.set(args.setup.employee_id, { ...args.setup, is_active: 1 });
      return { code: 200 };
    },
    listEmployeesWithSetup: async (f) => { calls.listed.push(f); return state.rows || []; },
    countEmployeesWithSetup: async (f) => { calls.counted.push(f); return (state.rows || []).length; },
    findSetupsWithApprover: async (level, id) => state.setupsWith ? state.setupsWith(level, id) : [],
    findPendingStepsWithApprover: async (level, id) => state.stepsWith ? state.stepsWith(level, id) : [],
    replaceApprover: async (args) => { calls.replaced.push(args); return { code: 200, setups_updated: args.setup_employee_ids.length, pending_steps_updated: args.step_ids.length }; },
    listApproverOptions: async ({ include_inactive }) => Object.values(EMPLOYEES).filter((e) => include_inactive || e.status === 1),
    listCurrentApprovers: async () => [],
    listAudit: async () => [],
  };
  return { repo, usecase: buildUsecase(repo) };
}
const actor = { employee_id: 500, user_type: 2 };

describe("save - one employee (SET)", () => {
  it("1. creates a mapping with all three levels and audits SET per level", async () => {
    const { repo, usecase } = fakes();
    const res = await usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 });
    assert.equal(res.code, 200);
    assert.equal(repo.calls.saved.length, 1);
    const saved = repo.calls.saved[0];
    assert.equal(saved.action_type, "SET");
    assert.equal(saved.actor_employee_id, 500);
    assert.deepEqual(saved.setup, { employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 });
    assert.deepEqual(saved.audit, [
      { approval_level: "FIRST", old_approver_employee_id: null, new_approver_employee_id: 11 },
      { approval_level: "SECOND", old_approver_employee_id: null, new_approver_employee_id: 22 },
      { approval_level: "FINAL", old_approver_employee_id: null, new_approver_employee_id: 33 },
    ]);
    assert.equal(res.setup.final_approver_employee_id, 33);
  });
  it("2. updates an existing mapping and audits only the levels that changed, old -> new", async () => {
    const { repo, usecase } = fakes({ setups: { 1: { employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 } } });
    await usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: null, final_approver_employee_id: 44 });
    assert.deepEqual(repo.calls.saved[0].audit, [
      { approval_level: "SECOND", old_approver_employee_id: 22, new_approver_employee_id: null },
      { approval_level: "FINAL", old_approver_employee_id: 33, new_approver_employee_id: 44 },
    ]);
  });
  it("3. Final Approver is mandatory", async () => {
    const { repo, usecase } = fakes();
    await assert.rejects(usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 11 }), /Final Approver is required/);
    assert.equal(repo.calls.saved.length, 0);
  });
  it("4. First Level is optional; 5. Second Level is optional", async () => {
    const { repo, usecase } = fakes();
    await usecase.save({ actor, employee_id: 1, second_level_approver_employee_id: 22, final_approver_employee_id: 33 });
    await usecase.save({ actor, employee_id: 2, first_level_approver_employee_id: 11, final_approver_employee_id: 33 });
    await usecase.save({ actor, employee_id: 1, final_approver_employee_id: 33 });
    assert.equal(repo.calls.saved.length, 3);
    assert.equal(repo.calls.saved[0].setup.first_level_approver_employee_id, null);
    assert.equal(repo.calls.saved[1].setup.second_level_approver_employee_id, null);
  });
  it("6. an employee cannot be their own approver", async () => {
    const { usecase } = fakes();
    await assert.rejects(usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 1, final_approver_employee_id: 33 }), /own approver/);
    await assert.rejects(usecase.save({ actor, employee_id: 1, final_approver_employee_id: 1 }), /own approver/);
  });
  it("6b. the same person cannot hold two levels of one employee's chain", async () => {
    const { repo, usecase } = fakes();
    await assert.rejects(usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 33, final_approver_employee_id: 33 }), /must be different people/);
    await assert.rejects(usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 33, final_approver_employee_id: 33 }), /must be different people/);
    assert.equal(repo.calls.saved.length, 0);
    const res = await usecase.bulkSet({ actor, employee_ids: [1, 2], second_level_approver_employee_id: 22, final_approver_employee_id: 22 });
    assert.equal(res.status, "FAILED");
    res.failed.forEach((f) => assert.match(f.message, /must be different people/));
  });
  it("7. an inactive employee cannot be newly assigned as an approver", async () => {
    const { usecase } = fakes();
    await assert.rejects(usecase.save({ actor, employee_id: 1, first_level_approver_employee_id: 99, final_approver_employee_id: 33 }), /not active/);
  });
  it("refuses an unknown employee or approver", async () => {
    const { usecase } = fakes();
    await assert.rejects(usecase.save({ actor, employee_id: 12345, final_approver_employee_id: 33 }), /No such employee/);
    await assert.rejects(usecase.save({ actor, employee_id: 1, final_approver_employee_id: 12345 }), /no such employee/);
  });
});

describe("bulkSet (BULK_SET)", () => {
  it("8. sets the same chain on every selected employee, one save and audit each", async () => {
    const { repo, usecase } = fakes();
    const res = await usecase.bulkSet({ actor, employee_ids: [1, 2], first_level_approver_employee_id: 11, final_approver_employee_id: 33 });
    assert.equal(res.status, "COMPLETED");
    assert.equal(res.success_count, 2);
    assert.equal(res.failed_count, 0);
    assert.equal(repo.calls.saved.length, 2);
    repo.calls.saved.forEach((s) => assert.equal(s.action_type, "BULK_SET"));
  });
  it("9. validates each employee individually and reports partial failure honestly", async () => {
    const { repo, usecase } = fakes();
    // 11 would be their own First Level approver; 1 and 2 are fine.
    const res = await usecase.bulkSet({ actor, employee_ids: [1, 11, 2], first_level_approver_employee_id: 11, final_approver_employee_id: 33 });
    assert.equal(res.status, "COMPLETED_WITH_ERRORS");
    assert.equal(res.success_count, 2);
    assert.deepEqual(res.failed.map((f) => f.employee_id), [11]);
    assert.match(res.failed[0].message, /own approver/);
    assert.deepEqual(repo.calls.saved.map((s) => s.setup.employee_id), [1, 2]);
  });
  it("a storage failure on one employee is reported for that employee, not hidden in a green total", async () => {
    const { usecase } = fakes({ saveThrowsFor: [2] });
    const res = await usecase.bulkSet({ actor, employee_ids: [1, 2], final_approver_employee_id: 33 });
    assert.equal(res.status, "COMPLETED_WITH_ERRORS");
    assert.deepEqual(res.failed.map((f) => f.employee_id), [2]);
  });
  it("Final is required in bulk as well", async () => {
    const { usecase } = fakes();
    const res = await usecase.bulkSet({ actor, employee_ids: [1, 2], first_level_approver_employee_id: 11 });
    assert.equal(res.status, "FAILED");
    assert.equal(res.success_count, 0);
  });
});

describe("list - the setup screen's filters", () => {
  const filterCase = (n, key, value) =>
    it(`${n}. filters by ${key}`, async () => {
      const { repo, usecase } = fakes();
      await usecase.list({ [key]: value });
      assert.equal(repo.calls.listed[0][key], Number(value));
      assert.equal(repo.calls.counted[0][key], Number(value));
    });
  filterCase(10, "department_id", "2");
  filterCase(11, "store_id", "3");
  filterCase(12, "designation_id", "5");
  filterCase(13, "employee_id", "1");
  it("13b. search text is passed through, and the row shape carries ids plus resolved names only", async () => {
    const { repo, usecase } = fakes({ rows: [{ ...EMPLOYEES[1], attendance_approver_setup_id: 9, final_approver_employee_id: 33, final_approver_name: "HR", final_approver_status: 1 }] });
    const res = await usecase.list({ search: "sta" });
    assert.equal(repo.calls.listed[0].search, "sta");
    assert.equal(res.total, 1);
    const row = res.rows[0];
    assert.equal(row.has_setup, true);
    assert.equal(row.final_approver_name, "HR");
    assert.equal(row.first_level_approver_employee_id, null);
    for (const k of Object.keys(row)) assert.ok(!/salary|bank|aadhaar|pan|contact/i.test(k), k);
  });
});

describe("replace (REPLACE)", () => {
  const withData = () => fakes({
    setups: {
      1: { employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 },
      2: { employee_id: 2, first_level_approver_employee_id: 11, second_level_approver_employee_id: null, final_approver_employee_id: 33 },
    },
    setupsWith: (level, id) => (level === "SECOND" && id === 22 ? [{ employee_id: 1 }] : level === "FIRST" && id === 11 ? [{ employee_id: 1 }, { employee_id: 2 }] : []),
    stepsWith: (level, id) =>
      level === "SECOND" && id === 22
        ? [
            { attendance_approval_step_id: 901, attendance_approval_request_id: 90, stage_no: 2, request_type: "REGULARIZATION", requested_for_employee_id: 1, requested_by_employee_id: 1 },
            { attendance_approval_step_id: 911, attendance_approval_request_id: 91, stage_no: 2, request_type: "OT", requested_for_employee_id: 2, requested_by_employee_id: 2 },
          ]
        : [],
  });
  it("21. updates the future master mapping at that level only, with a REPLACE plan", async () => {
    const { repo, usecase } = withData();
    const res = await usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 44 });
    assert.equal(res.code, 200);
    assert.equal(repo.calls.replaced.length, 1);
    const r = repo.calls.replaced[0];
    assert.equal(r.level, "SECOND");
    assert.deepEqual(r.setup_employee_ids, [1]);
    assert.equal(r.old_approver_employee_id, 22);
    assert.equal(r.new_approver_employee_id, 44);
    assert.equal(res.setups_updated, 1);
  });
  it("22. and 23. reassigns the undecided pending Regularization AND OT steps at that level", async () => {
    const { repo, usecase } = withData();
    const res = await usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 44 });
    assert.deepEqual(repo.calls.replaced[0].step_ids, [901, 911]);
    assert.equal(res.pending_regularization_steps, 1);
    assert.equal(res.pending_ot_steps, 1);
    assert.equal(res.pending_steps_updated, 2);
  });
  it("only steps the repository reports as PENDING on PENDING requests are ever named", async () => {
    // The fake returns what the SQL returns: the repository test proves the
    // SQL itself excludes decided steps and closed requests.
    const { repo, usecase } = withData();
    await usecase.replace({ actor, current_approver_employee_id: 11, approval_level: "FIRST", new_approver_employee_id: 44 });
    assert.deepEqual(repo.calls.replaced[0].step_ids, []);
    assert.deepEqual(repo.calls.replaced[0].setup_employee_ids, [1, 2]);
  });
  it("skips a step whose request belongs to the new approver, and a master row where they would approve themselves", async () => {
    const { repo, usecase } = fakes({
      setupsWith: () => [{ employee_id: 1 }, { employee_id: 44 }],
      stepsWith: () => [
        { attendance_approval_step_id: 1, attendance_approval_request_id: 10, request_type: "OT", requested_for_employee_id: 44, requested_by_employee_id: 44 },
        { attendance_approval_step_id: 2, attendance_approval_request_id: 11, request_type: "OT", requested_for_employee_id: 1, requested_by_employee_id: 1 },
      ],
    });
    const res = await usecase.replace({ actor, current_approver_employee_id: 33, approval_level: "FINAL", new_approver_employee_id: 44 });
    assert.deepEqual(repo.calls.replaced[0].setup_employee_ids, [1]);
    assert.deepEqual(repo.calls.replaced[0].step_ids, [2]);
    assert.equal(res.skipped_setups.length, 1);
    assert.equal(res.skipped_steps.length, 1);
  });
  it("skips a master row or a live step where the new approver would then hold two levels of one chain", async () => {
    const { repo, usecase } = fakes({
      // employee 1: 44 is already First Level; employee 2: fine.
      setupsWith: () => [
        { employee_id: 1, first_level_approver_employee_id: 44, second_level_approver_employee_id: 22, final_approver_employee_id: 33 },
        { employee_id: 2, first_level_approver_employee_id: 11, second_level_approver_employee_id: 22, final_approver_employee_id: 33 },
      ],
      stepsWith: () => [
        { attendance_approval_step_id: 1, attendance_approval_request_id: 10, request_type: "OT", requested_for_employee_id: 1, requested_by_employee_id: 1, other_approver_ids: "44,33" },
        { attendance_approval_step_id: 2, attendance_approval_request_id: 11, request_type: "REGULARIZATION", requested_for_employee_id: 2, requested_by_employee_id: 2, other_approver_ids: "11,33" },
      ],
    });
    const res = await usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 44 });
    assert.deepEqual(repo.calls.replaced[0].setup_employee_ids, [2]);
    assert.deepEqual(repo.calls.replaced[0].step_ids, [2]);
    assert.match(res.skipped_setups[0].message, /already the First Level/);
    assert.match(res.skipped_steps[0].message, /another stage of this request/);
  });
  it("preview computes the plan and writes nothing", async () => {
    const { repo, usecase } = withData();
    const res = await usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 44, preview: true });
    assert.equal(res.preview, true);
    assert.equal(res.setups_matched, 1);
    assert.equal(res.pending_steps_matched, 2);
    assert.equal(repo.calls.replaced.length, 0);
  });
  it("8v. cannot replace with the same employee; the new approver must be active; the current one may be resigned", async () => {
    const { usecase, repo } = fakes({ setupsWith: () => [{ employee_id: 1 }] });
    await assert.rejects(usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 22 }), /different employee/);
    await assert.rejects(usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "SECOND", new_approver_employee_id: 99 }), /not active/);
    await assert.rejects(usecase.replace({ actor, current_approver_employee_id: 22, approval_level: "OTHER", new_approver_employee_id: 44 }), /FIRST, SECOND or FINAL/);
    const res = await usecase.replace({ actor, current_approver_employee_id: 99, approval_level: "FIRST", new_approver_employee_id: 44 });
    assert.equal(res.current_approver_active, false);
    assert.equal(repo.calls.replaced.length, 1);
  });
});

describe("options", () => {
  it("offers active employees for new assignments and includes resigned ones only when asked", async () => {
    const { usecase } = fakes();
    const active = await usecase.options({});
    assert.ok(active.every((e) => e.is_active));
    const all = await usecase.options({ include_inactive: true });
    assert.ok(all.some((e) => e.employee_id === 99 && e.is_active === false));
    for (const k of Object.keys(all[0])) assert.ok(!/salary|bank|aadhaar|pan|contact/i.test(k), k);
  });
});
