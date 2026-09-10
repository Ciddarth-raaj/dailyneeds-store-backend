/**
 * Employee Shift Assignment — the rules that decide whether a bulk assignment
 * happens at all.
 *
 *   node --test usecase/employee_work_shift.test.js
 *
 * A fake repository, so these are the rules themselves rather than SQL. What
 * is proven here is mostly refusal: an empty selection, an id that is not an
 * employee, a work shift that does not exist, and a work shift that exists but
 * is switched off. In every one of those the repository's write must never be
 * reached — a partial assignment is the outcome this design exists to prevent.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./employee_work_shift");

const ACTIVE_SHIFT = { work_shift_id: 4, shift_code: "GS1", shift_name: "9 TO 9", active: 1 };
const INACTIVE_SHIFT = { work_shift_id: 9, shift_code: "OLD", shift_name: "Retired", active: 0 };

const makeRepo = ({ shift = ACTIVE_SHIFT, existing = [11, 12, 13], rows = [] } = {}) => {
  const calls = { list: [], assign: [] };
  return {
    calls,
    async listForAssignment(filters) {
      calls.list.push(filters);
      return rows;
    },
    async getActiveWorkShift(id) {
      return shift && Number(shift.work_shift_id) === Number(id) ? shift : null;
    },
    async findExistingEmployeeIds(ids) {
      return ids.filter((id) => existing.includes(id));
    },
    async assignWorkShift(employeeIds, workShiftId) {
      calls.assign.push({ employeeIds, workShiftId });
      return {
        code: 200,
        work_shift_id: workShiftId,
        requested: employeeIds.length,
        matched: employeeIds.length,
        updated: employeeIds.length,
      };
    },
  };
};

/* ============================================================ assigning == */

describe("assign", () => {
  it("assigns the selected employees to an active shift", async () => {
    const repo = makeRepo();
    const result = await buildUsecase(repo).assign({
      employee_ids: [11, 12],
      work_shift_id: 4,
    });

    assert.equal(result.code, 200);
    assert.equal(result.work_shift_id, 4);
    assert.equal(result.requested, 2);
    assert.equal(result.matched, 2);
    // The screen's confirmation and toast name the shift, so it comes back.
    assert.equal(result.shift_code, "GS1");
    assert.equal(result.shift_name, "9 TO 9");
    assert.deepEqual(repo.calls.assign, [{ employeeIds: [11, 12], workShiftId: 4 }]);
  });

  it("deduplicates employee ids, including string and number forms of one id", async () => {
    const repo = makeRepo();
    const result = await buildUsecase(repo).assign({
      employee_ids: [11, "11", 12, 11],
      work_shift_id: 4,
    });

    assert.equal(result.code, 200);
    assert.deepEqual(repo.calls.assign[0].employeeIds, [11, 12]);
    assert.equal(result.requested, 2);
  });

  it("refuses an empty selection and writes nothing", async () => {
    const repo = makeRepo();
    await assert.rejects(
      () => buildUsecase(repo).assign({ employee_ids: [], work_shift_id: 4 }),
      (err) => err.name === "ValidationError" && /at least one employee/i.test(err.message)
    );
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses a missing employee_ids and writes nothing", async () => {
    const repo = makeRepo();
    await assert.rejects(
      () => buildUsecase(repo).assign({ work_shift_id: 4 }),
      (err) => err.name === "ValidationError"
    );
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses an employee id that is not a positive integer", async () => {
    const repo = makeRepo();
    for (const bad of [0, -3, 1.5, "abc", null]) {
      await assert.rejects(
        () => buildUsecase(repo).assign({ employee_ids: [11, bad], work_shift_id: 4 }),
        (err) => err.name === "ValidationError"
      );
    }
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses a missing work_shift_id", async () => {
    const repo = makeRepo();
    await assert.rejects(
      () => buildUsecase(repo).assign({ employee_ids: [11] }),
      (err) => err.name === "ValidationError" && /work_shift_id/.test(err.message)
    );
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses a work shift that does not exist", async () => {
    const repo = makeRepo();
    const result = await buildUsecase(repo).assign({ employee_ids: [11], work_shift_id: 999 });

    assert.equal(result.code, 404);
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses an INACTIVE work shift", async () => {
    const repo = makeRepo({ shift: INACTIVE_SHIFT });
    const result = await buildUsecase(repo).assign({ employee_ids: [11], work_shift_id: 9 });

    assert.equal(result.code, 422);
    assert.match(result.msg, /inactive/i);
    assert.equal(repo.calls.assign.length, 0);
  });

  it("ALL OR NOTHING: one unknown employee refuses the whole request", async () => {
    const repo = makeRepo({ existing: [11, 12] });
    const result = await buildUsecase(repo).assign({
      employee_ids: [11, 12, 77, 88],
      work_shift_id: 4,
    });

    assert.equal(result.code, 422);
    assert.deepEqual(result.rejected_employee_ids, [77, 88]);
    // The eleven and twelve that DID exist are not assigned either.
    assert.equal(repo.calls.assign.length, 0);
  });

  it("refuses a selection above the per-request limit", async () => {
    const repo = makeRepo();
    const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);
    await assert.rejects(
      () => buildUsecase(repo).assign({ employee_ids: tooMany, work_shift_id: 4 }),
      (err) => err.name === "ValidationError" && /limit is 1000/.test(err.message)
    );
    assert.equal(repo.calls.assign.length, 0);
  });
});

/* ================================================================ list == */

describe("list", () => {
  const ROW = {
    employee_id: "11",
    employee_name: "Ada",
    status: 1,
    store_id: 2,
    outlet_name: "Anna Nagar",
    department_id: 3,
    department_name: "Billing",
    designation_id: 4,
    designation_name: "Cashier",
    default_work_shift_id: 4,
    work_shift_code: "GS1",
    work_shift_name: "9 TO 9",
    work_shift_active: 1,
  };

  it("returns the assignment columns, with ids as numbers", async () => {
    const usecase = buildUsecase(makeRepo({ rows: [ROW] }));
    const result = await usecase.list({});

    assert.equal(result.code, 200);
    assert.deepEqual(result.data, [
      {
        employee_id: 11,
        employee_name: "Ada",
        status: 1,
        store_id: 2,
        outlet_name: "Anna Nagar",
        department_id: 3,
        department_name: "Billing",
        designation_id: 4,
        designation_name: "Cashier",
        default_work_shift_id: 4,
        work_shift_code: "GS1",
        work_shift_name: "9 TO 9",
        work_shift_active: true,
      },
    ]);
  });

  it("reports an unassigned employee as null rather than as anything guessed", async () => {
    const unassigned = {
      ...ROW,
      default_work_shift_id: null,
      work_shift_code: null,
      work_shift_name: null,
      work_shift_active: null,
    };
    const usecase = buildUsecase(makeRepo({ rows: [unassigned] }));
    const result = await usecase.list({});

    assert.equal(result.data[0].default_work_shift_id, null);
    assert.equal(result.data[0].work_shift_code, null);
    assert.equal(result.data[0].work_shift_active, null);
  });

  it("defaults to ACTIVE employees and ALL assignment states", async () => {
    const repo = makeRepo();
    await buildUsecase(repo).list({});

    assert.equal(repo.calls.list[0].employment_status, "ACTIVE");
    assert.equal(repo.calls.list[0].assignment_status, "ALL");
  });

  it("passes the filters through, accepting comma lists and arrays alike", async () => {
    const repo = makeRepo();
    await buildUsecase(repo).list({
      store_ids: "2,3",
      department_ids: ["4"],
      designation_ids: "5, 6",
      assignment_status: "unassigned",
      employment_status: "all",
      search: " Ada ",
    });

    const filters = repo.calls.list[0];
    assert.deepEqual(filters.store_ids, [2, 3]);
    assert.deepEqual(filters.department_ids, [4]);
    assert.deepEqual(filters.designation_ids, [5, 6]);
    assert.equal(filters.assignment_status, "UNASSIGNED");
    assert.equal(filters.employment_status, "ALL");
    assert.equal(filters.search, " Ada ");
  });

  it("refuses a filter value it does not recognise rather than ignoring it", async () => {
    const repo = makeRepo();
    await assert.rejects(
      () => buildUsecase(repo).list({ assignment_status: "MAYBE" }),
      (err) => err.name === "ValidationError"
    );
    await assert.rejects(
      () => buildUsecase(repo).list({ store_ids: "2,not-an-id" }),
      (err) => err.name === "ValidationError"
    );
    assert.equal(repo.calls.list.length, 0);
  });
});
