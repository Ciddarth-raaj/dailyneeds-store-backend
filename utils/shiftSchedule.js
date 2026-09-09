/**
 * Shift Master validation - Phase 1 (payroll foundation).
 *
 * Pure functions only: no database, no Express. The backend is the
 * authoritative validator for a weekly schedule, so `normal_work_minutes` is
 * always recomputed here from in/out/break rather than taken on trust from
 * whatever the caller sent. A caller that sends a value which disagrees with
 * the computed one gets an error naming both numbers, which is how a frontend
 * arithmetic bug surfaces immediately instead of quietly reaching payroll.
 *
 * Nothing in this file calculates pay. The lateness, early-out and OT settings
 * validated here are configuration for engines that are a later phase.
 */

const MINUTES_PER_DAY = 1440;

/**
 * 0=Sunday..6=Saturday - the numbering JavaScript's `Date.getDay()` and
 * node-cron already use, and the one utils/api_sync_log_helpers.js works in.
 */
const DAY_OF_WEEK_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The only OT multipliers the business uses. */
const OT_RATES = [0, 1, 1.5, 2, 3];

const ROUNDING_METHODS = ["NONE", "UP", "DOWN", "NEAREST"];
const MISSED_CLOCK_IN_TREATMENTS = ["FULL_DAY", "HALF_DAY", "LEAVE"];
const REGULARIZATION_CONTROLS = ["NONE", "LIMITED", "UNLIMITED"];

/**
 * Old column name -> new one. Both spellings are accepted on the way in for as
 * long as `shift_in_time` / `shift_out_time` / `status` remain on the table.
 */
const LEGACY_FIELD_ALIASES = {
  shift_in_time: "start_time",
  shift_out_time: "end_time",
  status: "active",
};

const BOOLEAN_FIELDS = [
  "active",
  "crosses_midnight",
  "late_exclude_grace_from_deduction",
  "late_offset_against_overtime",
  "early_exit_offset_against_overtime",
  "overtime_allowed",
  "overtime_minimum_threshold_only",
  "pre_shift_overtime_allowed",
  "missed_clock_in_rule_enabled",
  "minimum_hours_rule_enabled",
  "regularization_allowed",
  "regularization_require_existing_punch",
  "regularization_requires_approval",
];

const NON_NEGATIVE_INT_FIELDS = [
  "break_minutes",
  "late_grace_minutes",
  "late_deduction_interval_minutes",
  "late_deduct_minutes",
  "early_exit_grace_minutes",
  "early_exit_deduction_interval_minutes",
  "early_exit_deduct_minutes",
  "overtime_minimum_minutes",
  "overtime_rounding_interval_minutes",
  "pre_shift_overtime_minimum_minutes",
  "pre_shift_overtime_rounding_interval_minutes",
  "minimum_half_day_minutes",
  "minimum_full_day_minutes",
];

/** Same, but NULL is meaningful: "no cap" / "no limit". */
const NULLABLE_NON_NEGATIVE_INT_FIELDS = [
  "maximum_ot_minutes_per_day",
  "regularization_limit_per_month",
];

const ENUM_FIELDS = {
  overtime_rounding_method: ROUNDING_METHODS,
  pre_shift_overtime_rounding_method: ROUNDING_METHODS,
  missed_clock_in_treatment: MISSED_CLOCK_IN_TREATMENTS,
  regularization_control: REGULARIZATION_CONTROLS,
};

const TIME_FIELDS = ["start_time", "end_time"];

/** Every shift_master field a caller may set, for whitelisting a payload. */
const SHIFT_CONFIG_FIELDS = [
  "shift_code",
  "shift_name",
  "paid_hours",
  ...TIME_FIELDS,
  ...BOOLEAN_FIELDS,
  ...NON_NEGATIVE_INT_FIELDS,
  ...NULLABLE_NON_NEGATIVE_INT_FIELDS,
  ...Object.keys(ENUM_FIELDS),
];

const isBlank = (value) =>
  value === undefined || value === null || value === "";

/**
 * "HH:MM" or "HH:MM:SS" -> minutes since midnight, else null.
 *
 * Whole minutes only: a non-zero seconds component is rejected rather than
 * truncated, because truncating would quietly change a computed duration.
 */
function parseTimeToMinutes(value) {
  if (isBlank(value)) return null;

  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value).trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || seconds !== 0) return null;

  return hours * 60 + minutes;
}

/** Minutes since midnight -> the "HH:MM:SS" MySQL stores in a TIME column. */
function formatMinutesToTime(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const normalized = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(normalized / 60)).padStart(2, "0");
  const mm = String(normalized % 60).padStart(2, "0");
  return `${hh}:${mm}:00`;
}

/** True when the shift ends on the calendar day after it starts. */
function crossesMidnight(inMinutes, outMinutes) {
  if (inMinutes === null || outMinutes === null) return false;
  return outMinutes < inMinutes;
}

/**
 * Clock-to-clock length of a shift, in minutes, break included.
 *
 * An out time earlier than the in time is the next day: 22:00 -> 06:00 is 480
 * minutes, not -960. Equal times are 0, and callers reject that for a working
 * day rather than guessing at a 24-hour shift.
 */
function shiftSpanMinutes(inMinutes, outMinutes) {
  if (inMinutes === null || outMinutes === null) return null;
  if (outMinutes === inMinutes) return 0;
  return outMinutes > inMinutes
    ? outMinutes - inMinutes
    : outMinutes + MINUTES_PER_DAY - inMinutes;
}

/**
 * out_time - in_time - break_minutes. May come back negative; the caller is
 * expected to reject that rather than store it.
 */
function computeNormalWorkMinutes(inTime, outTime, breakMinutes) {
  const span = shiftSpanMinutes(parseTimeToMinutes(inTime), parseTimeToMinutes(outTime));
  if (span === null) return null;
  return span - (Number(breakMinutes) || 0);
}

/**
 * Strict integer coercion.
 *
 * Deliberately not `Number(value)`: that turns null, false and [] into 0, which
 * would let `day_of_week: null` through as Sunday and a null minute count
 * through as zero. Only a real number or a string of digits counts.
 */
function toInteger(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Strict finite-number coercion, for the same reason as `toInteger`. */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseNonNegativeInt(value) {
  if (isBlank(value)) return null;
  const num = toInteger(value);
  if (num === null || num < 0) return null;
  return num;
}

function toTinyInt(value) {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return null;
}

/**
 * Validate and normalize one weekly-schedule row.
 *
 * @returns {{errors: string[], value: object|null}} `value` is the row as it
 *   should be written, with `normal_work_minutes` computed by us.
 */
function validateWeeklyScheduleRow(row) {
  const errors = [];
  if (!row || typeof row !== "object") {
    return { errors: ["Row must be an object"], value: null };
  }

  const dayOfWeek = toInteger(row.day_of_week);
  if (dayOfWeek === null || dayOfWeek < 0 || dayOfWeek > 6) {
    errors.push(
      `day_of_week must be an integer 0-6 (0=Sunday..6=Saturday), got ${JSON.stringify(row.day_of_week)}`
    );
  }
  const dayLabel = DAY_OF_WEEK_LABELS[dayOfWeek] || `day ${row.day_of_week}`;

  const isWorkingDay =
    row.is_working_day === undefined ? 1 : toTinyInt(row.is_working_day);
  if (isWorkingDay === null) {
    errors.push(`${dayLabel}: is_working_day must be true or false`);
  }

  const breakMinutes =
    row.break_minutes === undefined ? 0 : parseNonNegativeInt(row.break_minutes);
  if (breakMinutes === null) {
    errors.push(`${dayLabel}: break_minutes must be an integer of 0 or more`);
  }

  const otRate = row.ot_rate === undefined ? 1 : toNumber(row.ot_rate);
  if (otRate === null || !OT_RATES.includes(otRate)) {
    errors.push(
      `${dayLabel}: ot_rate must be one of ${OT_RATES.join(", ")}, got ${JSON.stringify(row.ot_rate)}`
    );
  }

  let cutoff = null;
  if (!isBlank(row.attendance_day_cutoff)) {
    const cutoffMinutes = parseTimeToMinutes(row.attendance_day_cutoff);
    if (cutoffMinutes === null) {
      errors.push(
        `${dayLabel}: attendance_day_cutoff must be a time of day as HH:MM or HH:MM:SS, got ${JSON.stringify(row.attendance_day_cutoff)}`
      );
    } else {
      cutoff = formatMinutesToTime(cutoffMinutes);
    }
  }

  const inMinutes = parseTimeToMinutes(row.in_time);
  const outMinutes = parseTimeToMinutes(row.out_time);
  let normalWorkMinutes = 0;

  if (isWorkingDay === 1) {
    if (isBlank(row.in_time) || isBlank(row.out_time)) {
      errors.push(`${dayLabel}: in_time and out_time are required on a working day`);
    } else {
      if (inMinutes === null) {
        errors.push(
          `${dayLabel}: in_time must be a time of day as HH:MM or HH:MM:SS, got ${JSON.stringify(row.in_time)}`
        );
      }
      if (outMinutes === null) {
        errors.push(
          `${dayLabel}: out_time must be a time of day as HH:MM or HH:MM:SS, got ${JSON.stringify(row.out_time)}`
        );
      }
    }

    if (inMinutes !== null && outMinutes !== null && breakMinutes !== null) {
      const span = shiftSpanMinutes(inMinutes, outMinutes);
      if (span === 0) {
        errors.push(`${dayLabel}: in_time and out_time are the same, so the shift is 0 minutes long`);
      } else if (span - breakMinutes < 0) {
        errors.push(
          `${dayLabel}: break_minutes (${breakMinutes}) is longer than the ${span} minute shift, which would leave negative working minutes`
        );
      } else {
        normalWorkMinutes = span - breakMinutes;
      }
    }
  } else if (!isBlank(row.in_time) || !isBlank(row.out_time)) {
    // A rest day may still carry times - harmless, and it lets the frontend
    // toggle a day off and back on without losing what was typed - but it
    // never has normal working minutes.
    if (!isBlank(row.in_time) && inMinutes === null) {
      errors.push(
        `${dayLabel}: in_time must be a time of day as HH:MM or HH:MM:SS, got ${JSON.stringify(row.in_time)}`
      );
    }
    if (!isBlank(row.out_time) && outMinutes === null) {
      errors.push(
        `${dayLabel}: out_time must be a time of day as HH:MM or HH:MM:SS, got ${JSON.stringify(row.out_time)}`
      );
    }
  }

  // The backend's own figure wins. A caller that sent a different one is told
  // so rather than having its number silently replaced.
  if (!isBlank(row.normal_work_minutes)) {
    const supplied = parseNonNegativeInt(row.normal_work_minutes);
    if (supplied === null) {
      errors.push(`${dayLabel}: normal_work_minutes must be an integer of 0 or more`);
    } else if (errors.length === 0 && supplied !== normalWorkMinutes) {
      errors.push(
        `${dayLabel}: normal_work_minutes was sent as ${supplied} but works out to ${normalWorkMinutes} from in_time, out_time and break_minutes`
      );
    }
  }

  if (errors.length > 0) return { errors, value: null };

  return {
    errors,
    value: {
      day_of_week: dayOfWeek,
      is_working_day: isWorkingDay,
      in_time: inMinutes === null ? null : formatMinutesToTime(inMinutes),
      out_time: outMinutes === null ? null : formatMinutesToTime(outMinutes),
      attendance_day_cutoff: cutoff,
      break_minutes: breakMinutes,
      normal_work_minutes: normalWorkMinutes,
      ot_rate: otRate,
    },
  };
}

/**
 * Validate a whole weekly schedule: every row valid, and at most one row per
 * weekday for the shift.
 *
 * @returns {{errors: string[], value: object[]|null}}
 */
function validateWeeklySchedule(rows) {
  if (!Array.isArray(rows)) {
    return { errors: ["weekly_schedule must be an array"], value: null };
  }

  const errors = [];
  const value = [];
  const seenDays = new Map();

  rows.forEach((row) => {
    const result = validateWeeklyScheduleRow(row);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      return;
    }

    const day = result.value.day_of_week;
    if (seenDays.has(day)) {
      errors.push(
        `${DAY_OF_WEEK_LABELS[day]}: appears more than once - a shift may have only one row per weekday`
      );
      return;
    }
    seenDays.set(day, true);
    value.push(result.value);
  });

  if (errors.length > 0) return { errors, value: null };
  return { errors, value };
}

/**
 * Validate and normalize a shift_master configuration payload.
 *
 * Only keys the caller actually sent come back, so this is safe for a partial
 * update. Legacy `shift_in_time` / `shift_out_time` / `status` are accepted and
 * folded onto their new names; unknown keys are ignored rather than written.
 *
 * @returns {{errors: string[], value: object|null}}
 */
function validateShiftConfig(payload) {
  if (!payload || typeof payload !== "object") {
    return { errors: ["Shift details must be an object"], value: null };
  }

  const errors = [];
  const input = {};

  Object.keys(payload).forEach((key) => {
    const canonical = LEGACY_FIELD_ALIASES[key] || key;
    if (!SHIFT_CONFIG_FIELDS.includes(canonical)) return;
    // An explicit new-name value beats the legacy alias for the same column.
    if (canonical !== key && payload[canonical] !== undefined) return;
    input[canonical] = payload[key];
  });

  const value = {};

  if (input.shift_name !== undefined) {
    const name = String(input.shift_name).trim();
    if (name === "" || name.length > 150) {
      errors.push("shift_name must be between 1 and 150 characters");
    } else {
      value.shift_name = name;
    }
  }

  if (input.shift_code !== undefined) {
    if (isBlank(input.shift_code)) {
      value.shift_code = null;
    } else {
      const code = String(input.shift_code).trim();
      if (code.length > 20) {
        errors.push("shift_code must be 20 characters or fewer");
      } else {
        value.shift_code = code;
      }
    }
  }

  TIME_FIELDS.forEach((field) => {
    if (input[field] === undefined) return;
    if (isBlank(input[field])) {
      value[field] = null;
      return;
    }
    const minutes = parseTimeToMinutes(input[field]);
    if (minutes === null) {
      errors.push(`${field} must be a time of day as HH:MM or HH:MM:SS`);
    } else {
      value[field] = formatMinutesToTime(minutes);
    }
  });

  BOOLEAN_FIELDS.forEach((field) => {
    if (input[field] === undefined) return;
    const flag = toTinyInt(input[field]);
    if (flag === null) {
      errors.push(`${field} must be true or false`);
    } else {
      value[field] = flag;
    }
  });

  NON_NEGATIVE_INT_FIELDS.forEach((field) => {
    if (input[field] === undefined) return;
    const num = parseNonNegativeInt(input[field]);
    if (num === null) {
      errors.push(`${field} must be an integer of 0 or more`);
    } else {
      value[field] = num;
    }
  });

  NULLABLE_NON_NEGATIVE_INT_FIELDS.forEach((field) => {
    if (input[field] === undefined) return;
    if (isBlank(input[field])) {
      value[field] = null;
      return;
    }
    const num = parseNonNegativeInt(input[field]);
    if (num === null) {
      errors.push(`${field} must be an integer of 0 or more, or empty for no limit`);
    } else {
      value[field] = num;
    }
  });

  Object.keys(ENUM_FIELDS).forEach((field) => {
    if (input[field] === undefined) return;
    const allowed = ENUM_FIELDS[field];
    const candidate = String(input[field]).trim().toUpperCase();
    if (!allowed.includes(candidate)) {
      errors.push(`${field} must be one of ${allowed.join(", ")}`);
    } else {
      value[field] = candidate;
    }
  });

  if (input.paid_hours !== undefined) {
    if (isBlank(input.paid_hours)) {
      value.paid_hours = null;
    } else {
      const hours = toNumber(input.paid_hours);
      if (hours === null || hours < 0 || hours > 24) {
        errors.push("paid_hours must be a number between 0 and 24, or empty");
      } else {
        value.paid_hours = hours;
      }
    }
  }

  // Derived rather than asked for, unless the caller was explicit about it.
  if (
    value.crosses_midnight === undefined &&
    value.start_time !== undefined &&
    value.end_time !== undefined &&
    value.start_time !== null &&
    value.end_time !== null
  ) {
    value.crosses_midnight = crossesMidnight(
      parseTimeToMinutes(value.start_time),
      parseTimeToMinutes(value.end_time)
    )
      ? 1
      : 0;
  }

  if (errors.length > 0) return { errors, value: null };
  return { errors, value };
}

/**
 * Mirror the three renamed columns back onto their originals.
 *
 * Phase 1 renamed `shift_in_time` / `shift_out_time` / `status` but did not
 * drop them, because the live web app still reads all three. Every write
 * therefore sets both spellings so the two can never drift apart.
 * repository/shift.js is the only writer of shift_master, so doing it here is
 * enough - no trigger, no generated column. Delete this, and the legacy
 * columns, once the frontend reads the new names.
 */
function withLegacyColumns(config) {
  const row = { ...config };
  if (row.start_time !== undefined) row.shift_in_time = row.start_time;
  if (row.end_time !== undefined) row.shift_out_time = row.end_time;
  if (row.active !== undefined) row.status = row.active;
  return row;
}

module.exports = {
  MINUTES_PER_DAY,
  DAY_OF_WEEK_LABELS,
  OT_RATES,
  ROUNDING_METHODS,
  MISSED_CLOCK_IN_TREATMENTS,
  REGULARIZATION_CONTROLS,
  LEGACY_FIELD_ALIASES,
  SHIFT_CONFIG_FIELDS,
  parseTimeToMinutes,
  formatMinutesToTime,
  crossesMidnight,
  shiftSpanMinutes,
  computeNormalWorkMinutes,
  validateWeeklyScheduleRow,
  validateWeeklySchedule,
  validateShiftConfig,
  withLegacyColumns,
};
