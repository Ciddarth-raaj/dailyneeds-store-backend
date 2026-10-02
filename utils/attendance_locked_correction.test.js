/**
 *   node --test utils/attendance_locked_correction.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const utils = require("./attendance_locked_correction");
const { attendanceImpact, attendanceSummary } = utils;

describe("attendanceImpact - minutes only", () => {
  it("12-09: lunch 14:00-15:00 on a 30-minute allowance moves worked, break and OT by 30", () => {
    const before = { worked_minutes: 685, break_charged_minutes: 30, candidate_ot_minutes: 235, approved_ot_minutes: 235 };
    const after = { worked_minutes: 655, break_charged_minutes: 60, candidate_ot_minutes: 205, approved_ot_minutes: 205 };
    assert.deepEqual(attendanceImpact(before, after), {
      worked_minutes: { before: 685, after: 655, change: -30 },
      break_charged_minutes: { before: 30, after: 60, change: 30 },
      ot_eligible_minutes: { before: 235, after: 205, change: -30 },
      approved_ot_minutes: { before: 235, after: 205, change: -30 },
    });
  });

  it("a missing figure is null, never a guess", () => {
    const r = attendanceImpact(null, { worked_minutes: 600 });
    assert.deepEqual(r.worked_minutes, { before: null, after: 600, change: null });
    assert.deepEqual(r.approved_ot_minutes, { before: null, after: null, change: null });
  });

  it("the module calculates no money at all", () => {
    assert.deepEqual(Object.keys(utils).sort(), ["attendanceImpact", "attendanceSummary"]);
    const text = require("fs").readFileSync(require("path").join(__dirname, "attendance_locked_correction.js"), "utf8");
    assert.ok(!/daily_rate|paise|rupee|net_pay|PAYABLE|RECOVERABLE|PENDING_ADJUSTMENT|NETTED_OFF/i.test(text));
  });
});

describe("attendanceSummary", () => {
  it("keeps the figures an auditor compares, and parses stored punch JSON", () => {
    const s = attendanceSummary({
      attendance_date: "2026-09-12", status: "FINAL", is_final: 1, punch_count: 2,
      effective_punches: JSON.stringify([{ io_time: "2026-09-12 10:09:00", source: "BIOMAX" }]),
      worked_minutes: 685, break_charged_minutes: 30, approved_ot_minutes: 235,
    });
    assert.equal(s.worked_minutes, 685);
    assert.equal(s.is_final, true);
    assert.deepEqual(s.effective_punches, [{ io_time: "2026-09-12 10:09:00", source: "BIOMAX" }]);
  });
});
