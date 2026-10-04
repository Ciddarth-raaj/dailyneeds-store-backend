/**
 * The 3-Day Absent rule, as pure arithmetic over stored engine days.
 *
 *   node --test utils/payrun_absence_review.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { absenceReview, workingFlag, EVALUATION, NOT_EVALUABLE_REASON: R } = require("./payrun_absence_review");

const SEP = { from: "2026-09-01", to: "2026-09-30", latest_completed: "2026-10-03" };
const day = (date, over = {}) => ({
  attendance_date: date,
  status: "ABSENT",
  is_final: 1,
  punch_count: 0,
  attendance_day_count: 0,
  attendance_calculation_mode: "SHIFT_BASED",
  is_working_day: "true",
  ...over,
});
const worked = (date) => day(date, { status: "FINAL", punch_count: 2, attendance_day_count: 1 });

test("Sep 28-30 all calculated Absent -> classified", () => {
  const r = absenceReview([worked("2026-09-27"), day("2026-09-28"), day("2026-09-29"), day("2026-09-30")], SEP);
  assert.equal(r.evaluation, EVALUATION.THREE_DAY_ABSENT);
  assert.deepEqual(r.absent_dates, ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.equal(r.last_present_date, "2026-09-27");
});

test("Sep 30 uncalculated, Sep 27-29 Absent -> NOT classified (no stepping past a missing calculation)", () => {
  const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29")], SEP);
  assert.equal(r.three_day_absent, false);
  assert.equal(r.evaluation, EVALUATION.NOT_EVALUABLE);
  assert.equal(r.not_evaluable_reason, R.NOT_CALCULATED);
  assert.equal(r.not_evaluable_date, "2026-09-30");
  assert.deepEqual(r.absent_dates, []);
});

test("Sep 29 weekly off; Sep 27/28/30 Absent -> classified", () => {
  const r = absenceReview(
    [worked("2026-09-26"), day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { is_working_day: "false" }), day("2026-09-30")],
    SEP
  );
  assert.equal(r.three_day_absent, true);
  assert.deepEqual(r.absent_dates, ["2026-09-27", "2026-09-28", "2026-09-30"]);
});

test("a Present day breaks the sequence", () => {
  const r = absenceReview([day("2026-09-27"), day("2026-09-28"), worked("2026-09-29"), day("2026-09-30")], SEP);
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
});

test("pending / unresolved / not final is never Absent", () => {
  for (const over of [
    { status: "REGULARIZATION_PENDING", is_final: 0 },
    { status: "REVIEW_REQUIRED", is_final: 0 },
    { status: "OT_PENDING", is_final: 0 },
    { status: "ABSENT", is_final: 0 },
  ]) {
    const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29", over), day("2026-09-30")], SEP);
    assert.equal(r.three_day_absent, false, JSON.stringify(over));
    assert.equal(r.not_evaluable_reason, R.UNRESOLVED);
  }
});

test("Present/Absent Only: no working-day source, so not evaluable - never every-date-is-a-workday", () => {
  const pa = { attendance_calculation_mode: "PRESENT_ABSENT_ONLY", is_working_day: null };
  const r = absenceReview([day("2026-09-28", pa), day("2026-09-29", pa), day("2026-09-30", pa)], SEP);
  assert.equal(r.three_day_absent, false);
  assert.equal(r.not_evaluable_reason, R.NO_WORKING_DAY_SOURCE);
});

test("only genuinely non-applicable dates are skipped", () => {
  // Not required: skipped.
  const exempt = absenceReview(
    [day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { status: "ATTENDANCE_NOT_REQUIRED" }), day("2026-09-30")],
    SEP
  );
  assert.equal(exempt.three_day_absent, true);
  // No shift: a setup fault, stops the walk.
  for (const status of ["NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW"]) {
    const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { status, is_working_day: null }), day("2026-09-30")], SEP);
    assert.equal(r.not_evaluable_reason, R.NO_SHIFT, status);
  }
  // An unreadable working-day flag: stops the walk.
  const unknown = absenceReview([day("2026-09-28"), day("2026-09-29", { is_working_day: null }), day("2026-09-30")], SEP);
  assert.equal(unknown.not_evaluable_reason, R.WORKING_DAY_UNKNOWN);
});

test("dates not yet completed are not evaluable", () => {
  const r = absenceReview([day("2026-09-28"), day("2026-09-29"), day("2026-09-30")], { ...SEP, latest_completed: "2026-09-29" });
  assert.equal(r.not_evaluable_reason, R.DATE_NOT_COMPLETED);
});

test("fewer than three applicable days since joining is not absent", () => {
  const r = absenceReview([day("2026-09-29"), day("2026-09-30")], { ...SEP, joined_on: "2026-09-29" });
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
});

test("the JSON flag is read in every shape MySQL can hand it back", () => {
  [true, 1, "1", "true"].forEach((v) => assert.equal(workingFlag(v), true));
  [false, 0, "0", "false"].forEach((v) => assert.equal(workingFlag(v), false));
  [null, undefined, "", "null"].forEach((v) => assert.equal(workingFlag(v), null));
});
