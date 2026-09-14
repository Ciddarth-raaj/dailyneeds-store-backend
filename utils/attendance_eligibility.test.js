/**
 * THE ONE ATTENDANCE ELIGIBILITY RULE.
 *
 *   node --test utils/attendance_eligibility.test.js
 *
 * Pure arithmetic over three facts, so it is tested as arithmetic. The three
 * exclusions each get their boundary examined on both sides, because the whole
 * value of a shared rule is that "the day they resigned" means the same thing
 * in the recalculation, in the bulk run and on the dashboard.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  attendanceRequired,
  employedOn,
  eligibleOn,
  eligibleInRange,
  eligibleWindow,
  exclusionReason,
} = require("./attendance_eligibility");

const employee = (over = {}) => ({
  employee_id: 42,
  attendance_required: 1,
  date_of_joining: "2026-09-10",
  resignation_date: null,
  ...over,
});

describe("exclusion 1: attendance_required = 0", () => {
  it("excludes the employee on every date", () => {
    const exempt = employee({ attendance_required: 0 });
    assert.equal(eligibleOn(exempt, "2026-09-15"), false);
    assert.equal(eligibleWindow(exempt, "2026-09-01", "2026-09-30"), null);
    assert.equal(eligibleInRange(exempt, "2026-09-01", "2026-09-30"), false);
    assert.equal(exclusionReason(exempt, "2026-09-15"), "ATTENDANCE_NOT_REQUIRED");
  });

  it("ABSENT OR NULL IS TRUE - 'not asked' must never exempt anybody", () => {
    assert.equal(attendanceRequired({}), true);
    assert.equal(attendanceRequired({ attendance_required: null }), true);
    assert.equal(attendanceRequired({ attendance_required: undefined }), true);
    assert.equal(attendanceRequired(null), true);
    // And only an explicit 0 exempts.
    assert.equal(attendanceRequired({ attendance_required: 0 }), false);
    assert.equal(attendanceRequired({ attendance_required: 1 }), true);
    assert.equal(attendanceRequired({ attendance_required: true }), true);
  });
});

describe("exclusion 2: after the resignation date", () => {
  const left = employee({ resignation_date: "2026-09-20" });

  it("the resignation date itself is WORKED - it is their last working day", () => {
    assert.equal(eligibleOn(left, "2026-09-20"), true);
    assert.equal(eligibleOn(left, "2026-09-19"), true);
  });

  it("the day after is excluded, and so is every day after that", () => {
    assert.equal(eligibleOn(left, "2026-09-21"), false);
    assert.equal(eligibleOn(left, "2027-01-01"), false);
    assert.equal(exclusionReason(left, "2026-09-21"), "AFTER_RESIGNATION_DATE");
  });

  it("clamps the window at the resignation date, keeping the history before it", () => {
    assert.deepEqual(eligibleWindow(left, "2026-09-15", "2026-09-30"), {
      from: "2026-09-15",
      to: "2026-09-20",
    });
  });

  it("an employee still employed is never clamped at the end", () => {
    assert.deepEqual(eligibleWindow(employee(), "2026-09-15", "2026-09-30"), {
      from: "2026-09-15",
      to: "2026-09-30",
    });
  });
});

describe("exclusion 3: before the joining date", () => {
  it("the joining date itself is worked; the day before is not", () => {
    assert.equal(eligibleOn(employee(), "2026-09-10"), true);
    assert.equal(eligibleOn(employee(), "2026-09-09"), false);
    assert.equal(exclusionReason(employee(), "2026-09-09"), "BEFORE_JOINING_DATE");
  });

  it("clamps the window's start to the joining date", () => {
    assert.deepEqual(eligibleWindow(employee(), "2026-09-01", "2026-09-30"), {
      from: "2026-09-10",
      to: "2026-09-30",
    });
  });
});

describe("an absent or unreadable bound is UNBOUNDED, not excluded", () => {
  it("no joining date: every date of the range qualifies", () => {
    const unknown = employee({ date_of_joining: null });
    assert.deepEqual(eligibleWindow(unknown, "2026-09-01", "2026-09-30"), {
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("an unreadable joining date clamps nothing - 425 production rows depend on it", () => {
    const messy = employee({ date_of_joining: "not a date" });
    assert.equal(eligibleOn(messy, "1999-01-01"), true);
  });

  it("reads the dashboard's `joined_on` as readily as the master's column", () => {
    const fromDashboard = { attendance_required: 1, joined_on: "2026-09-10", resignation_date: null };
    assert.equal(eligibleOn(fromDashboard, "2026-09-09"), false);
    assert.equal(eligibleOn(fromDashboard, "2026-09-10"), true);
  });
});

describe("the window as a whole", () => {
  it("is null when employment does not overlap the range at all", () => {
    assert.equal(eligibleWindow(employee({ date_of_joining: "2026-10-01" }), "2026-09-01", "2026-09-30"), null);
    assert.equal(eligibleWindow(employee({ resignation_date: "2026-08-01" }), "2026-09-01", "2026-09-30"), null);
  });

  it("agrees with eligibleInRange in every case", () => {
    const cases = [
      employee(),
      employee({ attendance_required: 0 }),
      employee({ date_of_joining: "2026-10-01" }),
      employee({ resignation_date: "2026-08-01" }),
      employee({ resignation_date: "2026-09-15" }),
      employee({ date_of_joining: null, resignation_date: null }),
    ];
    for (const e of cases) {
      const window = eligibleWindow(e, "2026-09-01", "2026-09-30");
      assert.equal(eligibleInRange(e, "2026-09-01", "2026-09-30"), window !== null);
    }
  });

  it("refuses a backwards or unreadable range rather than inventing one", () => {
    assert.equal(eligibleWindow(employee(), "2026-09-30", "2026-09-01"), null);
    assert.equal(eligibleWindow(employee(), "nonsense", "2026-09-01"), null);
  });

  it("employedOn ignores the exemption - it is the employment half alone", () => {
    const exempt = employee({ attendance_required: 0 });
    assert.equal(employedOn(exempt, "2026-09-15"), true);
    assert.equal(eligibleOn(exempt, "2026-09-15"), false);
  });
});

describe("`status` takes no part", () => {
  it("a leaver whose status was never changed by hand is still excluded after their date", () => {
    const stale = employee({ status: 1, resignation_date: "2025-11-30" });
    assert.equal(eligibleOn(stale, "2026-09-15"), false);
  });

  it("an active employee whose status flag says 0 is NOT excluded", () => {
    const mislabelled = employee({ status: 0, resignation_date: null });
    assert.equal(eligibleOn(mislabelled, "2026-09-15"), true);
  });
});
