/**
 * The blast radius of a Work Shift rule change, as arithmetic.
 *
 * Every bound the business rule names is tested here rather than through a
 * repository, because every one of them is a decision about dates and none of
 * them needs a database to be wrong.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  assignedIntervals,
  propagationFloor,
  propagationForEmployee,
  propagationScope,
} = require("../utils/shift_propagation");

const SHIFT = 5;
const OTHER = 6;
const TODAY = "2026-09-21";

const employee = (overrides = {}) => ({
  attendance_required: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  ...overrides,
});

const assignment = (id, workShiftId, effectiveFrom) => ({
  employee_work_shift_assignment_id: id,
  work_shift_id: workShiftId,
  effective_from: effectiveFrom,
});

describe("which dates a shift governed", () => {
  it("an assignment runs until the next one, whatever shift that is", () => {
    assert.deepEqual(
      assignedIntervals(
        [assignment(1, SHIFT, "2026-09-01"), assignment(2, OTHER, "2026-09-14")],
        SHIFT
      ),
      [{ from: "2026-09-01", to: "2026-09-13" }]
    );
  });

  it("the last assignment is open-ended", () => {
    assert.deepEqual(assignedIntervals([assignment(1, SHIFT, "2026-09-01")], SHIFT), [
      { from: "2026-09-01", to: null },
    ]);
  });

  it("a shift can be returned to, and each spell is its own interval", () => {
    assert.deepEqual(
      assignedIntervals(
        [
          assignment(1, SHIFT, "2026-09-01"),
          assignment(2, OTHER, "2026-09-10"),
          assignment(3, SHIFT, "2026-09-20"),
        ],
        SHIFT
      ),
      [
        { from: "2026-09-01", to: "2026-09-09" },
        { from: "2026-09-20", to: null },
      ]
    );
  });

  it("two assignments on the same day: the later id governs and the earlier one governs nothing", () => {
    assert.deepEqual(
      assignedIntervals(
        [assignment(1, SHIFT, "2026-09-01"), assignment(2, OTHER, "2026-09-01")],
        SHIFT
      ),
      [],
      "the same tie-break the engine's resolver applies"
    );
  });
});

describe("the payroll floor", () => {
  it("is the day after the latest locked month", () => {
    assert.equal(propagationFloor(["2026-09", "2026-10"]), "2026-11-01");
  });

  it("is the v2 cutover when nothing is locked", () => {
    assert.equal(propagationFloor([]), "2026-09-01");
  });

  it("never goes below the cutover", () => {
    assert.equal(propagationFloor(["2025-01"]), "2026-09-01");
  });
});

describe("one employee's share of a rule change", () => {
  const scopeOf = (overrides = {}) =>
    propagationForEmployee({
      employee: employee(),
      assignments: [assignment(1, SHIFT, "2026-09-01")],
      workShiftId: SHIFT,
      today: TODAY,
      ...overrides,
    });

  it("covers the whole open window, from the assignment to today", () => {
    const { buckets } = scopeOf();
    assert.deepEqual(buckets, [
      {
        month: "2026-09",
        from_date: "2026-09-01",
        to_date: TODAY,
        period_year: 2026,
        period_month: 9,
        day_count: 21,
      },
    ]);
  });

  it("never reaches a future date", () => {
    const { buckets } = scopeOf({ today: "2026-09-10" });
    assert.equal(buckets[0].to_date, "2026-09-10");
  });

  it("stops where the assignment stops", () => {
    const { buckets } = scopeOf({
      assignments: [assignment(1, SHIFT, "2026-09-01"), assignment(2, OTHER, "2026-09-15")],
    });
    assert.equal(buckets[0].to_date, "2026-09-14");
  });

  it("is clamped to employment - a joiner is not calculated before they joined", () => {
    const { buckets } = scopeOf({ employee: employee({ date_of_joining: "2026-09-08" }) });
    assert.equal(buckets[0].from_date, "2026-09-08");
  });

  it("is clamped to employment - a leaver is not calculated after they left", () => {
    const { buckets } = scopeOf({ employee: employee({ resignation_date: "2026-09-12" }) });
    assert.equal(buckets[0].to_date, "2026-09-12");
  });

  it("an employee exempt from attendance contributes nothing", () => {
    const { buckets } = scopeOf({ employee: employee({ attendance_required: 0 }) });
    assert.deepEqual(buckets, []);
  });

  it("a locked month is excluded AND reported, with the days it holds", () => {
    const { buckets, skipped_locked_months } = scopeOf({ lockedMonths: ["2026-09"] });
    assert.deepEqual(buckets, []);
    assert.deepEqual(skipped_locked_months, [
      { month: "2026-09", from_date: "2026-09-01", to_date: TODAY, day_count: 21 },
    ]);
  });

  it("everything at or below the latest locked month is settled, so work starts after it", () => {
    const { buckets } = propagationForEmployee({
      employee: employee(),
      assignments: [assignment(1, SHIFT, "2026-09-01")],
      lockedMonths: ["2026-09"],
      workShiftId: SHIFT,
      today: "2026-10-15",
    });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].month, "2026-10");
    assert.equal(buckets[0].from_date, "2026-10-01");
  });

  it("splits a multi-month window into one bucket per month", () => {
    const { buckets } = scopeOf({ today: "2026-11-05" });
    assert.deepEqual(
      buckets.map((b) => [b.month, b.from_date, b.to_date]),
      [
        ["2026-09", "2026-09-01", "2026-09-30"],
        ["2026-10", "2026-10-01", "2026-10-31"],
        ["2026-11", "2026-11-01", "2026-11-05"],
      ]
    );
  });

  it("a single-date override ONTO the shift is in scope even with no assignment to it", () => {
    const { buckets } = scopeOf({
      assignments: [assignment(1, OTHER, "2026-09-01")],
      overrideDates: ["2026-09-15"],
    });
    assert.deepEqual(
      buckets.map((b) => [b.from_date, b.to_date]),
      [["2026-09-15", "2026-09-15"]]
    );
  });

  it("an override inside its own assignment window does not recalculate the month twice", () => {
    const { buckets } = scopeOf({ overrideDates: ["2026-09-15"] });
    assert.equal(buckets.length, 1);
  });
});

describe("the whole population", () => {
  it("is one entry per employee-month, and says whose month was skipped", () => {
    const { work, skipped_locked } = propagationScope({
      workShiftId: SHIFT,
      today: TODAY,
      employees: [
        {
          employee_id: 1,
          employee: employee(),
          assignments: [assignment(1, SHIFT, "2026-09-01")],
        },
        {
          employee_id: 2,
          employee: employee(),
          assignments: [assignment(2, SHIFT, "2026-09-01")],
          locked_months: ["2026-09"],
        },
        {
          employee_id: 3,
          employee: employee(),
          assignments: [assignment(3, OTHER, "2026-09-01")],
        },
      ],
    });

    assert.deepEqual(
      work.map((w) => [w.employee_id, w.month]),
      [[1, "2026-09"]],
      "employee 2's only month is locked; employee 3 is not on this shift"
    );
    assert.deepEqual(
      skipped_locked.map((s) => [s.employee_id, s.month]),
      [[2, "2026-09"]]
    );
  });
});
