const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  OT_RATES,
  DAY_OF_WEEK_LABELS,
  WORK_SHIFT_CONFIG_FIELDS,
  parseTimeToMinutes,
  formatMinutesToTime,
  crossesMidnight,
  shiftSpanMinutes,
  computeNormalWorkMinutes,
  validateWeeklyScheduleRow,
  validateWeeklySchedule,
  validateWorkShiftConfig,
} = require("../utils/workShift");

/** A valid working day, so each test can vary just the one field. */
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

/** A complete, valid Sunday..Saturday week: Sunday rest, Mon-Sat working. */
function fullWeek(overrides = {}) {
  return DAY_OF_WEEK_LABELS.map((_, day) => {
    const row =
      day === 0
        ? { day_of_week: 0, is_working_day: false }
        : workingDay({ day_of_week: day });
    return { ...row, ...(overrides[day] || {}) };
  });
}

/** The minimum a create needs, so a test can vary one config field. */
function baseConfig(overrides = {}) {
  return { shift_code: "GEN", shift_name: "General", ...overrides };
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
    assert.equal(parseTimeToMinutes("14:00:30"), null);
    assert.equal(parseTimeToMinutes("not a time"), null);
    assert.equal(parseTimeToMinutes(""), null);
    assert.equal(parseTimeToMinutes(null), null);
  });

  it("formats back to the HH:MM:SS a TIME column takes", () => {
    assert.equal(formatMinutesToTime(840), "14:00:00");
    assert.equal(formatMinutesToTime(0), "00:00:00");
    assert.equal(formatMinutesToTime(1439), "23:59:00");
    assert.equal(formatMinutesToTime(null), null);
  });
});

describe("overnight shifts", () => {
  it("treats an out time before the in time as the next day", () => {
    assert.equal(crossesMidnight(1320, 360), true); // 22:00 -> 06:00
    assert.equal(crossesMidnight(540, 1080), false); // 09:00 -> 18:00
  });

  it("spans midnight without going negative", () => {
    assert.equal(shiftSpanMinutes(1320, 360), 480); // 22:00 -> 06:00
    assert.equal(shiftSpanMinutes(540, 1080), 540); // 09:00 -> 18:00
    assert.equal(shiftSpanMinutes(600, 600), 0);
  });

  it("computes the worked example: 22:00 -> 06:00 less a 30 minute break", () => {
    assert.equal(computeNormalWorkMinutes("22:00", "06:00", 30), 450);
  });

  it("computes an ordinary day the same way", () => {
    assert.equal(computeNormalWorkMinutes("09:00", "18:00", 60), 480);
  });
});

describe("weekly schedule row", () => {
  it("computes normal_work_minutes rather than trusting the caller", () => {
    const { errors, value } = validateWeeklyScheduleRow(workingDay());
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 450);
    assert.equal(value.in_time, "14:00:00");
    assert.equal(value.out_time, "22:00:00");
  });

  it("computes an overnight row correctly", () => {
    const { value } = validateWeeklyScheduleRow(
      workingDay({ in_time: "22:00", out_time: "06:00", break_minutes: 30 })
    );
    assert.equal(value.normal_work_minutes, 450);
  });

  it("rejects a normal_work_minutes that disagrees with the times", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ normal_work_minutes: 999 })
    );
    assert.match(errors.join(" "), /was sent as 999 but works out to 450/);
  });

  it("accepts a normal_work_minutes that agrees", () => {
    const { errors, value } = validateWeeklyScheduleRow(
      workingDay({ normal_work_minutes: 450 })
    );
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 450);
  });

  it("requires in and out on a working day", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ in_time: null, out_time: null })
    );
    assert.match(errors.join(" "), /in_time and out_time are required on a working day/);
  });

  it("gives a rest day zero minutes and allows null times", () => {
    const { errors, value } = validateWeeklyScheduleRow({
      day_of_week: 0,
      is_working_day: false,
    });
    assert.deepEqual(errors, []);
    assert.equal(value.normal_work_minutes, 0);
    assert.equal(value.in_time, null);
    assert.equal(value.out_time, null);
    assert.equal(value.is_working_day, 0);
  });

  it("keeps times typed on a rest day but still gives it zero minutes", () => {
    const { value } = validateWeeklyScheduleRow({
      day_of_week: 0,
      is_working_day: false,
      in_time: "09:00",
      out_time: "18:00",
    });
    assert.equal(value.normal_work_minutes, 0);
    assert.equal(value.in_time, "09:00:00");
  });

  it("rejects a break longer than the shift", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ in_time: "09:00", out_time: "10:00", break_minutes: 120 })
    );
    assert.match(errors.join(" "), /would leave negative working minutes/);
  });

  it("rejects a zero-length shift rather than guessing at 24 hours", () => {
    const { errors } = validateWeeklyScheduleRow(
      workingDay({ in_time: "09:00", out_time: "09:00" })
    );
    assert.match(errors.join(" "), /the shift is 0 minutes long/);
  });

  it("rejects a negative break", () => {
    const { errors } = validateWeeklyScheduleRow(workingDay({ break_minutes: -1 }));
    assert.match(errors.join(" "), /break_minutes must be an integer of 0 or more/);
  });

  it("accepts only the business OT rates", () => {
    OT_RATES.forEach((rate) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ ot_rate: rate }));
      assert.deepEqual(errors, [], `ot_rate ${rate} should be accepted`);
    });
  });

  it("rejects an OT rate that is not one of them", () => {
    [1.25, 2.5, 4, -1, "x"].forEach((rate) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ ot_rate: rate }));
      assert.match(errors.join(" "), /ot_rate must be one of/, `ot_rate ${rate}`);
    });
  });

  it("rejects a day_of_week outside 0-6, and null is not Sunday", () => {
    [7, -1, null, "Monday", 1.5].forEach((day) => {
      const { errors } = validateWeeklyScheduleRow(workingDay({ day_of_week: day }));
      assert.match(errors.join(" "), /day_of_week must be an integer 0-6/, `day ${day}`);
    });
  });

  it("validates attendance_day_cutoff as a time, separately from overnight", () => {
    const ok = validateWeeklyScheduleRow(
      workingDay({ in_time: "22:00", out_time: "06:00", attendance_day_cutoff: "04:00" })
    );
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.attendance_day_cutoff, "04:00:00");
    // and it is not required for an overnight shift to be valid
    assert.equal(ok.value.normal_work_minutes, 450);

    const bad = validateWeeklyScheduleRow(
      workingDay({ attendance_day_cutoff: "25:00" })
    );
    assert.match(bad.errors.join(" "), /attendance_day_cutoff must be a time of day/);
  });
});

describe("weekly schedule must be the complete week", () => {
  it("accepts exactly 7 days and returns them Sunday first", () => {
    const { errors, value } = validateWeeklySchedule(fullWeek());
    assert.deepEqual(errors, []);
    assert.equal(value.length, 7);
    assert.deepEqual(
      value.map((row) => row.day_of_week),
      [0, 1, 2, 3, 4, 5, 6]
    );
  });

  it("sorts a shuffled week into Sunday..Saturday order", () => {
    const shuffled = [...fullWeek()].reverse();
    const { errors, value } = validateWeeklySchedule(shuffled);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      value.map((row) => row.day_of_week),
      [0, 1, 2, 3, 4, 5, 6]
    );
  });

  it("rejects a missing weekday and names it, rather than inventing a rest day", () => {
    const sixDays = fullWeek().filter((row) => row.day_of_week !== 3);
    const { errors, value } = validateWeeklySchedule(sixDays);
    assert.equal(value, null);
    assert.match(errors.join(" "), /must contain all 7 days/);
    assert.match(errors.join(" "), /missing Wednesday/);
  });

  it("rejects a schedule with only some days, however few", () => {
    [1, 2, 5].forEach((count) => {
      const { errors, value } = validateWeeklySchedule(fullWeek().slice(0, count));
      assert.equal(value, null, `${count} days should be rejected`);
      assert.match(errors.join(" "), /must contain all 7 days/);
    });
  });

  it("rejects an empty schedule", () => {
    const { errors, value } = validateWeeklySchedule([]);
    assert.equal(value, null);
    assert.match(errors.join(" "), /must contain all 7 days/);
  });

  it("rejects a duplicated weekday", () => {
    const week = fullWeek();
    // Eight rows, Tuesday twice and no Wednesday.
    week.push(workingDay({ day_of_week: 2 }));
    const { errors, value } = validateWeeklySchedule(week);
    assert.equal(value, null);
    assert.match(errors.join(" "), /Tuesday: appears more than once/);
  });

  it("rejects a duplicate even when all 7 weekdays are present", () => {
    const week = [...fullWeek(), workingDay({ day_of_week: 6, in_time: "10:00" })];
    const { errors } = validateWeeklySchedule(week);
    assert.match(errors.join(" "), /Saturday: appears more than once/);
  });

  it("rejects a non-array", () => {
    assert.match(
      validateWeeklySchedule(null).errors.join(" "),
      /weekly_schedule must be an array/
    );
  });

  it("reports a bad row and still reports the days that were never sent", () => {
    const week = fullWeek().slice(0, 6);
    week[1] = workingDay({ day_of_week: 1, ot_rate: 7 });
    const { errors } = validateWeeklySchedule(week);
    assert.match(errors.join(" "), /ot_rate must be one of/);
    assert.match(errors.join(" "), /must contain all 7 days/);
  });
});

describe("work shift configuration", () => {
  it("requires shift_code on create", () => {
    ["", "   ", null, undefined].forEach((code) => {
      const { errors } = validateWorkShiftConfig(
        { shift_code: code, shift_name: "General" },
        { isCreate: true }
      );
      assert.match(
        errors.join(" "),
        /shift_code is required and cannot be blank/,
        `code ${JSON.stringify(code)}`
      );
    });
  });

  it("requires shift_name on create", () => {
    const { errors } = validateWorkShiftConfig({ shift_code: "GEN" }, { isCreate: true });
    assert.match(errors.join(" "), /shift_name is required/);
  });

  it("accepts a create with just a code and a name", () => {
    const { errors, value } = validateWorkShiftConfig(baseConfig(), { isCreate: true });
    assert.deepEqual(errors, []);
    assert.equal(value.shift_code, "GEN");
    assert.equal(value.shift_name, "General");
  });

  it("trims the code and caps its length", () => {
    assert.equal(
      validateWorkShiftConfig(baseConfig({ shift_code: "  EVE  " }), { isCreate: true })
        .value.shift_code,
      "EVE"
    );
    assert.match(
      validateWorkShiftConfig(baseConfig({ shift_code: "X".repeat(21) }), {
        isCreate: true,
      }).errors.join(" "),
      /shift_code must be 20 characters or fewer/
    );
  });

  it("will not let an update blank an existing shift_code", () => {
    const { errors } = validateWorkShiftConfig({ shift_code: "" });
    assert.match(errors.join(" "), /shift_code is required and cannot be blank/);
  });

  it("leaves out of the result what the caller did not send", () => {
    const { value } = validateWorkShiftConfig({ late_grace_minutes: 10 });
    assert.deepEqual(value, { late_grace_minutes: 10 });
  });

  it("has no daily timing fields - those live on the weekly schedule", () => {
    [
      "start_time",
      "end_time",
      "shift_in_time",
      "shift_out_time",
      "crosses_midnight",
      "break_minutes",
    ].forEach((field) => {
      assert.equal(
        WORK_SHIFT_CONFIG_FIELDS.includes(field),
        false,
        `${field} must not be a work_shift column`
      );
    });
  });

  it("ignores unknown keys instead of writing them", () => {
    const { value } = validateWorkShiftConfig({
      late_grace_minutes: 5,
      start_time: "09:00",
      shift_id: 3,
      drop_table: "x",
    });
    assert.deepEqual(value, { late_grace_minutes: 5 });
  });

  it("coerces booleans and rejects what is not one", () => {
    assert.equal(validateWorkShiftConfig({ overtime_allowed: true }).value.overtime_allowed, 1);
    assert.equal(validateWorkShiftConfig({ overtime_allowed: "0" }).value.overtime_allowed, 0);
    assert.match(
      validateWorkShiftConfig({ overtime_allowed: "maybe" }).errors.join(" "),
      /overtime_allowed must be true or false/
    );
  });

  it("rejects negative minute settings", () => {
    assert.match(
      validateWorkShiftConfig({ late_grace_minutes: -5 }).errors.join(" "),
      /late_grace_minutes must be an integer of 0 or more/
    );
    assert.match(
      validateWorkShiftConfig({ minimum_full_day_minutes: "abc" }).errors.join(" "),
      /minimum_full_day_minutes must be an integer of 0 or more/
    );
  });

  it("treats an empty maximum_ot_minutes_per_day as no cap", () => {
    assert.equal(
      validateWorkShiftConfig({ maximum_ot_minutes_per_day: "" }).value
        .maximum_ot_minutes_per_day,
      null
    );
    assert.equal(
      validateWorkShiftConfig({ maximum_ot_minutes_per_day: 120 }).value
        .maximum_ot_minutes_per_day,
      120
    );
  });

  it("accepts the four rounding methods and rejects anything else", () => {
    ["NONE", "UP", "DOWN", "NEAREST"].forEach((method) => {
      const { errors, value } = validateWorkShiftConfig({
        overtime_rounding_method: method.toLowerCase(),
      });
      assert.deepEqual(errors, [], method);
      assert.equal(value.overtime_rounding_method, method);
    });

    assert.match(
      validateWorkShiftConfig({ overtime_rounding_method: "CEILING" }).errors.join(" "),
      /overtime_rounding_method must be one of NONE, UP, DOWN, NEAREST/
    );
    assert.match(
      validateWorkShiftConfig({ pre_shift_overtime_rounding_method: "SIDEWAYS" }).errors.join(" "),
      /pre_shift_overtime_rounding_method must be one of/
    );
  });

  it("accepts the missed clock-in treatments and rejects anything else", () => {
    ["FULL_DAY", "HALF_DAY", "LEAVE"].forEach((treatment) => {
      const { errors, value } = validateWorkShiftConfig({
        missed_clock_in_treatment: treatment,
      });
      assert.deepEqual(errors, [], treatment);
      assert.equal(value.missed_clock_in_treatment, treatment);
    });

    assert.match(
      validateWorkShiftConfig({ missed_clock_in_treatment: "ABSENT" }).errors.join(" "),
      /missed_clock_in_treatment must be one of FULL_DAY, HALF_DAY, LEAVE/
    );
  });
});

describe("regularization", () => {
  it("is a boolean toggle, not a NONE/LIMITED/UNLIMITED enum", () => {
    assert.equal(
      WORK_SHIFT_CONFIG_FIELDS.includes("regularization_control"),
      false,
      "the superseded enum column must be gone"
    );
    assert.equal(WORK_SHIFT_CONFIG_FIELDS.includes("regularization_control_enabled"), true);

    assert.equal(
      validateWorkShiftConfig({ regularization_control_enabled: false }).value
        .regularization_control_enabled,
      0
    );
    assert.match(
      validateWorkShiftConfig({ regularization_control_enabled: "LIMITED" }).errors.join(" "),
      /regularization_control_enabled must be true or false/
    );
  });

  it("requires a monthly limit of at least 1 once control is enabled", () => {
    const { errors } = validateWorkShiftConfig({
      regularization_control_enabled: true,
    });
    assert.match(errors.join(" "), /regularization_limit_per_month must be at least 1/);

    assert.match(
      validateWorkShiftConfig({
        regularization_control_enabled: true,
        regularization_limit_per_month: 0,
      }).errors.join(" "),
      /must be at least 1/
    );
  });

  it("accepts control enabled together with a limit", () => {
    const { errors, value } = validateWorkShiftConfig({
      regularization_control_enabled: true,
      regularization_limit_per_month: 3,
    });
    assert.deepEqual(errors, []);
    assert.equal(value.regularization_limit_per_month, 3);
  });

  it("judges the limit on the shift as it will be, not on this request alone", () => {
    // Control already on and a limit already stored: turning nothing else on
    // must not fail just because this request did not resend the limit.
    const { errors } = validateWorkShiftConfig(
      { late_grace_minutes: 5 },
      { existing: { regularization_control_enabled: 1, regularization_limit_per_month: 2 } }
    );
    assert.deepEqual(errors, []);

    // Enabling control against a stored row that has no limit must fail.
    assert.match(
      validateWorkShiftConfig(
        { regularization_control_enabled: true },
        { existing: { regularization_limit_per_month: null } }
      ).errors.join(" "),
      /must be at least 1/
    );

    // Enabling control against a stored row that already has one is fine.
    assert.deepEqual(
      validateWorkShiftConfig(
        { regularization_control_enabled: true },
        { existing: { regularization_limit_per_month: 4 } }
      ).errors,
      []
    );

    // Clearing the limit while control stays on must fail.
    assert.match(
      validateWorkShiftConfig(
        { regularization_limit_per_month: "" },
        { existing: { regularization_control_enabled: 1, regularization_limit_per_month: 2 } }
      ).errors.join(" "),
      /must be at least 1/
    );
  });

  it("leaves the limit alone while control is off", () => {
    const { errors, value } = validateWorkShiftConfig({
      regularization_control_enabled: false,
      regularization_limit_per_month: "",
    });
    assert.deepEqual(errors, []);
    assert.equal(value.regularization_limit_per_month, null);
  });

  it("carries require_existing_punch and requires_approval as booleans", () => {
    const { errors, value } = validateWorkShiftConfig({
      regularization_require_existing_punch: false,
      regularization_requires_approval: true,
    });
    assert.deepEqual(errors, []);
    assert.equal(value.regularization_require_existing_punch, 0);
    assert.equal(value.regularization_requires_approval, 1);
  });

  it("does not invent values for the two default-ON flags when they are not sent", () => {
    // The DB default (1) is what applies; the validator must not write a 0.
    const { value } = validateWorkShiftConfig(baseConfig(), { isCreate: true });
    assert.equal("regularization_require_existing_punch" in value, false);
    assert.equal("regularization_requires_approval" in value, false);
  });
});
