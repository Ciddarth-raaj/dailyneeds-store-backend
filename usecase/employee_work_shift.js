const {
  ASSIGNMENT_STATUS,
  EMPLOYMENT_STATUS,
} = require("../repository/employee_work_shift");

/**
 * Employee -> Work Shift assignment.
 *
 * The rules that decide whether a bulk assignment is allowed to happen live
 * here rather than in the route, so they can be tested without a database and
 * without Express - the same reason `usecase/work_shift.js` holds the shift
 * validation rather than `routes/work_shift.js`.
 *
 * ALL OR NOTHING. Every selected employee is checked to exist and the target
 * work shift is checked to exist and be active BEFORE anything is written; if
 * any check fails, nothing is written and the response names exactly what was
 * wrong. A partial write is the worse outcome here: HR would have no way to
 * tell which half of a 200-person selection landed, and the screen's own
 * counts would be a lie.
 *
 * NOTHING IS INFERRED. There is no "assign the obvious one" path, no matching
 * on shift code or name, and no default. The only way a work shift reaches an
 * employee is a person choosing it and confirming.
 */

/** Shaped so `utils/http.js#respondError` answers 400 with the detail. */
function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** The most an assignment may touch in one request. */
const MAX_EMPLOYEES_PER_ASSIGNMENT = 1000;

/**
 * Today's date in IST, as `YYYY-MM-DD`, for the A0 assignment history.
 *
 * IST and not the process zone: the business day this assignment belongs to is
 * the Indian one, and a server running in UTC would otherwise date every
 * evening assignment to the day before. The offset is applied to the epoch and
 * the date read back in UTC, so no local `Date` is constructed and the answer
 * does not depend on where the process runs.
 *
 * `override` exists so tests can pin the day; it is not a caller-supplied
 * field on any route.
 */
function effectiveFromToday(override = null) {
  if (typeof override === "string" && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const IST_OFFSET_MINUTES = 5 * 60 + 30;
  const ist = new Date(Date.now() + IST_OFFSET_MINUTES * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(
    ist.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * Employee ids as a clean, deduplicated list of positive integers.
 *
 * Order is preserved so an error message reads in the order the caller sent
 * them. `"12"` and `12` are the same employee - the frontend sends whatever a
 * checkbox value happens to be - and must not count twice.
 */
function normalizeEmployeeIds(raw) {
  if (!Array.isArray(raw)) {
    throw validationError("employee_ids must be an array of employee ids");
  }
  if (raw.length === 0) {
    throw validationError("Select at least one employee");
  }

  const seen = new Set();
  const ids = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw validationError(`'${value}' is not a valid employee id`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length > MAX_EMPLOYEES_PER_ASSIGNMENT) {
    throw validationError(
      `Too many employees in one assignment - the limit is ${MAX_EMPLOYEES_PER_ASSIGNMENT}`
    );
  }

  return ids;
}

/** One of the three, upper-cased; anything else is a caller error, not a default. */
function normalizeChoice(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const choice = String(value).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(allowed, choice)) {
    throw validationError(`${label} must be one of ${Object.keys(allowed).join(", ")}`);
  }
  return choice;
}

/** A comma list or a repeated query parameter, either way a list of ids. */
function normalizeIdList(value, label) {
  if (value === undefined || value === null || value === "") return [];
  const parts = Array.isArray(value) ? value : String(value).split(",");
  const ids = [];
  for (const part of parts) {
    const trimmed = String(part).trim();
    if (trimmed === "") continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      throw validationError(`'${trimmed}' is not a valid ${label}`);
    }
    ids.push(id);
  }
  return ids;
}

/**
 * A TIME column as "09:00".
 *
 * MySQL hands a TIME back as "09:00:00" through this driver, but a duration
 * of more than a day comes back differently and a null comes back null, so
 * this is defensive rather than decorative: anything it does not recognise is
 * returned untouched instead of being sliced into nonsense.
 */
function formatTime(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const match = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!match) return text;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/**
 * The one-line timing a profile can print.
 *
 * A work shift's hours are configured per weekday, so there is not always one
 * answer. Where every working day runs the same hours - which is the common
 * case - that is the answer. Where they differ, saying so is honest and
 * naming one day's hours as "the" timing would not be. A shift with no
 * working days configured has no timing to state at all.
 */
function describeTiming(timings) {
  if (!Array.isArray(timings) || timings.length === 0) return null;
  if (timings.length === 1) {
    const only = timings[0];
    if (!only.in_time || !only.out_time) return null;
    return `${only.in_time} - ${only.out_time}`;
  }
  return "Varies by day";
}

class EmployeeWorkShiftUsecase {
  constructor(employeeWorkShiftRepo) {
    this.repo = employeeWorkShiftRepo;
  }

  /**
   * The assignment screen's list.
   *
   * Active employees by default, matching the HR employee list's own default
   * - the people HR is assigning shifts to are the people who work here. The
   * other two options are explicit, so nobody is included or excluded without
   * having asked for it.
   */
  async list(query = {}) {
    const filters = {
      store_ids: normalizeIdList(query.store_ids, "outlet id"),
      department_ids: normalizeIdList(query.department_ids, "department id"),
      designation_ids: normalizeIdList(query.designation_ids, "designation id"),
      assignment_status: normalizeChoice(
        query.assignment_status,
        ASSIGNMENT_STATUS,
        ASSIGNMENT_STATUS.ALL,
        "assignment_status"
      ),
      employment_status: normalizeChoice(
        query.employment_status,
        EMPLOYMENT_STATUS,
        EMPLOYMENT_STATUS.ACTIVE,
        "employment_status"
      ),
      search: typeof query.search === "string" ? query.search : "",
      actor: query.actor || null,
    };

    const rows = await this.repo.listForAssignment(filters);
    return {
      code: 200,
      data: rows.map((row) => ({
        employee_id: Number(row.employee_id),
        employee_name: row.employee_name,
        status: row.status === null || row.status === undefined ? null : Number(row.status),
        store_id: row.store_id === null ? null : Number(row.store_id),
        outlet_name: row.outlet_name || null,
        department_id: row.department_id === null ? null : Number(row.department_id),
        department_name: row.department_name || null,
        designation_id: row.designation_id === null ? null : Number(row.designation_id),
        designation_name: row.designation_name || null,
        default_work_shift_id:
          row.default_work_shift_id === null || row.default_work_shift_id === undefined
            ? null
            : Number(row.default_work_shift_id),
        work_shift_code: row.work_shift_code || null,
        work_shift_name: row.work_shift_name || null,
        // A shift can be deactivated after it was assigned. The screen shows
        // the assignment as it is rather than pretending it is unassigned.
        work_shift_active:
          row.work_shift_active === null || row.work_shift_active === undefined
            ? null
            : Boolean(Number(row.work_shift_active)),
      })),
    };
  }

  /**
   * ONE employee's current work shift, as the employee profile shows it.
   *
   * READ-ONLY, and that is the point of it existing separately from the
   * assignment screen. The profile has to be able to answer "which shift is
   * this person on" without offering to change it - a shift change is a
   * roster decision with attendance and payroll behind it, and it belongs on
   * the screen built for it.
   *
   * IT READS THE NEW MAPPING ONLY - `default_work_shift_id` - and never the
   * legacy columns behind `shift_master`. An employee nobody has assigned yet
   * comes back with `assigned: false` rather than a fabricated shift, because
   * "unassigned" is exactly what HR needs to see in order to fix it.
   *
   * `timing` is a plain string because it is display, not data: a shift whose
   * weekdays all run the same hours gets those hours, and one that varies by
   * day says so instead of picking a day to speak for the rest.
   */
  async currentForEmployee(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
      throw validationError("employee_id must be an employee id");
    }

    const row = await this.repo.getEmployeeWorkShift(id);
    if (!row) return { code: 404, msg: "Employee not found" };

    const workShiftId =
      row.default_work_shift_id === null || row.default_work_shift_id === undefined
        ? null
        : Number(row.default_work_shift_id);

    if (workShiftId === null) {
      return {
        code: 200,
        data: {
          employee_id: id,
          assigned: false,
          work_shift_id: null,
          shift_code: null,
          shift_name: null,
          shift_active: null,
          timing: null,
          timings: [],
        },
      };
    }

    const times = await this.repo.getWorkShiftWorkingTimes(workShiftId);
    const timings = (times || []).map((t) => ({
      in_time: formatTime(t.in_time),
      out_time: formatTime(t.out_time),
    }));

    return {
      code: 200,
      data: {
        employee_id: id,
        assigned: true,
        work_shift_id: workShiftId,
        shift_code: row.work_shift_code || null,
        shift_name: row.work_shift_name || null,
        // A shift can be deactivated after it was assigned. The profile shows
        // the assignment as it is rather than pretending it is unassigned.
        shift_active:
          row.work_shift_active === null || row.work_shift_active === undefined
            ? null
            : Boolean(Number(row.work_shift_active)),
        timing: describeTiming(timings),
        timings,
      },
    };
  }

  /**
   * M1. Active shifts for the Employment stage / section dropdown:
   * `[{ work_shift_id, shift_code, shift_name, timing }]`, one row per shift,
   * timing described exactly as the profile describes it.
   */
  async activeOptions() {
    const rows = (await this.repo.listActiveWorkShiftOptions()) || [];
    const byId = new Map();
    for (const row of rows) {
      const id = Number(row.work_shift_id);
      if (!byId.has(id)) {
        byId.set(id, {
          work_shift_id: id,
          shift_code: row.shift_code || null,
          shift_name: row.shift_name || null,
          timings: [],
        });
      }
      if (row.in_time && row.out_time) {
        const t = { in_time: formatTime(row.in_time), out_time: formatTime(row.out_time) };
        const seen = byId.get(id).timings;
        if (!seen.some((x) => x.in_time === t.in_time && x.out_time === t.out_time)) seen.push(t);
      }
    }
    return {
      code: 200,
      data: [...byId.values()].map(({ timings, ...shift }) => ({
        ...shift,
        timing: describeTiming(timings),
      })),
    };
  }

  /**
   * Assign one ACTIVE work shift to the selected employees.
   *
   * Writes `default_work_shift_id` and nothing else on the employee row. There
   * is no unassign here, deliberately: changing somebody's shift means
   * choosing another active one, and clearing the mapping outright is not part
   * of this phase.
   *
   * ATTENDANCE v2 / A0. It now also appends a dated row to
   * `employee_work_shift_assignment`, effective from the date the assignment
   * is made. NOT backdated, ever: moving somebody to a new shift today must
   * not rewrite yesterday's worked minutes. The screen, the permissions and
   * the response are otherwise exactly as they were.
   */
  async assign(payload = {}) {
    const employeeIds = normalizeEmployeeIds(payload.employee_ids);

    const workShiftId = Number(payload.work_shift_id);
    if (!Number.isInteger(workShiftId) || workShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }

    const shift = await this.repo.getActiveWorkShift(workShiftId);
    if (!shift) {
      return { code: 404, msg: "Work shift not found" };
    }
    if (!Number(shift.active)) {
      return { code: 422, msg: "That work shift is inactive and cannot be assigned" };
    }

    const existing = new Set(await this.repo.findExistingEmployeeIds(employeeIds));
    const unknown = employeeIds.filter((id) => !existing.has(id));
    if (unknown.length > 0) {
      // Named rather than skipped: silently dropping ids would report a
      // success for a selection that was never fully applied.
      return {
        code: 422,
        msg: `No employee exists for ${unknown.length === 1 ? "id" : "ids"} ${unknown.join(", ")}`,
        rejected_employee_ids: unknown,
      };
    }

    const result = await this.repo.assignWorkShift(employeeIds, workShiftId, {
      effective_from: effectiveFromToday(payload.today),
      created_by: payload.actor_employee_id === undefined ? null : payload.actor_employee_id,
    });
    if (!result || result.code !== 200) return result;

    return {
      ...result,
      shift_code: shift.shift_code,
      shift_name: shift.shift_name,
    };
  }
}

module.exports = (employeeWorkShiftRepo) => new EmployeeWorkShiftUsecase(employeeWorkShiftRepo);
module.exports.EmployeeWorkShiftUsecase = EmployeeWorkShiftUsecase;
module.exports.normalizeEmployeeIds = normalizeEmployeeIds;
module.exports.normalizeIdList = normalizeIdList;
module.exports.normalizeChoice = normalizeChoice;
module.exports.MAX_EMPLOYEES_PER_ASSIGNMENT = MAX_EMPLOYEES_PER_ASSIGNMENT;
module.exports.effectiveFromToday = effectiveFromToday;
module.exports.formatTime = formatTime;
module.exports.describeTiming = describeTiming;
