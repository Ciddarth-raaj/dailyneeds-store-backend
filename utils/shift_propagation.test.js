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
  propagationForEmployee,
  propagationScope,
} = require("../utils/shift_propagation");

const SHIFT = 5;
const OTHER = 6;
const TODAY = "2026-09-21";
// The latest date whose attendance day CAN have closed on TODAY. Whether it
// actually has depends on the cutoff, which `recalculateRange` decides.
const YESTERDAY = "2026-09-20";

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

describe("the payroll lock is a fact about ONE month", () => {
  const scopeAcross = (lockedMonths) =>
    propagationForEmployee({
      employee: employee(),
      assignments: [assignment(1, SHIFT, "2026-07-01")],
      lockedMonths,
      workShiftId: SHIFT,
      today: "2026-09-21",
      // The v2 cutover is the only absolute floor; these tests reach back
      // past it on purpose, to prove the lock is what decides and not a
      // high-water mark.
      cutover: "2026-07-01",
    });

  it("July open, August LOCKED, September open: July and September are recalculated, August is not", () => {
    const { buckets, skipped_locked_months } = scopeAcross(["2026-08"]);
    assert.deepEqual(
      buckets.map((b) => b.month),
      ["2026-07", "2026-09"],
      "August being settled says NOTHING about July"
    );
    assert.deepEqual(
      skipped_locked_months.map((s) => s.month),
      ["2026-08"]
    );
    assert.equal(skipped_locked_months[0].day_count, 31, "and the whole of it is counted as skipped");
  });

  it("two locked months are each skipped, and the months between them are not", () => {
    const { buckets } = scopeAcross(["2026-07", "2026-09"]);
    assert.deepEqual(buckets.map((b) => b.month), ["2026-08"]);
  });

  it("nothing locked means every month is open", () => {
    const { buckets, skipped_locked_months } = scopeAcross([]);
    assert.deepEqual(buckets.map((b) => b.month), ["2026-07", "2026-08", "2026-09"]);
    assert.deepEqual(skipped_locked_months, []);
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

  it("covers the whole open window, from the assignment to the day BEFORE today - today's attendance day is never closed", () => {
    const { buckets } = scopeOf();
    assert.deepEqual(buckets, [
      {
        month: "2026-09",
        from_date: "2026-09-01",
        to_date: YESTERDAY,
        period_year: 2026,
        period_month: 9,
        day_count: 20,
      },
    ]);
  });

  it("never reaches today or a future date", () => {
    const { buckets } = scopeOf({ today: "2026-09-10" });
    assert.equal(buckets[0].to_date, "2026-09-09");
  });

  it("an assignment that starts TODAY has nothing closed to recalculate yet", () => {
    const { buckets } = scopeOf({ assignments: [assignment(1, SHIFT, TODAY)] });
    assert.deepEqual(buckets, []);
  });

  it("a single-date override onto the shift for TODAY is not in scope until the day has closed", () => {
    const { buckets } = scopeOf({
      assignments: [assignment(1, OTHER, "2026-09-01")],
      overrideDates: [TODAY],
    });
    assert.deepEqual(buckets, []);
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
      { month: "2026-09", from_date: "2026-09-01", to_date: YESTERDAY, day_count: 20, locked_at: null },
    ]);
  });

  it("a locked month is skipped without taking the months after it with it", () => {
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
        ["2026-11", "2026-11-01", "2026-11-04"],
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

describe("an employee discovered ONLY through a single-date override", () => {
  // They have no assignment row for this shift at all - the override is the
  // whole of their connection to it - so their employment facts have to be
  // fetched independently of the assignment history. Absent facts read as
  // unbounded and attendance-required, which would recalculate a date the
  // person did not work here.
  const overrideOnly = (employeeOverrides) =>
    propagationForEmployee({
      employee: employee(employeeOverrides),
      assignments: [],
      overrideDates: ["2026-09-15"],
      workShiftId: SHIFT,
      today: TODAY,
    });

  it("an employed date is in scope", () => {
    assert.deepEqual(
      overrideOnly({}).buckets.map((b) => [b.from_date, b.to_date]),
      [["2026-09-15", "2026-09-15"]]
    );
  });

  it("a date BEFORE they joined is not", () => {
    assert.deepEqual(overrideOnly({ date_of_joining: "2026-09-16" }).buckets, []);
  });

  it("a date AFTER they resigned is not", () => {
    assert.deepEqual(overrideOnly({ resignation_date: "2026-09-14" }).buckets, []);
  });

  it("somebody exempt from attendance is not", () => {
    assert.deepEqual(overrideOnly({ attendance_required: 0 }).buckets, []);
  });

  it("a locked month freezes the overridden date like any other", () => {
    const { buckets, skipped_locked_months } = propagationForEmployee({
      employee: employee(),
      assignments: [],
      overrideDates: ["2026-09-15"],
      lockedMonths: ["2026-09"],
      workShiftId: SHIFT,
      today: TODAY,
    });
    assert.deepEqual(buckets, []);
    assert.deepEqual(skipped_locked_months.map((m) => m.month), ["2026-09"]);
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
