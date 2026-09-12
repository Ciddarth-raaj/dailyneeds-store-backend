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

const makeRepo = ({
  shift = ACTIVE_SHIFT,
  existing = [11, 12, 13],
  rows = [],
  employeeShifts = {},
  workingTimes = {},
} = {}) => {
  const calls = { list: [], assign: [], current: [] };
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
    async getEmployeeWorkShift(employeeId) {
      calls.current.push(Number(employeeId));
      return Object.prototype.hasOwnProperty.call(employeeShifts, employeeId)
        ? employeeShifts[employeeId]
        : null;
    },
    async getWorkShiftWorkingTimes(workShiftId) {
      return workingTimes[workShiftId] || [];
    },
    async assignWorkShift(employeeIds, workShiftId, options = {}) {
      calls.assign.push({ employeeIds, workShiftId, options });
      return {
        code: 200,
        work_shift_id: workShiftId,
        requested: employeeIds.length,
        matched: employeeIds.length,
        updated: employeeIds.length,
      };
    },
    async correctAssignment(args) {
      calls.corrected = calls.corrected || [];
      calls.corrected.push(args);
      return {
        code: 200,
        employee_work_shift_assignment_id: 991,
        employee_id: args.employeeId,
        work_shift_id: args.workShiftId,
        effective_from: args.effectiveFrom,
        source: "CORRECTION",
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
    assert.equal(repo.calls.assign.length, 1);
    assert.deepEqual(repo.calls.assign[0].employeeIds, [11, 12]);
    assert.equal(repo.calls.assign[0].workShiftId, 4);
    // A0: the history row is dated by the server, and the actor is stamped on it.
    assert.match(repo.calls.assign[0].options.effective_from, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(repo.calls.assign[0].options.created_by, null);
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

/* ============================ one employee's shift, for the profile ====== */

/**
 * The profile's read. What matters here is that it can only ever describe the
 * NEW mapping, that "unassigned" survives as its own answer rather than being
 * dressed up as a shift, and that a timing which genuinely varies by weekday
 * says so instead of one day speaking for the rest.
 */
describe("currentForEmployee", () => {
  const ASSIGNED = {
    employee_id: 11,
    default_work_shift_id: 4,
    work_shift_code: "GS1",
    work_shift_name: "9 TO 9",
    work_shift_active: 1,
  };

  it("names the assigned shift and its timing", async () => {
    const repo = makeRepo({
      employeeShifts: { 11: ASSIGNED },
      workingTimes: { 4: [{ in_time: "09:00:00", out_time: "21:00:00" }] },
    });
    const res = await buildUsecase(repo).currentForEmployee(11);
    assert.equal(res.code, 200);
    assert.deepEqual(res.data, {
      employee_id: 11,
      assigned: true,
      work_shift_id: 4,
      shift_code: "GS1",
      shift_name: "9 TO 9",
      shift_active: true,
      timing: "09:00 - 21:00",
      timings: [{ in_time: "09:00", out_time: "21:00" }],
    });
  });

  it("UNASSIGNED IS ITS OWN ANSWER, not a blank shift", async () => {
    // The profile has to be able to tell "nobody has assigned this person"
    // from "the shift could not be loaded"; only the first is somebody's job.
    const repo = makeRepo({
      employeeShifts: { 12: { employee_id: 12, default_work_shift_id: null } },
    });
    const res = await buildUsecase(repo).currentForEmployee(12);
    assert.equal(res.code, 200);
    assert.equal(res.data.assigned, false);
    assert.equal(res.data.work_shift_id, null);
    assert.equal(res.data.shift_name, null);
    assert.equal(res.data.timing, null);
  });

  it("says so when the hours differ by weekday rather than picking one", async () => {
    const repo = makeRepo({
      employeeShifts: { 11: ASSIGNED },
      workingTimes: {
        4: [
          { in_time: "09:00:00", out_time: "21:00:00" },
          { in_time: "10:00:00", out_time: "18:00:00" },
        ],
      },
    });
    const res = await buildUsecase(repo).currentForEmployee(11);
    assert.equal(res.data.timing, "Varies by day");
    assert.equal(res.data.timings.length, 2);
  });

  it("shows a deactivated shift as it is, rather than as unassigned", async () => {
    const repo = makeRepo({
      employeeShifts: { 11: { ...ASSIGNED, work_shift_active: 0 } },
      workingTimes: { 4: [] },
    });
    const res = await buildUsecase(repo).currentForEmployee(11);
    assert.equal(res.data.assigned, true);
    assert.equal(res.data.shift_active, false);
    assert.equal(res.data.timing, null, "a shift with no working days has no timing to state");
  });

  it("answers 404 for an employee that does not exist", async () => {
    const repo = makeRepo();
    assert.equal((await buildUsecase(repo).currentForEmployee(99)).code, 404);
  });

  it("refuses an id that is not an employee id", async () => {
    const repo = makeRepo();
    for (const bad of ["", "abc", 0, -3]) {
      await assert.rejects(
        () => buildUsecase(repo).currentForEmployee(bad),
        (err) => err.name === "ValidationError"
      );
    }
    assert.equal(repo.calls.current.length, 0, "nothing is read until the id is an id");
  });

  it("NEVER READS THE LEGACY SHIFT COLUMNS", () => {
    const fs = require("fs");
    const path = require("path");
    // Comments are stripped first: the rule is about what the code touches,
    // and the file explains the legacy columns by name precisely so that
    // nobody reaches for them later.
    const code = fs
      .readFileSync(path.join(__dirname, "employee_work_shift.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // `\b` does not match inside `work_shift_id` or `default_work_shift_id`.
    assert.ok(!/\bshift_id\b/.test(code), "the legacy shift_id must not appear");
    assert.ok(!/shift_master/.test(code), "the legacy shift master must not appear");
  });
});

/* ========================================== correcting a historical date == */

/**
 * The AUTHORIZED CORRECTION path (Attendance v2 review, the shift-assignment
 * point). The ordinary assign route dates every change today and has no field
 * for any other date; a genuine historical mistake needs a separate, audited
 * way to be fixed, and the append-only resolver has always implied one.
 *
 * What is proven here is mostly refusal again, and for the same reason: the
 * dangerous outcome is a silent backdate, so every path to one has to be shut.
 */
describe("correctAssignment", () => {
  const valid = {
    employee_id: 11,
    work_shift_id: 4,
    effective_from: "2026-09-01",
    note: "Recorded on the wrong shift for the first fortnight of September",
    actor_employee_id: 3,
    today: "2026-10-05",
  };

  it("appends one CORRECTION row with the explicit date, the note and the actor", async () => {
    const repo = makeRepo();
    const result = await buildUsecase(repo).correctAssignment(valid);

    assert.equal(result.code, 200);
    assert.equal(result.source, "CORRECTION");
    assert.deepEqual(repo.calls.corrected, [
      {
        employeeId: 11,
        workShiftId: 4,
        effectiveFrom: "2026-09-01",
        note: valid.note,
        createdBy: 3,
      },
    ]);
    // It is a correction to history and nothing else: today's roster is not
    // touched, so the ordinary assignment write is never reached.
    assert.equal(repo.calls.assign.length, 0);
  });

  it("says out loud that attendance is not recalculated for you", async () => {
    const result = await buildUsecase(makeRepo()).correctAssignment(valid);
    assert.equal(result.recalculation_required, true);
    assert.match(result.msg, /NOT recalculated automatically/);
  });

  it("refuses a correction that does not say which date it corrects", async () => {
    const usecase = buildUsecase(makeRepo());
    await assert.rejects(
      usecase.correctAssignment({ ...valid, effective_from: undefined }),
      /effective_from is required/
    );
    await assert.rejects(
      usecase.correctAssignment({ ...valid, effective_from: "01-09-2026" }),
      /YYYY-MM-DD/
    );
  });

  it("refuses a correction that does not say why", async () => {
    const usecase = buildUsecase(makeRepo());
    await assert.rejects(usecase.correctAssignment({ ...valid, note: "typo" }), /at least 10/);
    await assert.rejects(usecase.correctAssignment({ ...valid, note: undefined }), /at least 10/);
  });

  it("refuses a FUTURE effective date - this path corrects the past", async () => {
    const usecase = buildUsecase(makeRepo());
    await assert.rejects(
      usecase.correctAssignment({ ...valid, effective_from: "2026-10-06" }),
      /cannot be in the future/
    );
  });

  it("takes one employee, never a list", async () => {
    const usecase = buildUsecase(makeRepo());
    await assert.rejects(
      usecase.correctAssignment({ ...valid, employee_id: undefined }),
      /employee_id is required/
    );
  });

  it("refuses an employee or a work shift that does not exist", async () => {
    const unknownEmployee = await buildUsecase(makeRepo()).correctAssignment({
      ...valid,
      employee_id: 99,
    });
    assert.equal(unknownEmployee.code, 422);

    const unknownShift = await buildUsecase(makeRepo({ shift: null })).correctAssignment(valid);
    assert.equal(unknownShift.code, 404);
  });

  it("ACCEPTS an inactive shift, which an ordinary assignment refuses", async () => {
    // A correction records what was true then, and a shift that has since been
    // retired is exactly the sort of thing a correction is for.
    const repo = makeRepo({ shift: INACTIVE_SHIFT });
    const result = await buildUsecase(repo).correctAssignment({ ...valid, work_shift_id: 9 });
    assert.equal(result.code, 200);
    assert.equal(result.shift_code, "OLD");

    const assigned = await buildUsecase(makeRepo({ shift: INACTIVE_SHIFT })).assign({
      employee_ids: [11],
      work_shift_id: 9,
    });
    assert.equal(assigned.code, 422, "the ordinary route still refuses one");
  });

  it("the ordinary assign route still has no way to backdate anything", async () => {
    const repo = makeRepo();
    await buildUsecase(repo).assign({
      employee_ids: [11],
      work_shift_id: 4,
      // A caller inventing this field changes nothing: `assign` reads its
      // effective date from the server's own clock and from nowhere else.
      effective_from: "2020-01-01",
      today: "2026-10-05",
    });
    assert.equal(repo.calls.assign[0].options.effective_from, "2026-10-05");
  });
});
