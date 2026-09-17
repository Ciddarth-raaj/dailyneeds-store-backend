/**
 * THE DASHBOARD'S CONTRACT - what `list()` hands the screen.
 *
 *   node --test usecase/attendance_approver_dashboard.test.js
 *
 * The summary rides on the list response rather than a second endpoint,
 * because the cards and the table must describe the same filters at the same
 * moment and two requests can disagree. These pin that it is the DATABASE's
 * answer that travels - never a count taken over the page of rows the
 * response happens to carry, which would be wrong for any filtered
 * population larger than one page.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_approver_setup");

/** A repository stand-in that records the filters each query was given. */
function fakeRepo({ rows = [], summary = null, total = null } = {}) {
  const calls = { listed: [], counted: [], summarised: [] };
  return {
    calls,
    listEmployeesWithSetup: async (f) => { calls.listed.push(f); return rows; },
    countEmployeesWithSetup: async (f) => { calls.counted.push(f); return total === null ? rows.length : total; },
    summariseEmployeesWithSetup: async (f) => {
      calls.summarised.push(f);
      return summary || { attendance_required: 200, completed: 185, missing: 15 };
    },
  };
}

const EMPLOYEE = {
  employee_id: 101,
  employee_name: "Asha R",
  status: 1,
  store_id: 3,
  designation_id: 5,
  department_id: 2,
};

describe("list() returns the dashboard summary", () => {
  it("carries the three counts from the database, not from the returned rows", async () => {
    // One row returned, two hundred in the population: the summary must be
    // the database's, or a paged screen reports nonsense.
    const repo = fakeRepo({ rows: [EMPLOYEE], total: 200 });
    const res = await buildUsecase(repo).list({});

    assert.deepEqual(res.summary, { attendance_required: 200, completed: 185, missing: 15 });
    assert.equal(res.rows.length, 1);
    assert.notEqual(res.summary.attendance_required, res.rows.length);
  });

  it("holds completed + missing = attendance_required", async () => {
    const repo = fakeRepo({ summary: { attendance_required: 200, completed: 185, missing: 15 } });
    const { summary } = await buildUsecase(repo).list({});
    assert.equal(summary.completed + summary.missing, summary.attendance_required);
  });

  it("asks for the summary once per list, in the same request", async () => {
    const repo = fakeRepo();
    await buildUsecase(repo).list({});
    assert.equal(repo.calls.summarised.length, 1);
    assert.equal(repo.calls.listed.length, 1);
  });

  it("passes the base filters to the summary as well as to the rows", async () => {
    const repo = fakeRepo();
    await buildUsecase(repo).list({ department_id: "2", store_id: "3", designation_id: "5", employee_id: "7", search: "raj" });

    for (const call of [repo.calls.listed[0], repo.calls.summarised[0]]) {
      assert.equal(call.department_id, 2);
      assert.equal(call.store_id, 3);
      assert.equal(call.designation_id, 5);
      assert.equal(call.employee_id, 7);
      assert.equal(call.search, "raj");
    }
  });
});

describe("the setup_status filter", () => {
  it("passes a known status through to the rows", async () => {
    const repo = fakeRepo();
    const res = await buildUsecase(repo).list({ setup_status: "missing" });
    assert.equal(repo.calls.listed[0].setup_status, "missing");
    assert.equal(res.setup_status, "missing");
  });

  it("accepts completed as well", async () => {
    const repo = fakeRepo();
    await buildUsecase(repo).list({ setup_status: "completed" });
    assert.equal(repo.calls.listed[0].setup_status, "completed");
  });

  it("treats an unknown status as no filter rather than an error", async () => {
    // A view preference on a read: refusing the whole list because a query
    // string was odd would be worse than showing everybody.
    const repo = fakeRepo();
    const res = await buildUsecase(repo).list({ setup_status: "nonsense" });
    assert.equal(repo.calls.listed[0].setup_status, null);
    assert.equal(res.setup_status, null);
  });

  it("still reports the full split while a card is selected", async () => {
    const repo = fakeRepo({ summary: { attendance_required: 200, completed: 185, missing: 15 } });
    const res = await buildUsecase(repo).list({ setup_status: "missing" });

    // The rows are narrowed; the cards keep their comparison.
    assert.equal(repo.calls.listed[0].setup_status, "missing");
    assert.deepEqual(res.summary, { attendance_required: 200, completed: 185, missing: 15 });
  });
});

describe("the row's own completion flag", () => {
  const rowFor = async (extra) => {
    const res = await buildUsecase(fakeRepo({ rows: [{ ...EMPLOYEE, ...extra }] })).list({});
    return res.rows[0];
  };

  it("is true for every valid shape of a completed chain", async () => {
    // Final alone, and Final with either or both optional levels.
    const shapes = [
      { first_level_approver_employee_id: null, second_level_approver_employee_id: null },
      { first_level_approver_employee_id: 11, second_level_approver_employee_id: null },
      { first_level_approver_employee_id: null, second_level_approver_employee_id: 22 },
      { first_level_approver_employee_id: 11, second_level_approver_employee_id: 22 },
    ];
    for (const shape of shapes) {
      const row = await rowFor({ ...shape, attendance_approver_setup_id: 9, final_approver_employee_id: 33 });
      assert.equal(row.setup_completed, true, JSON.stringify(shape));
    }
  });

  it("is false with no mapping at all", async () => {
    const row = await rowFor({ attendance_approver_setup_id: null, final_approver_employee_id: null });
    assert.equal(row.setup_completed, false);
    assert.equal(row.has_setup, false);
  });

  it("is false for a legacy mapping with no final approver", async () => {
    // has_setup is true - a row exists - but it is not a usable chain, so the
    // dashboard counts it as missing.
    const row = await rowFor({ attendance_approver_setup_id: 9, final_approver_employee_id: null });
    assert.equal(row.has_setup, true);
    assert.equal(row.setup_completed, false);
  });
});
