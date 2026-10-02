/**
 *   node --test utils/attendance_locked_correction.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { priceLockedDayCorrection, attendanceSummary, DIRECTION } = require("./attendance_locked_correction");

// Monthly gross 26,000 -> daily rate 1,000.00 on the frozen row.
const frozen = { payrun_calculation_id: 55, calculation_hash: "h", daily_rate: "1000.00", net_pay: "24500.00" };
const day = (o = {}) => ({ attendance_day_count: 1, is_final: 1, nrm_minutes: 450, shortage_minutes: 0, approved_ot_minutes: 0, ...o });

describe("priceLockedDayCorrection", () => {
  it("DECREASE: approved OT 235 -> 205 on a 450-minute NRM is recoverable", () => {
    const r = priceLockedDayCorrection({
      frozen,
      old_day: day({ approved_ot_minutes: 235 }),
      new_day: day({ approved_ot_minutes: 205 }),
    });
    // Priced on the day alone: round(235/60 x 133.33) - round(205/60 x 133.33)
    assert.equal(r.components.approved_ot.amount, -66.66);
    assert.equal(r.net_difference, -66.66);
    assert.equal(r.absolute_amount, 66.66);
    assert.equal(r.direction, DIRECTION.RECOVERABLE_FROM_EMPLOYEE);
    assert.equal(r.adjustment_status, "PENDING_ADJUSTMENT");
    assert.equal(r.statutory_recomputed, false);
    assert.deepEqual(r.basis, { payrun_calculation_id: 55, calculation_hash: "h", daily_rate: 1000, frozen_net_pay: 24500 });
  });

  it("INCREASE: a held missing-punch day that becomes final pays its OT and charges its shortage", () => {
    // Before: odd punches, not final - the day counted, shortage/OT held.
    // After: final, 60 approved OT, 15 short.
    const r = priceLockedDayCorrection({
      frozen,
      old_day: day({ is_final: 0, approved_ot_minutes: 0, shortage_minutes: 0 }),
      new_day: day({ approved_ot_minutes: 60, shortage_minutes: 15 }),
    });
    assert.equal(r.components.attendance_days.amount, 0, "the day already counted");
    assert.equal(r.components.approved_ot.amount, 133.33);
    assert.equal(r.components.missing_minutes.amount, -33.33);
    assert.equal(r.net_difference, 100);
    assert.equal(r.direction, DIRECTION.PAYABLE_TO_EMPLOYEE);
  });

  it("a day that was not attended at all and now is: one daily rate", () => {
    const r = priceLockedDayCorrection({ frozen, old_day: null, new_day: day() });
    assert.equal(r.components.attendance_days.amount, 1000);
    assert.equal(r.direction, DIRECTION.PAYABLE_TO_EMPLOYEE);
  });

  it("NO DIFFERENCE: a lunch that equals the deemed break changes nothing monetary", () => {
    const r = priceLockedDayCorrection({ frozen, old_day: day({ approved_ot_minutes: 235 }), new_day: day({ approved_ot_minutes: 235 }) });
    assert.equal(r.net_difference, 0);
    assert.equal(r.direction, DIRECTION.NO_DIFFERENCE);
    assert.equal(r.adjustment_status, "NOT_REQUIRED");
  });

  it("prices OT on the frozen row's NRM-group total, rounded once as the payrun rounds it", () => {
    // The month had 400 approved OT minutes at NRM 450 (frozen OT 888.89).
    const withGroups = { ...frozen, ot_groups: JSON.stringify([{ nrm_minutes: 450, approved_ot_minutes: 400 }]) };
    const r = priceLockedDayCorrection({
      frozen: withGroups,
      old_day: day({ approved_ot_minutes: 235 }),
      new_day: day({ approved_ot_minutes: 205 }),
    });
    // round(370/60 x 13333.33) - round(400/60 x 13333.33) = 82222 - 88889
    assert.equal(r.components.approved_ot.amount, -66.67);
    assert.equal(r.direction, DIRECTION.RECOVERABLE_FROM_EMPLOYEE);
  });

  it("refuses a frozen row with no daily rate rather than guessing", () => {
    assert.throws(() => priceLockedDayCorrection({ frozen: { daily_rate: null }, old_day: day(), new_day: day() }), /no daily rate/);
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
    assert.deepEqual(s.effective_punches, [{ io_time: "2026-09-12 10:09:00", source: "BIOMAX" }]);
  });
});
