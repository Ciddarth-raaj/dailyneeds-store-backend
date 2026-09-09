const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  OT_RATES,
  parseTimeToMinutes,
  formatMinutesToTime,
  crossesMidnight,
  shiftSpanMinutes,
  computeNormalWorkMinutes,
  validateWeeklyScheduleRow,
  validateWeeklySchedule,
  validateShiftConfig,
  withLegacyColumns,
} = require("../utils/shiftSchedule");

/** A valid Monday working day, so each test can vary just the one field. */
function workingDay(overrides = {}) {
  return {
    day_of_week: 1,
    is_working_day: true,
    in_time: "14:00",
    out_time: "22:00",
    break_minutes: 30,
    ot_rate: 1,
    ...overrides,
  };
}

describe("time parsing", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    assert.equal(parseTimeToMinutes("14:00"), 840);
    assert.equal(parseTimeToMinutes("14:00:00"), 840);
    assert.equal(parseTimeToMinutes("00:00"), 0);
    assert.equal(parseTimeToMinutes("23:59"), 1439);
    assert.equal(parseTimeToMinutes("6:05"), 365);
  });

  it("rejects nonsense, out-of-range and part-minute times", () => {
    assert.equal(parseTimeToMinutes("24:00"), null);
    assert.equal(parseTimeToMinutes("14:60"), null);
    assert.equal(parseTimeToMinutes("2pm"), null);
    assert.equal(parseTimeToMinutes("14"), null);
    assert.equal(parseTimeToMinutes(""), null);
    assert.equal(parseTimeToMinutes(null), null);
    // Seconds are rejected rather than truncated: truncating would quietly
    // change the computed duration.
    assert.equal(parseTimeToMinutes("14:00:30"), null);
  });

  it("formats back to what MySQL stores in a TIME column", () => {
    assert.equal(formatMinutesToTime(840), "14:00:00");
    assert.equal(formatMinutesToTime(0), "00:00:00");
    assert.equal(formatMinutesToTime(1439), "23:59:00");
  });
});

describe("shift duration", () => {
  it("measures a same-day shift", () => {
    assert.equal(shiftSpanMinutes(840, 1320), 480); // 14:00 -> 22:00
  });

  it("treats an out time before the in time as the next day", () => {
    assert.equal(shiftSpanMinutes(1320, 360), 480); // 22:00 -> 06:00
    assert.equal(shiftSpanMinutes(1380, 480), 540); // 23:00 -> 08:00
  });

  it("reports zero for identical times rather than guessing 24 hours", () => {
    assert.equal(shiftSpanMinutes(540, 540), 0);
  });

  it("flags only a shift that really does run past midnight", () => {
    assert.equal(crossesMidnight(1320, 360), true); // 22:00 -> 06:00
    assert.equal(crossesMidnight(840, 1320), false); // 14:00 -> 22:00
    assert.equal(crossesMidnight(540, 540), false);
  });

  it("subtracts the break to get normal working minutes", () => {
    // The worked example from the Phase 1 spec.
    assert.equal(computeNormalWorkMinutes("14:00", "22:00", 30), 450);
    // The same, overnight.
    assert.equal(computeNormalWorkMinutes("22:00", "06:00", 30), 450);
    assert.equal(computeNormalWorkMinutes("09:00", "18:00", 60), 480);
  });
});

describe("weekly schedule row validation", () => {
  it("computes normal_work_minutes for a working day", () => {
    const { errors, value } = validateWeeklyScheduleRow(workingDay());
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 450);
    assert.equal(value.in_time, "14:00:00");
    assert.equal(value.out_time, "22:00:00");
    assert.equal(value.is_working_day, 1);
  });

  it("computes it correctly across midnight", () => {
    const { errors, value } = validateWeeklyScheduleRow(
      workingDay({ in_time: "22:00", out_time: "06:00" })
    );
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 450);
  });

  it("accepts a supplied normal_work_minutes that agrees", () => {
    const { errors, value } = validateWeeklyScheduleRow(
      workingDay({ normal_work_minutes: 450 })
    );
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 450);
  });

  it("rejects a supplied normal_work_minutes that disagrees", () => {
    const { errors, value } = validateWeeklyScheduleRow(
      workingDay({ normal_work_minutes: 480 })
    );
    assert.equal(value, null);
    assert.match(errors[0], /sent as 480 but works out to 450/);
  });

  it("rejects a break longer than the shift", () => {
    const { errors, value } = validateWeeklyScheduleRow(
      workingDay({ in_time: "09:00", out_time: "10:00", break_minutes: 90 })
    );
    assert.equal(value, null);
    assert.match(errors[0], /negative working minutes/);
  });

  it("rejects a negative break", () => {
    const { errors } = validateWeeklyScheduleRow(workingDay({ break_minutes: -5 }));
    assert.match(errors.join(" "), /break_minutes must be an integer of 0 or more/);
  });

  it("requires in and out times on a working day", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ in_time: "", out_time: "" })
    );
    assert.match(errors.join(" "), /in_time and out_time are required on a working day/);
  });

  it("rejects a working day of zero length", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ in_time: "09:00", out_time: "09:00", break_minutes: 0 })
    );
    assert.match(errors.join(" "), /0 minutes long/);
  });

  it("does not require working hours on a rest day", () => {
    const { errors, value } = validateWeeklyScheduleRow({
      day_of_week: 0,
      is_working_day: false,
    });
    assert.deepEqual(errors, []);
    assert.equal(value.is_working_day, 0);
    assert.equal(value.in_time, null);
    assert.equal(value.out_time, null);
    assert.equal(value.normal_work_minutes, 0);
  });

  it("keeps times on a rest day but gives it no working minutes", () => {
    const { errors, value } = validateWeeklyScheduleRow({
      day_of_week: 0,
      is_working_day: false,
      in_time: "09:00",
      out_time: "18:00",
    });
    assert.deepEqual(errors, []);
    assert.equal(value.in_time, "09:00:00");
    assert.equal(value.normal_work_minutes, 0);
  });

  it("allows only the agreed OT rates", () => {
    OT_RATES.forEach((rate) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ ot_rate: rate }));
      assert.deepEqual(errors, [], `ot_rate ${rate} should be allowed`);
    });

    [0.5, 1.25, 2.5, 4, -1, "double"].forEach((rate) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ ot_rate: rate }));
      assert.match(errors.join(" "), /ot_rate must be one of/, `ot_rate ${rate} should be rejected`);
    });
  });

  it("checks the weekday is a weekday", () => {
    [0, 1, 2, 3, 4, 5, 6].forEach((day) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ day_of_week: day }));
      assert.deepEqual(errors, []);
    });

    [-1, 7, 1.5, "Monday", null].forEach((day) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ day_of_week: day }));
      assert.match(errors.join(" "), /day_of_week must be an integer 0-6/);
    });
  });

  it("does not let null or false coerce to a valid 0", () => {
    // Number(null) and Number(false) are both 0, which would otherwise pass
    // as Sunday and as an OT rate of 0.
    assert.match(
      validateWeeklyScheduleRow(workingDay({ day_of_week: null })).errors.join(" "),
      /day_of_week must be an integer 0-6/
    );
    assert.match(
      validateWeeklyScheduleRow(workingDay({ day_of_week: false })).errors.join(" "),
      /day_of_week must be an integer 0-6/
    );
    assert.match(
      validateWeeklyScheduleRow(workingDay({ ot_rate: null })).errors.join(" "),
      /ot_rate must be one of/
    );
    assert.match(
      validateShiftConfig({ late_grace_minutes: false }).errors.join(" "),
      /late_grace_minutes must be an integer of 0 or more/
    );
  });

  it("validates the attendance day cutoff as a time of day", () => {
    const ok = validateWeeklyScheduleRow(
      workingDay({ attendance_day_cutoff: "04:00" })
    );
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.attendance_day_cutoff, "04:00:00");

    const bad = validateWeeklyScheduleRow(
      workingDay({ attendance_day_cutoff: "not a time" })
    );
    assert.match(bad.errors.join(" "), /attendance_day_cutoff must be a time of day/);
  });
});

describe("weekly schedule validation", () => {
  it("accepts one row per weekday", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((day) =>
      workingDay({ day_of_week: day })
    );
    const { errors, value } = validateWeeklySchedule(rows);
    assert.deepEqual(errors, []);
    assert.equal(value.length, 7);
  });

  it("rejects the same weekday twice for one shift", () => {
    const { errors, value } = validateWeeklySchedule([
      workingDay({ day_of_week: 1 }),
      workingDay({ day_of_week: 1, in_time: "09:00", out_time: "17:00" }),
    ]);
    assert.equal(value, null);
    assert.match(errors.join(" "), /appears more than once/);
  });

  it("accepts a partial week", () => {
    const { errors, value } = validateWeeklySchedule([
      workingDay({ day_of_week: 1 }),
      { day_of_week: 0, is_working_day: false },
    ]);
    assert.deepEqual(errors, []);
    assert.equal(value.length, 2);
  });

  it("rejects anything that is not an array", () => {
    assert.match(
      validateWeeklySchedule({ day_of_week: 1 }).errors.join(" "),
      /must be an array/
    );
  });

  it("reports every bad row, not just the first", () => {
    const { errors } = validateWeeklySchedule([
      workingDay({ day_of_week: 1, ot_rate: 7 }),
      workingDay({ day_of_week: 2, break_minutes: -1 }),
    ]);
    assert.equal(errors.length, 2);
  });
});

describe("shift configuration validation", () => {
  it("accepts the legacy field names and folds them onto the new ones", () => {
    const { errors, value } = validateShiftConfig({
      shift_name: "Evening",
      shift_in_time: "14:00",
      shift_out_time: "22:00",
      status: 1,
    });
    assert.deepEqual(errors, []);
    assert.equal(value.start_time, "14:00:00");
    assert.equal(value.end_time, "22:00:00");
    assert.equal(value.active, 1);
  });

  it("prefers the new name when a payload carries both", () => {
    const { value } = validateShiftConfig({
      start_time: "09:00",
      shift_in_time: "14:00",
    });
    assert.equal(value.start_time, "09:00:00");
  });

  it("derives crosses_midnight from the times", () => {
    assert.equal(
      validateShiftConfig({ start_time: "22:00", end_time: "06:00" }).value
        .crosses_midnight,
      1
    );
    assert.equal(
      validateShiftConfig({ start_time: "09:00", end_time: "18:00" }).value
        .crosses_midnight,
      0
    );
  });

  it("lets an explicit crosses_midnight win over the derived one", () => {
    const { value } = validateShiftConfig({
      start_time: "09:00",
      end_time: "18:00",
      crosses_midnight: true,
    });
    assert.equal(value.crosses_midnight, 1);
  });

  it("allows only the agreed rounding methods", () => {
    ["NONE", "UP", "DOWN", "NEAREST"].forEach((method) => {
      const { errors, value } = validateShiftConfig({ overtime_rounding_method: method });
      assert.deepEqual(errors, []);
      assert.equal(value.overtime_rounding_method, method);
    });

    assert.match(
      validateShiftConfig({ overtime_rounding_method: "CEILING" }).errors.join(" "),
      /overtime_rounding_method must be one of/
    );
    assert.match(
      validateShiftConfig({ pre_shift_overtime_rounding_method: "CEILING" }).errors.join(" "),
      /pre_shift_overtime_rounding_method must be one of/
    );
  });

  it("allows only the agreed missed clock-in treatments", () => {
    assert.deepEqual(
      validateShiftConfig({ missed_clock_in_treatment: "half_day" }).value
        .missed_clock_in_treatment,
      "HALF_DAY"
    );
    assert.match(
      validateShiftConfig({ missed_clock_in_treatment: "QUARTER_DAY" }).errors.join(" "),
      /missed_clock_in_treatment must be one of/
    );
  });

  it("allows only the agreed regularization controls", () => {
    assert.equal(
      validateShiftConfig({ regularization_control: "LIMITED" }).value
        .regularization_control,
      "LIMITED"
    );
    assert.match(
      validateShiftConfig({ regularization_control: "SOMETIMES" }).errors.join(" "),
      /regularization_control must be one of/
    );
  });

  it("rejects negative minute settings", () => {
    assert.match(
      validateShiftConfig({ late_grace_minutes: -5 }).errors.join(" "),
      /late_grace_minutes must be an integer of 0 or more/
    );
    assert.match(
      validateShiftConfig({ overtime_minimum_minutes: 1.5 }).errors.join(" "),
      /overtime_minimum_minutes must be an integer of 0 or more/
    );
  });

  it("treats an empty cap as no cap", () => {
    assert.equal(validateShiftConfig({ maximum_ot_minutes_per_day: "" }).value.maximum_ot_minutes_per_day, null);
    assert.equal(validateShiftConfig({ maximum_ot_minutes_per_day: 120 }).value.maximum_ot_minutes_per_day, 120);
  });

  it("normalizes the booleans to what a TINYINT column wants", () => {
    const { value } = validateShiftConfig({
      overtime_allowed: true,
      pre_shift_overtime_allowed: "false",
      late_offset_against_overtime: 1,
    });
    assert.equal(value.overtime_allowed, 1);
    assert.equal(value.pre_shift_overtime_allowed, 0);
    assert.equal(value.late_offset_against_overtime, 1);
  });

  it("ignores keys that are not shift configuration", () => {
    const { errors, value } = validateShiftConfig({
      shift_name: "Morning",
      shift_id: 99,
      dropped_table: "; DROP TABLE shift_master;",
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.keys(value), ["shift_name"]);
  });

  it("returns only the keys the caller sent, so a partial update stays partial", () => {
    const { value } = validateShiftConfig({ break_minutes: 45 });
    assert.deepEqual(value, { break_minutes: 45 });
  });

  it("checks shift_code length", () => {
    assert.equal(validateShiftConfig({ shift_code: "EVE" }).value.shift_code, "EVE");
    assert.equal(validateShiftConfig({ shift_code: "" }).value.shift_code, null);
    assert.match(
      validateShiftConfig({ shift_code: "X".repeat(21) }).errors.join(" "),
      /shift_code must be 20 characters or fewer/
    );
  });
});

describe("legacy column mirroring", () => {
  it("writes both spellings so the two cannot drift apart", () => {
    const row = withLegacyColumns({
      shift_name: "Evening",
      start_time: "14:00:00",
      end_time: "22:00:00",
      active: 1,
    });
    assert.equal(row.shift_in_time, "14:00:00");
    assert.equal(row.shift_out_time, "22:00:00");
    assert.equal(row.status, 1);
    // and the new names are still there
    assert.equal(row.start_time, "14:00:00");
    assert.equal(row.active, 1);
  });

  it("leaves alone what the caller did not set", () => {
    const row = withLegacyColumns({ break_minutes: 30 });
    assert.deepEqual(row, { break_minutes: 30 });
  });
});
