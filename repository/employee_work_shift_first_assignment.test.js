/**
 * A FIRST-EVER shift assignment is dated from the start, not from today.
 *
 *   node --test repository/employee_work_shift_first_assignment.test.js
 *
 * WHY. Dating every assignment TODAY is right when the employee already has
 * a shift - moving somebody to a new one must not rewrite yesterday's worked
 * minutes. It is wrong for their FIRST one: there is no earlier assignment to
 * protect, and every date before today then resolves to NO_SHIFT for ever.
 * That is the defect behind "the shift is assigned but Punch Audit still says
 * No Shift" - the shift was assigned on the 12th and the punches were from
 * the 2nd to the 10th.
 *
 * The two halves are asserted together, because the value is in the
 * distinction: a first assignment is backdated to GREATEST(cutover, joining
 * date); a subsequent one is not backdated at all.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EmployeeWorkShiftRepository } = require("./employee_work_shift");

/**
 * A fake pool that answers the four statements `assignWorkShift` issues and
 * records the assignment rows it would insert.
 */
function fakeDb({ existingHistory = [], joining = {} }) {
  const inserted = [];
  const connection = {
    query(sql, params, cb) {
      const done = (rows) => cb(null, rows);
      if (/FROM work_shift WHERE work_shift_id/.test(sql)) {
        return done([{ work_shift_id: params[0], active: 1 }]);
      }
      if (/UPDATE new_employee SET default_work_shift_id/.test(sql)) {
        return done({ affectedRows: params[1].length, changedRows: params[1].length });
      }
      if (/MIN\(effective_from\) AS earliest/.test(sql)) {
        return done(existingHistory.map((id) => ({ employee_id: id, earliest: "2026-09-12" })));
      }
      if (/AS joined_on/.test(sql)) {
        return done(params[0].map((id) => ({ employee_id: id, joined_on: joining[id] ?? null })));
      }
      if (/INSERT INTO employee_work_shift_assignment/.test(sql)) {
        params[0].forEach(([employee_id, work_shift_id, effective_from, source]) =>
          inserted.push({ employee_id, work_shift_id, effective_from, source })
        );
        return done({ insertId: 1 });
      }
      return done([]);
    },
    beginTransaction: (cb) => cb(null),
    commit: (cb) => cb(null),
    rollback: (cb) => cb(),
    release: () => {},
  };
  return {
    inserted,
    db: { getConnection: (cb) => cb(null, connection), query: connection.query },
  };
}

const assign = async (opts, employeeIds = [1865]) => {
  const f = fakeDb(opts);
  const repo = new EmployeeWorkShiftRepository(f.db);
  const res = await repo.assignWorkShift(employeeIds, 7, {
    effective_from: "2026-09-12",
    created_by: 9,
  });
  assert.equal(res.code, 200);
  return f.inserted;
};

describe("an employee with NO assignment history", () => {
  it("is dated from their joining date, not from today", async () => {
    const rows = await assign({ existingHistory: [], joining: { 1865: "2026-09-05" } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effective_from, "2026-09-05");
  });

  it("is dated from the v2 cutover when they joined before it", async () => {
    const rows = await assign({ existingHistory: [], joining: { 1865: "2019-04-01" } });
    assert.equal(rows[0].effective_from, "2026-09-01");
  });

  it("is dated from the cutover when the joining date is unreadable or absent", async () => {
    for (const joined of [null, ""]) {
      const rows = await assign({ existingHistory: [], joining: { 1865: joined } });
      assert.equal(rows[0].effective_from, "2026-09-01", `joined ${JSON.stringify(joined)}`);
    }
  });

  it("never claims history before the cutover, whatever the joining date says", async () => {
    const rows = await assign({ existingHistory: [], joining: { 1865: "1990-01-01" } });
    assert.ok(rows[0].effective_from >= "2026-09-01");
  });
});

describe("an employee who ALREADY has assignment history", () => {
  it("keeps today's date - a shift CHANGE must not rewrite worked minutes", async () => {
    const rows = await assign({ existingHistory: [1865], joining: { 1865: "2019-04-01" } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effective_from, "2026-09-12", "the caller's date, unchanged");
  });
});

describe("a bulk assignment", () => {
  it("decides per employee, so one first-timer in a bulk does not backdate the rest", async () => {
    const rows = await assign(
      { existingHistory: [2], joining: { 1: "2026-09-04", 2: "2019-01-01", 3: "2019-01-01" } },
      [1, 2, 3]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.employee_id, r.effective_from]));
    assert.equal(byId[1], "2026-09-04", "first assignment, joined after the cutover");
    assert.equal(byId[2], "2026-09-12", "already had history - today");
    assert.equal(byId[3], "2026-09-01", "first assignment, joined before the cutover");
    assert.equal(rows.length, 3, "one row each, still");
    assert.deepEqual([...new Set(rows.map((r) => r.source))], ["BULK_ASSIGNMENT"]);
  });
});
