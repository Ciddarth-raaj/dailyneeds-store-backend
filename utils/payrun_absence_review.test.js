/**
 * The 3-Day Absent rule, as pure arithmetic over stored engine days.
 *
 *   node --test utils/payrun_absence_review.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { absenceReview, applicable, workingFlag } = require("./payrun_absence_review");

const day = (date, over = {}) => ({
  attendance_date: date,
  status: "ABSENT",
  punch_count: 0,
  attendance_day_count: 0,
  attendance_calculation_mode: "SHIFT_BASED",
  is_working_day: "true",
  ...over,
});

test("three applicable absences at the end of the month flag the employee", () => {
  const r = absenceReview([day("2026-08-29"), day("2026-08-31"), day("2026-08-30")]);
  assert.equal(r.three_day_absent, true);
  assert.deepEqual(r.absent_dates, ["2026-08-29", "2026-08-30", "2026-08-31"]);
  assert.equal(r.last_present_date, null);
});

test("the last three CALENDAR dates are not the rule - rest days are skipped", () => {
  const r = absenceReview([
    day("2026-08-27", { status: "FINAL", attendance_day_count: 1, punch_count: 2 }),
    day("2026-08-28"),
    day("2026-08-29", { is_working_day: "false" }),
    day("2026-08-30", { is_working_day: "false" }),
    day("2026-08-31"),
  ]);
  assert.equal(r.three_day_absent, false);
  assert.deepEqual(r.absent_dates, ["2026-08-28", "2026-08-31"]);
  assert.equal(r.last_present_date, "2026-08-27");
});

test("dates nobody was expected to attend are not applicable", () => {
  ["ATTENDANCE_NOT_REQUIRED", "NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW", "NOT_JOINED"].forEach((status) =>
    assert.equal(applicable(day("2026-08-31", { status })), false, status)
  );
  assert.equal(applicable(day("2026-08-31", { is_working_day: null })), false, "no shift snapshot");
  assert.equal(applicable(day("2026-08-31", { is_working_day: "false" })), false, "rest day");
  assert.equal(
    applicable(day("2026-08-31", { is_working_day: null, attendance_calculation_mode: "PRESENT_ABSENT_ONLY" })),
    true
  );
});

test("an unsettled date breaks the run rather than counting as absent", () => {
  const r = absenceReview([
    day("2026-08-28"),
    day("2026-08-29"),
    day("2026-08-30", { status: "REGULARIZATION_PENDING" }),
    day("2026-08-31"),
  ]);
  assert.equal(r.three_day_absent, false);
});

test("no stored days is no flag", () => {
  assert.deepEqual(absenceReview([]), { three_day_absent: false, absent_dates: [], last_present_date: null });
});

test("the JSON flag is read in every shape MySQL can hand it back", () => {
  [true, 1, "1", "true"].forEach((v) => assert.equal(workingFlag(v), true));
  [false, 0, "0", "false"].forEach((v) => assert.equal(workingFlag(v), false));
  [null, undefined, "", "null"].forEach((v) => assert.equal(workingFlag(v), null));
});
