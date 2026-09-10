/**
 * Work Shift validation - Phase 1 (payroll foundation).
 *
 * Pure functions only: no database, no Express. The backend is the
 * authoritative validator for a weekly schedule, so `normal_work_minutes` is
 * always recomputed here from in/out/break rather than taken on trust from
 * whatever the caller sent. A caller that sends a value which disagrees with
 * the computed one gets an error naming both numbers, which is how a frontend
 * arithmetic bug surfaces immediately instead of quietly reaching payroll.
 *
 * This is the NEW shift master (`work_shift` + `work_shift_weekly_schedule`).
 * The legacy `shift_master` table and its /shift routes are a separate,
 * untouched system; nothing here reads or writes them.
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

const BOOLEAN_FIELDS = [
  "active",
  "late_exclude_grace_from_deduction",
  "late_offset_against_overtime",
  "early_exit_offset_against_overtime",
  "overtime_allowed",
  "overtime_minimum_threshold_only",
  "pre_shift_overtime_allowed",
  "missed_clock_in_rule_enabled",
  "minimum_hours_rule_enabled",
  "regularization_allowed",
  "regularization_control_enabled",
  "regularization_require_existing_punch",
  "regularization_requires_approval",
];

const NON_NEGATIVE_INT_FIELDS = [
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
};

/**
 * Every `work_shift` field a caller may set, for whitelisting a payload.
 *
 * Note what is absent: no start_time/end_time, no crosses_midnight, no
 * master-level break. Daily timing lives only in the weekly schedule, so
 * there is one authoritative answer to when a shift runs on a given day.
 */
const WORK_SHIFT_CONFIG_FIELDS = [
  "shift_code",
  "shift_name",
  ...BOOLEAN_FIELDS,
  ...NON_NEGATIVE_INT_FIELDS,
  ...NULLABLE_NON_NEGATIVE_INT_FIELDS,
  ...Object.keys(ENUM_FIELDS),
];

const SHIFT_CODE_MAX_LENGTH = 20;
const SHIFT_NAME_MAX_LENGTH = 150;

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

/**
 * True when the shift ends on the calendar day after it starts.
 *
 * Derived, never stored: `attendance_day_cutoff` is a separate concept (which
 * work date a punch is attributed to) and is not the overnight indicator.
 */
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
 * Validate a whole weekly schedule.
 *
 * A saved schedule is always the complete week: exactly seven rows, one for
 * each day 0-6, each explicitly Working or Rest. Six days are not accepted and
 * a missing day is never invented as a rest day - a shift that is only
 * partly defined is exactly the state payroll must never read.
 *
 * @returns {{errors: string[], value: object[]|null}} rows sorted Sunday first
 */
function validateWeeklySchedule(rows) {
  if (!Array.isArray(rows)) {
    return { errors: ["weekly_schedule must be an array"], value: null };
  }

  const errors = [];
  const byDay = new Map();

  rows.forEach((row) => {
    const result = validateWeeklyScheduleRow(row);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      return;
    }

    const day = result.value.day_of_week;
    if (byDay.has(day)) {
      errors.push(
        `${DAY_OF_WEEK_LABELS[day]}: appears more than once - a shift may have only one row per weekday`
      );
      return;
    }
    byDay.set(day, result.value);
  });

  // Reported even when rows also failed individually: a caller that sent five
  // broken days should hear about the two it never sent at all.
  const missing = DAY_OF_WEEK_LABELS.map((label, day) => (byDay.has(day) ? null : label))
    .filter(Boolean);
  if (missing.length > 0) {
    errors.push(
      `weekly_schedule must contain all 7 days, one row each for Sunday..Saturday - missing ${missing.join(", ")}`
    );
  }

  if (errors.length > 0) return { errors, value: null };

  return {
    errors,
    value: DAY_OF_WEEK_LABELS.map((_, day) => byDay.get(day)),
  };
}

/**
 * Cross-field rules that need the shift's whole configuration, not just the
 * keys this request happened to send.
 *
 * `effective` is the row as it will be after the update: the stored row with
 * the validated changes laid over it. That is what makes "enable control in
 * one request, set the limit in another" behave the same as sending both.
 */
function validateConfigCombination(effective) {
  const errors = [];

  if (toTinyInt(effective.regularization_control_enabled) === 1) {
    const limit = effective.regularization_limit_per_month;
    const parsed = isBlank(limit) ? null : parseNonNegativeInt(limit);
    if (parsed === null || parsed < 1) {
      errors.push(
        "regularization_limit_per_month must be at least 1 when regularization_control_enabled is true - it is the number of times per month an employee may regularize"
      );
    }
  }

  return errors;
}

/**
 * Validate and normalize a `work_shift` configuration payload.
 *
 * Only keys the caller actually sent come back, so this is safe for a partial
 * update; unknown keys are ignored rather than written.
 *
 * @param {object} payload the request body
 * @param {{isCreate?: boolean, existing?: object}} options `existing` is the
 *   stored row, used so cross-field rules see the post-update state.
 * @returns {{errors: string[], value: object|null}}
 */
function validateWorkShiftConfig(payload, options = {}) {
  const { isCreate = false, existing = null } = options;

  if (!payload || typeof payload !== "object") {
    return { errors: ["Work shift details must be an object"], value: null };
  }

  const errors = [];
  const input = {};

  Object.keys(payload).forEach((key) => {
    if (!WORK_SHIFT_CONFIG_FIELDS.includes(key)) return;
    input[key] = payload[key];
  });

  const value = {};

  // shift_code is mandatory on create and may never be blanked afterwards:
  // every work shift is entered by hand, so there is no legacy row without
  // one. Uniqueness itself is the DB's job (uq_work_shift_shift_code).
  if (input.shift_code !== undefined || isCreate) {
    if (isBlank(input.shift_code)) {
      errors.push("shift_code is required and cannot be blank");
    } else {
      const code = String(input.shift_code).trim();
      if (code === "") {
        errors.push("shift_code is required and cannot be blank");
      } else if (code.length > SHIFT_CODE_MAX_LENGTH) {
        errors.push(`shift_code must be ${SHIFT_CODE_MAX_LENGTH} characters or fewer`);
      } else {
        value.shift_code = code;
      }
    }
  }

  if (input.shift_name !== undefined || isCreate) {
    const name = isBlank(input.shift_name) ? "" : String(input.shift_name).trim();
    if (name === "" || name.length > SHIFT_NAME_MAX_LENGTH) {
      errors.push(`shift_name is required and must be ${SHIFT_NAME_MAX_LENGTH} characters or fewer`);
    } else {
      value.shift_name = name;
    }
  }

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

  if (errors.length > 0) return { errors, value: null };

  errors.push(...validateConfigCombination({ ...(existing || {}), ...value }));

  if (errors.length > 0) return { errors, value: null };
  return { errors, value };
}

module.exports = {
  MINUTES_PER_DAY,
  DAY_OF_WEEK_LABELS,
  OT_RATES,
  ROUNDING_METHODS,
  MISSED_CLOCK_IN_TREATMENTS,
  WORK_SHIFT_CONFIG_FIELDS,
  parseTimeToMinutes,
  formatMinutesToTime,
  crossesMidnight,
  shiftSpanMinutes,
  computeNormalWorkMinutes,
  validateWeeklyScheduleRow,
  validateWeeklySchedule,
  validateWorkShiftConfig,
};
