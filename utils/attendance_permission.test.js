/**
 * Attendance PERMISSION - the calculation matrix.
 *
 * Permission is PAID FORGIVEN SHORTAGE, never worked time. Every case below
 * holds the same invariant alongside its own numbers: worked, regular and
 * every OT figure are identical with and without the permission, the
 * permission only ever LOWERS the charged shortage, and grace and permission
 * never forgive the same minute twice.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CALC_STATUS, PUNCH_SOURCE, calculateAttendanceDay } = require("./attendance_engine");
const { buildShiftSnapshot } = require("./shiftResolution");
const {
  PERMISSION_SOURCE,
  PERMISSION_STATE,
  permissionState,
  isPermissionEffective,
  mergeIntervals,
  clipIntervals,
  overlapMinutes,
  allocatePermission,
} = require("./attendance_permission");

const DATE = "2026-09-14";
const NEXT = "2026-09-15";

function shift({ in_time = "10:00", out_time = "22:00", break_minutes = 60, config = {}, id = 7 } = {}) {
  return buildShiftSnapshot(
    {
      work_shift_id: id,
      work_shift_weekly_schedule_id: id * 10 + 1,
      is_working_day: 1,
      in_time,
      out_time,
      attendance_day_cutoff: "04:00",
      break_minutes,
      ot_rate: 1.5,
    },
    { work_shift_id: id, shift_code: "S" + id, overtime_allowed: 1, ...config },
    1
  );
}

const at = (t, date = DATE) => `${date} ${t}:00`;

function punches(...times) {
  return times.map((t, i) => ({
    punch_id: 5000 + i,
    source: PUNCH_SOURCE.BIOMAX,
    io_time: t.length > 5 ? t : at(t),
  }));
}

let nextId = 1;
function perm(from, to, source = PERMISSION_SOURCE.DIRECT) {
  return {
    attendance_permission_id: nextId++,
    source,
    permission_from: from.length > 5 ? from : at(from),
    permission_to: to.length > 5 ? to : at(to),
  };
}

const OT_FIELDS = [
  "worked_minutes",
  "regular_minutes",
  "span_minutes",
  "break_charged_minutes",
  "raw_ot_minutes",
  "candidate_ot_minutes",
  "pre_shift_ot_minutes",
  "post_shift_ot_minutes",
  "ot_offset_minutes",
  "approved_ot_minutes",
  "shift_authorised_ot_minutes",
  "excess_ot_minutes",
  "late_minutes",
  "early_exit_minutes",
  "grace_forgiven_minutes",
  "attendance_day_count",
  "status",
  "is_final",
  "punch_count",
];

/** Calculate with and without the permissions, and hold the invariant. */
function both(input, permissions) {
  const base = { employee_id: 9, attendance_date: DATE, shift: shift(), ...input };
  const without = calculateAttendanceDay(base);
  const withP = calculateAttendanceDay({ ...base, permissions });
  for (const key of OT_FIELDS) {
    assert.deepEqual(withP[key], without[key], `${key} must not move because of a permission`);
  }
  assert.deepEqual(withP.effective_punches, without.effective_punches, "no punch is manufactured");
  assert.deepEqual(withP.shift_snapshot, without.shift_snapshot, "the shift is never changed");
  assert.ok(withP.shortage_minutes <= without.shortage_minutes, "a permission only ever lowers the charge");
  assert.equal(withP.shortage_before_permission_minutes, without.shortage_minutes);
  assert.ok(withP.permission_minutes <= withP.permission_window_minutes);
  assert.equal(
    withP.permission_minutes,
    withP.permission_late_minutes + withP.permission_early_minutes + withP.permission_away_minutes
  );
  return { without, with: withP };
}

/* ======================================================== the examples == */

describe("Example 1 - early leaving inside the permission", () => {
  it("10:00-22:00, out 20:00, permission 20:00-22:00: 120 min, no charge, worked unchanged", () => {
    const r = both({ punches: punches("10:00", "20:00") }, [perm("20:00", "22:00")]);
    assert.equal(r.with.worked_minutes, 540, "actual work stays what was worked");
    assert.equal(r.with.shortage_before_permission_minutes, 120);
    assert.equal(r.with.permission_minutes, 120);
    assert.equal(r.with.permission_early_minutes, 120);
    assert.equal(r.with.shortage_minutes, 0, "salary deduction for those two hours is nil");
    assert.equal(r.with.payable_minutes, r.with.base_nrm_minutes, "full-day pay");
    assert.equal(r.with.status, CALC_STATUS.FINAL);
    assert.equal(r.with.permission_window_minutes, 120);
  });

  it("the display example: in 10:02 - the two late minutes are not covered", () => {
    const r = both({ punches: punches("10:02", "20:00") }, [perm("20:00", "22:00")]);
    assert.equal(r.with.permission_minutes, 120);
    assert.equal(r.with.shortage_minutes, 2);
  });
});

describe("Example 2 - leaving BEFORE the permission starts", () => {
  it("out 18:00, permission 20:00-22:00: only 120 covered, 18:00-20:00 still charged", () => {
    const r = both({ punches: punches("10:00", "18:00") }, [perm("20:00", "22:00")]);
    assert.equal(r.without.shortage_minutes, 240);
    assert.equal(r.with.permission_minutes, 120);
    assert.equal(r.with.shortage_minutes, 120, "the whole shortage is NOT converted to permission");
  });
});

describe("Example 3 - late coming", () => {
  it("permission 10:00-11:00, in 11:00: the hour is paid permission", () => {
    const r = both({ punches: punches("11:00", "22:00") }, [perm("10:00", "11:00")]);
    assert.equal(r.with.permission_late_minutes, 60);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("in 11:30 under the same permission: the last 30 minutes are still charged", () => {
    const r = both({ punches: punches("11:30", "22:00") }, [perm("10:00", "11:00")]);
    assert.equal(r.with.permission_minutes, 60);
    assert.equal(r.with.shortage_minutes, 30);
  });
});

describe("Example 4 - the festival release to the scheduled shift end", () => {
  it("permission 19:00 to shift end, the employee leaves at 19:00: full pay", () => {
    const r = both({ punches: punches("10:00", "19:00") }, [perm("19:00", "22:00")]);
    assert.equal(r.with.permission_minutes, 180);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("an employee who stays to 22:00 anyway earns no permission and no extra OT", () => {
    const r = both({ punches: punches("10:00", "22:00") }, [perm("19:00", "22:00")]);
    assert.equal(r.with.permission_minutes, 0);
    assert.equal(r.with.permission_window_minutes, 180);
    assert.match(r.with.notes.join(" "), /no chargeable shortage/);
  });
});

/* ============================================= no double counting == */

describe("grace -> permission -> remaining deduction", () => {
  const graceShift = (extra = {}) =>
    shift({ config: { late_grace_minutes: 10, late_exclude_grace_from_deduction: 1, ...extra } });

  it("grace forgives the first 10 minutes, the permission covers only what grace left", () => {
    const r = both({ shift: graceShift(), punches: punches("11:10", "22:00") }, [perm("10:00", "11:00")]);
    assert.equal(r.with.grace_forgiven_minutes, 10);
    assert.equal(r.with.permission_late_minutes, 50, "10:00-10:10 was grace's, not the permission's");
    assert.equal(r.with.shortage_minutes, 10, "11:00-11:10 is outside the window and is charged");
    assert.equal(r.with.grace_forgiven_minutes + r.with.permission_minutes + r.with.shortage_minutes, 70);
  });

  it("a late arrival inside grace leaves the permission nothing to cover", () => {
    const r = both({ shift: graceShift(), punches: punches("10:05", "22:00") }, [perm("10:00", "10:30")]);
    assert.equal(r.with.grace_forgiven_minutes, 5);
    assert.equal(r.with.permission_minutes, 0);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("the interval deduction rule prices only the residual after permission", () => {
    const cfg = { late_deduction_interval_minutes: 15, late_deduct_minutes: 30 };
    const r = both({ shift: shift({ config: cfg }), punches: punches("11:00", "22:00") }, [perm("10:00", "10:50")]);
    assert.equal(r.without.shortage_minutes, 120, "ceil(60/15) x 30");
    assert.equal(r.with.permission_minutes, 50);
    assert.equal(r.with.shortage_minutes, 30, "ceil(10/15) x 30 on the 10 residual minutes");
  });

  it("an early exit within grace is grace's; the permission covers none of it", () => {
    const cfg = { early_exit_grace_minutes: 15 };
    const r = both({ shift: shift({ config: cfg }), punches: punches("10:00", "21:50") }, [perm("21:00", "22:00")]);
    assert.equal(r.with.permission_minutes, 0);
    assert.equal(r.with.shortage_minutes, 0);
  });
});

describe("time the shortage does not contain is never covered", () => {
  it("an uncharged break already absorbed part of the early finish: 300 covered, not 360", () => {
    // 10:00-16:00 is six hours, so no break is charged: worked 360 against
    // NRM 660 is a 300 shortage although the early exit is 360.
    const r = both({ punches: punches("10:00", "16:00") }, [perm("16:00", "22:00")]);
    assert.equal(r.without.shortage_minutes, 300);
    assert.equal(r.with.permission_window_minutes, 360);
    assert.equal(r.with.permission_minutes, 300);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("a late arrival worked off at the end of the day is not paid again", () => {
    const r = both({ punches: punches("11:00", "23:00") }, [perm("10:00", "11:00")]);
    assert.equal(r.without.shortage_minutes, 0);
    assert.equal(r.with.permission_minutes, 0);
  });

  it("the no-lunch rule: left at 14:00 with permission to shift end", () => {
    const r = both({ punches: punches("10:00", "14:00") }, [perm("14:00", "22:00")]);
    assert.equal(r.with.break_credit_withheld, true);
    assert.equal(r.with.shortage_minutes, 0);
    assert.equal(r.with.permission_early_minutes, r.without.shortage_minutes);
  });

  it("a window outside the shift covers nothing", () => {
    const r = both({ punches: punches("10:00", "20:00") }, [perm("22:00", "23:30"), perm("08:00", "10:00")]);
    assert.equal(r.with.permission_window_minutes, 0);
    assert.equal(r.with.shortage_minutes, 120);
  });

  it("overlapping windows (a request and a direct grant) count each minute once", () => {
    const r = both({ punches: punches("10:00", "20:00") }, [
      perm("20:00", "22:00", PERMISSION_SOURCE.REQUEST),
      perm("20:30", "22:00", PERMISSION_SOURCE.DIRECT),
    ]);
    assert.equal(r.with.permission_window_minutes, 120);
    assert.equal(r.with.permission_minutes, 120);
    assert.equal(r.with.permission_ids.length, 2);
  });
});

describe("away during the shift (four or more punches)", () => {
  it("a permitted absence beyond the ordinary lunch is covered", () => {
    const r = both(
      { punches: punches("10:00", "13:00", "14:00", "16:00", "18:00", "22:00") },
      [perm("16:00", "18:00")]
    );
    assert.equal(r.without.shortage_minutes, 120);
    assert.equal(r.with.permission_away_minutes, 120);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("the break allowance is used up first: a lone 2h gap in the window covers only the 1h excess", () => {
    const r = both({ punches: punches("10:00", "16:00", "18:00", "22:00") }, [perm("16:00", "18:00")]);
    assert.equal(r.without.shortage_minutes, 60);
    assert.equal(r.with.permission_away_minutes, 60);
    assert.equal(r.with.shortage_minutes, 0);
  });

  it("an over-long lunch outside the window stays charged", () => {
    const r = both(
      { punches: punches("10:00", "13:00", "15:00", "16:00", "17:00", "22:00") },
      [perm("16:00", "17:00")]
    );
    // gaps 120 + 60 = 180, allowance 60: 120 excess, 60 of it permitted
    assert.equal(r.without.shortage_minutes, 120);
    assert.equal(r.with.permission_away_minutes, 60);
    assert.equal(r.with.shortage_minutes, 60);
  });
});

describe("days a permission cannot pay", () => {
  it("an ABSENT day stays absent and unpaid", () => {
    const r = both({ punches: [] }, [perm("10:00", "22:00")]);
    assert.equal(r.with.status, CALC_STATUS.ABSENT);
    assert.equal(r.with.permission_minutes, 0);
    assert.equal(r.with.payable_minutes, 0);
    assert.match(r.with.notes.join(" "), /does not apply to an absent day/);
  });

  it("an odd punch count stays Missing Punch; permission waits for the correction", () => {
    const r = both({ punches: punches("10:00", "14:00", "15:00") }, [perm("20:00", "22:00")]);
    assert.equal(r.with.is_final, false);
    assert.equal(r.with.permission_minutes, 0);
    assert.match(r.with.notes.join(" "), /once the missing punch is resolved/);
  });

  it("an employee not required to punch is untouched", () => {
    const r = both({ punches: [], attendance_required: false }, [perm("10:00", "22:00")]);
    assert.equal(r.with.status, CALC_STATUS.ATTENDANCE_NOT_REQUIRED);
    assert.equal(r.with.permission_minutes, 0);
  });

  it("no shift for the date: nothing is calculated", () => {
    const r = both({ shift: null, punches: punches("10:00", "20:00") }, [perm("20:00", "22:00")]);
    assert.equal(r.with.permission_minutes, 0);
  });
});

describe("an overnight shift", () => {
  it("18:00-02:00, out 00:00, permission 00:00-02:00 on the next calendar day", () => {
    const night = shift({ in_time: "18:00", out_time: "02:00", break_minutes: 30 });
    const r = both(
      { shift: night, punches: punches(at("18:00"), at("00:00", NEXT)) },
      [perm(at("00:00", NEXT), at("02:00", NEXT))]
    );
    // Six hours on the premises charge no break, so the 30-minute allowance
    // already absorbed part of the early finish: 90 is chargeable, not 120.
    assert.equal(r.without.shortage_minutes, 90);
    assert.equal(r.with.permission_window_minutes, 120);
    assert.equal(r.with.permission_early_minutes, 90);
    assert.equal(r.with.shortage_minutes, 0);
  });
});

describe("a one-day shift override (payroll base differs)", () => {
  it("permission is capped at the arithmetic shortage against the base NRM", () => {
    const temp = shift({ in_time: "10:00", out_time: "22:00", id: 8 });
    const baseShift = shift({ in_time: "18:00", out_time: "22:00", break_minutes: 0, id: 7 });
    // base NRM 240. Worked 10:00-13:00 = 180: arithmetic shortage 60.
    const r = both({ shift: temp, base_shift: baseShift, punches: punches("10:00", "13:00") }, [perm("13:00", "22:00")]);
    assert.equal(r.without.shortage_minutes, 60);
    assert.equal(r.with.permission_minutes, 60);
    assert.equal(r.with.shortage_minutes, 0);
  });
});

/* =========================================== the OT invariant, broadly == */

describe("THE INVARIANT: a permission never creates or increases OT", () => {
  const configs = [
    {},
    { late_grace_minutes: 10, late_exclude_grace_from_deduction: 1, early_exit_grace_minutes: 10 },
    { late_deduction_interval_minutes: 15, late_deduct_minutes: 30, early_exit_deduction_interval_minutes: 30, early_exit_deduct_minutes: 30 },
    { late_offset_against_overtime: 1, early_exit_offset_against_overtime: 1 },
    { pre_shift_overtime_allowed: 1, overtime_minimum_minutes: 30, overtime_rounding_method: "DOWN", overtime_rounding_interval_minutes: 30 },
  ];
  const ins = ["09:00", "10:00", "10:20", "11:00", "12:30"];
  const outs = ["14:00", "18:00", "20:00", "21:45", "22:00", "23:30"];
  const windows = [
    [perm("10:00", "11:00")],
    [perm("20:00", "22:00")],
    [perm("10:00", "22:00")],
    [perm("15:00", "17:00")],
    [perm("09:00", "10:30"), perm("21:00", "23:00")],
  ];

  it("holds over every combination of shift rules, punches and windows", () => {
    let checked = 0;
    for (const config of configs) {
      for (const i of ins) {
        for (const o of outs) {
          for (const w of windows) {
            both({ shift: shift({ config }), punches: punches(i, o), approved_ot_minutes: 600 }, w);
            both({ shift: shift({ config }), punches: punches(i, "15:00", "17:00", o), approved_ot_minutes: 600 }, w);
            checked += 2;
          }
        }
      }
    }
    assert.ok(checked > 500);
  });

  it("holds on a shift-authorised OT day", () => {
    const temp = shift({ in_time: "10:00", out_time: "22:00", id: 8 });
    const baseShift = shift({ in_time: "10:00", out_time: "18:00", id: 7 });
    both(
      { shift: temp, base_shift: baseShift, shift_authorised: true, shift_change_request_id: 3, punches: punches("11:00", "22:00") },
      [perm("10:00", "11:00")]
    );
  });
});

/* ======================================================= pure helpers == */

describe("interval helpers", () => {
  it("merge sorts, joins touching windows and drops empty ones", () => {
    assert.deepEqual(mergeIntervals([[30, 40], [0, 10], [10, 20], [50, 50], [5, 8]]), [[0, 20], [30, 40]]);
  });
  it("clip and overlap", () => {
    assert.deepEqual(clipIntervals([[0, 100]], 20, 30), [[20, 30]]);
    assert.equal(overlapMinutes([[0, 60], [120, 180]], 30, 150), 60);
  });
  it("allocation is capped by what each piece still charges", () => {
    const a = allocatePermission({
      permission_intervals: [[0, 1000]],
      late_counted: 5,
      late_window: [0, 60],
      early_counted: 100,
      early_window: [900, 960],
      away_counted: 0,
      gap_windows: [[300, 400]],
    });
    assert.deepEqual(a, { late: 5, early: 60, away: 0 });
  });
});

describe("derived state and effectiveness", () => {
  it("DIRECT is approved until revoked", () => {
    assert.equal(permissionState({ source: "DIRECT" }), PERMISSION_STATE.APPROVED);
    assert.equal(permissionState({ source: "DIRECT", revoked_at: "2026-09-14" }), PERMISSION_STATE.REVOKED);
    assert.equal(isPermissionEffective({ source: "DIRECT" }), true);
    assert.equal(isPermissionEffective({ source: "DIRECT", revoked_at: "x" }), false);
  });
  it("REQUEST follows its request; only APPROVED + SETTLED is effective", () => {
    assert.equal(permissionState({ source: "REQUEST", request_status: "PENDING" }), PERMISSION_STATE.PENDING);
    assert.equal(permissionState({ source: "REQUEST", request_status: "CANCELLED" }), PERMISSION_STATE.REVOKED);
    assert.equal(
      permissionState({ source: "REQUEST", request_status: "REJECTED", closure_reason: "NOT_APPROVED_BEFORE_PAYROLL_LOCK" }),
      PERMISSION_STATE.CLOSED_AT_PAYROLL_LOCK
    );
    assert.equal(isPermissionEffective({ source: "REQUEST", request_status: "APPROVED", finalization_state: "SETTLED" }), true);
    assert.equal(isPermissionEffective({ source: "REQUEST", request_status: "APPROVED", finalization_state: "PENDING" }), false);
    assert.equal(isPermissionEffective({ source: "REQUEST", request_status: "PENDING" }), false);
  });
});
