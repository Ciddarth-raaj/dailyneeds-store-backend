const { istToday } = require("../utils/istDate");
const {
  resolveAssignmentForDate,
  affectedRangeForNewAssignment,
  monthProbesForRange,
  toDateOnly,
} = require("../utils/shiftResolution");
const { payrollLockedActionError } = require("../utils/attendance_payroll_lock");

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
  return istToday(override);
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
    /**
     * Punch RE-DERIVATION, set by `server.js` after both exist.
     *
     * Assigning a shift is the moment a NO_SHIFT punch becomes datable.
     * Without this, the punch keeps its ingest-time status for ever: the
     * Punch Audit goes on reporting "No Shift" for somebody who plainly has
     * one, and Recalculate - which only rewrites `attendance_calculation` -
     * cannot clear it either. Optional; a caller that wires nothing simply
     * assigns, exactly as before.
     */
    this.punchRedriveService = null;
    /**
     * The attendance calculation usecase and its repository, wired by
     * `server.js` after all three exist. Optional: without them an
     * effective-dated shift change still records history, and simply reports
     * that the affected dates must be recalculated by hand - which is exactly
     * what `correctAssignment` has always done.
     */
    this.attendanceCalculationUsecase = null;
    this.attendanceCalculationRepo = null;
  }

  setPunchRedriveService(service) {
    this.punchRedriveService = service || null;
  }

  setAttendanceCalculation(usecase, repo) {
    this.attendanceCalculationUsecase = usecase || null;
    this.attendanceCalculationRepo = repo || null;
  }

  /**
   * The FRIENDLY pre-flight: refuse early, in a sentence naming the month.
   *
   * IT IS NOT THE BOUNDARY, and nothing here should be read as though it
   * were. It holds no lock, so a month can close between its answer and the
   * write. The boundary is `assertMonthsNotPayrollLocked` inside the write
   * transaction (`repository/employee_work_shift.js#changeAssignment`),
   * which takes `FOR UPDATE` on the same rows `approveAndLock` locks. This
   * exists so the common case fails with a readable message instead of an
   * exception from the depths of a transaction.
   *
   * It asks about the dates the change ACTUALLY moves - the same range the
   * transaction computes - so it cannot refuse a backdated row over a month
   * that a later assignment already governs.
   */
  async _preflightUnlocked(employeeId, range, action) {
    if (!this.attendanceCalculationRepo || !range) return;
    const locked = await this.attendanceCalculationRepo.findPayrollLockedPeriods(
      monthProbesForRange({ employeeId, from: range.from, to: range.to })
    );
    if (locked.length > 0) throw payrollLockedActionError(locked, action);
  }


  /** Never let re-derivation fail an assignment that has already committed. */
  async _redrive(employeeIds) {
    if (!this.punchRedriveService || typeof this.punchRedriveService.redriveUndated !== "function") {
      return null;
    }
    try {
      return await this.punchRedriveService.redriveUndated({ employeeIds });
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
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

    // The punches these employees already have that could not be dated for
    // want of a shift are datable now.
    const punchRedrive = await this._redrive(employeeIds);

    return {
      ...result,
      shift_code: shift.shift_code,
      shift_name: shift.shift_name,
      punch_redrive: punchRedrive,
    };
  }

  /**
   * EDIT SHIFT ASSIGNMENT - the employee's PERMANENT shift, from a date.
   *
   * WHAT IT IS, AND WHY IT IS A THIRD PATH. `assign` moves somebody to a new
   * shift TODAY and has no date field, which is right for the bulk roster
   * screen and useless for "she moves to the evening shift from the 1st".
   * `correctAssignment` says a past record was WRONG, which is a different
   * assertion and carries a different word on the row. This one says the
   * roster CHANGES from a stated date - the date may be in the past, today,
   * or in the future - and it is the flow the approved task describes.
   *
   * THE RESULT, stated exactly:
   *
   *     effective_from = 01/09     01-14 Sep resolve to the NEW shift
   *     ... and a later row dated 15/09 makes 01-14 the old one and 15
   *     onwards the new one. NOTHING BEFORE THE EFFECTIVE DATE MOVES, because
   *     resolution reads the greatest `effective_from <= date` and this
   *     appends rather than editing.
   *
   * NO HISTORY IS OVERWRITTEN OR DELETED. Ever. A further row is appended and
   * the previous rows stay exactly as they were, which is what makes the
   * history panel an audit trail rather than a current-value display.
   *
   * THE PAYROLL LOCK IS CHECKED HERE **AND** AT THE WRITE. Here, so the save
   * is refused with a sentence naming the locked month instead of appearing
   * to work; and at the write, inside the transaction and under a row lock,
   * because that is the guard a race cannot get past. A backdate into an open
   * month is allowed exactly as the task specifies.
   *
   * RECALCULATION IS AUTOMATIC AND BOUNDED. Unlike `correctAssignment`, which
   * deliberately leaves the re-run to a human, a shift change recalculates
   * from the effective date to today - those are precisely the dates whose
   * NRM, shortage and overtime have just changed, and leaving them stale
   * would leave the screens disagreeing with the history. A future-dated
   * change recalculates nothing: there is nothing yet to recalculate.
   */
  async changeAssignment(payload = {}) {
    const employeeId = Number(payload.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }

    const workShiftId = Number(payload.work_shift_id);
    if (!Number.isInteger(workShiftId) || workShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }

    const effectiveFrom = toDateOnly(payload.effective_from);
    if (effectiveFrom === null) {
      throw validationError(
        "effective_from is required and must be a date as YYYY-MM-DD - a shift change must say which date it applies from"
      );
    }

    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (reason.length < 5) {
      throw validationError("A reason of at least 5 characters is required");
    }

    const existing = await this.repo.findExistingEmployeeIds([employeeId]);
    if (!existing || existing.length === 0) {
      return { code: 422, msg: `No employee exists for id ${employeeId}` };
    }

    const shift = await this.repo.getActiveWorkShift(workShiftId);
    if (!shift) return { code: 404, msg: "Work shift not found" };
    if (!Number(shift.active)) {
      return { code: 422, msg: "That work shift is inactive and cannot be assigned" };
    }

    // The shift being moved AWAY from, as the resolver sees it on the
    // effective date - recorded on the response so the screen can state the
    // change rather than only its destination.
    const history = await this.repo.listAssignmentHistory(employeeId);
    const previous = resolveAssignmentForDate(history, effectiveFrom);
    if (previous && Number(previous.work_shift_id) === workShiftId) {
      return {
        code: 422,
        msg: `That employee is already on ${shift.shift_code || shift.shift_name} from ${effectiveFrom}`,
      };
    }

    const today = istToday(payload.today);

    /*
     * A FUTURE EFFECTIVE DATE IS REFUSED, and this is a deliberate scope
     * decision rather than an oversight.
     *
     * The dated history alone would resolve a future date correctly - the
     * attendance engine reads it per date and would pick the new shift up
     * when the date arrived. But `new_employee.default_work_shift_id` is
     * still read as CURRENT STATE by the employee list, the profile, the
     * assignment screen and Add Employee, and NOTHING in this system moves
     * that column on a date: there is no scheduled reconciliation, no job
     * and no trigger. A future-dated change would therefore sit correct in
     * the history and wrong in the column from the day it took effect until
     * somebody happened to save something.
     *
     * Building a scheduler for it was not part of this work, so the feature
     * refuses what it cannot honour. A change is filed on the day it takes
     * effect, or backdated afterwards - both of which this path does
     * correctly and immediately.
     */
    if (effectiveFrom > today) {
      throw validationError(
        `effective_from cannot be in the future - file the change on the day it takes effect. ${effectiveFrom} is after ${today}.`
      );
    }

    // The dates this row will actually move, for the pre-flight message. The
    // transaction computes it again, under a lock, and that one is the rule.
    const affected = affectedRangeForNewAssignment({ assignments: history, effectiveFrom, today });
    await this._preflightUnlocked(employeeId, affected, "This shift change");

    /*
     * THE WRITE. Inside its own transaction it re-reads and locks the
     * history, takes the payroll lock on the months the change really
     * touches, inserts, and reconciles `default_work_shift_id` to the
     * RESOLVER's answer for today - which is not necessarily the shift just
     * inserted, because a later assignment may already govern today.
     */
    const result = await this.repo.changeAssignment({
      employeeId,
      workShiftId,
      effectiveFrom,
      note: reason,
      createdBy: payload.actor_employee_id === undefined ? null : payload.actor_employee_id,
      today,
    });

    const punchRedrive = await this._redrive([employeeId]);

    // Recalculate exactly the dates this moved - the transaction's own
    // answer, which stops at the day a later assignment takes over.
    const range = {
      from: result.affected_from || affected.from,
      to: result.affected_to || affected.to,
    };
    let recalculated = null;
    let recalculationError = null;
    if (this.attendanceCalculationUsecase) {
      try {
        recalculated = await this.attendanceCalculationUsecase.recalculateRange({
          employee_id: employeeId,
          from_date: range.from,
          to_date: range.to,
        });
      } catch (err) {
        recalculationError = err && err.message ? err.message : String(err);
      }
    } else {
      recalculationError = "No attendance calculation service is wired";
    }

    const shiftName = shift.shift_code || shift.shift_name;
    const common = {
      ...result,
      shift_code: shift.shift_code,
      shift_name: shift.shift_name,
      previous_work_shift_id: previous ? Number(previous.work_shift_id) : null,
      reason,
      effective_from: effectiveFrom,
      is_future_dated: false,
      punch_redrive: punchRedrive,
      // The range a retry must re-run. Returned on success too, so the caller
      // never has to re-derive it.
      recalculation_range: range,
    };

    /*
     * A FAILED RECALCULATION IS NOT A SUCCESS, and must not be reported as
     * one.
     *
     * The assignment is committed and correct - rolling it back would mean
     * undoing a transaction that has already returned - but the attendance
     * behind it is now STALE: it still carries the old shift's NRM, its
     * shortage and its overtime for dates that no longer resolve to that
     * shift. Payroll reads those rows. So the caller is told, in a state it
     * cannot mistake for completion, and is given the exact range to retry.
     */
    if (recalculationError !== null) {
      return {
        ...common,
        code: 207,
        partial: true,
        recalculation_failed: true,
        recalculated: null,
        recalculation_error: recalculationError,
        msg:
          `The shift change was SAVED (${shiftName} from ${effectiveFrom}), but attendance for ` +
          `${range.from} to ${range.to} could NOT be recalculated and is still calculated under the ` +
          `old shift. Re-run the recalculation for that range before this month is processed.`,
      };
    }

    return {
      ...common,
      code: 200,
      partial: false,
      recalculation_failed: false,
      recalculated,
      msg:
        `Recorded. ${shiftName} applies from ${effectiveFrom}; attendance for ${range.from} to ` +
        `${range.to} has been recalculated and nothing before it is affected.`,
    };
  }

  /**
   * SHIFT HISTORY for one employee: every dated row, newest first.
   *
   * `is_current` is the RESOLVER's answer for today, not a column and not the
   * first row: a future-dated change sits at the top of the list and is
   * explicitly NOT current, which is precisely the thing a reader would
   * otherwise get wrong.
   */
  async assignmentHistory(employeeId, { today = null } = {}) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
      throw validationError("employee_id must be an employee id");
    }

    const rows = await this.repo.listAssignmentHistory(id);
    const businessToday = istToday(today);
    const current = resolveAssignmentForDate(rows, businessToday);
    const currentId = current ? Number(current.employee_work_shift_assignment_id) : null;

    return {
      code: 200,
      employee_id: id,
      data: rows.map((row) => {
        const rowId = Number(row.employee_work_shift_assignment_id);
        const effectiveFrom = toDateOnly(row.effective_from);
        return {
          employee_work_shift_assignment_id: rowId,
          effective_from: effectiveFrom,
          work_shift_id: Number(row.work_shift_id),
          shift_code: row.shift_code || null,
          shift_name: row.shift_name || null,
          work_shift_active:
            row.work_shift_active === null || row.work_shift_active === undefined
              ? null
              : Boolean(Number(row.work_shift_active)),
          source: row.source,
          reason: row.note || null,
          changed_by_employee_id: row.created_by === null ? null : Number(row.created_by),
          changed_by_name: row.changed_by_name || null,
          changed_at: row.created_at,
          is_current: currentId !== null && rowId === currentId,
          is_future_dated: effectiveFrom !== null && effectiveFrom > businessToday,
        };
      }),
    };
  }

  /**
   * Correct which work shift an employee was on for a HISTORICAL date.
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT THE ASSIGN ROUTE. `assign` above dates
   * every change TODAY and has no field for any other date, which is right:
   * moving somebody to a new shift must never rewrite yesterday's worked
   * minutes. But the append-only resolver explicitly supports a correction
   * dated to the same day as the row it corrects, and a genuine historical
   * mistake - somebody was recorded on the wrong shift for a fortnight - has
   * to be fixable by an authorized person rather than by a DBA.
   *
   * WHAT MAKES IT SAFE:
   *
   *   - Its own permission, `correct_employee_shift_assignment`, granted by a
   *     migration to NOBODY. Correcting the past changes payroll-consumed
   *     history.
   *   - An EXPLICIT `effective_from`. There is no default and no "today"
   *     fallback: a correction that does not say which date it corrects is
   *     refused, so nothing can be backdated by accident.
   *   - A mandatory note, recorded on the row, saying why.
   *   - `source = 'CORRECTION'`, so a correction is distinguishable from an
   *     ordinary assignment forever after.
   *   - ONE employee at a time. A bulk backdate is not a correction, it is an
   *     accident waiting to happen.
   *   - `default_work_shift_id` is NOT touched. Correcting September says
   *     nothing about what somebody is rostered on today.
   *
   * The affected dates are NOT recalculated here. What a correction changes is
   * potentially a month of settled attendance, and re-running it is a separate,
   * deliberate act through the recalculation endpoint by somebody who holds
   * that key - not a side effect of filing the correction.
   */
  async correctAssignment(payload = {}) {
    const employeeId = Number(payload.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }

    const workShiftId = Number(payload.work_shift_id);
    if (!Number.isInteger(workShiftId) || workShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }

    const effectiveFrom =
      typeof payload.effective_from === "string" ? payload.effective_from.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw validationError(
        "effective_from is required and must be a date as YYYY-MM-DD - a correction must say which date it corrects"
      );
    }

    const note = typeof payload.note === "string" ? payload.note.trim() : "";
    if (note.length < 10) {
      throw validationError(
        "A note of at least 10 characters is required: a correction to historical attendance has to say why"
      );
    }

    // A correction may be dated into the past. It may NOT be dated into the
    // future: an assignment that has not happened yet is an assignment, and it
    // goes through the ordinary route on the day it takes effect.
    if (effectiveFrom > istToday(payload.today)) {
      throw validationError("effective_from cannot be in the future - this path corrects the past");
    }

    const existing = await this.repo.findExistingEmployeeIds([employeeId]);
    if (!existing || existing.length === 0) {
      return { code: 422, msg: `No employee exists for id ${employeeId}` };
    }

    const shift = await this.repo.getActiveWorkShift(workShiftId);
    if (!shift) return { code: 404, msg: "Work shift not found" };
    // An INACTIVE shift is allowed here, unlike on the assign route: the
    // correction records what was true then, and a shift that has since been
    // retired is exactly the kind of thing a correction is for.

    const result = await this.repo.correctAssignment({
      employeeId,
      workShiftId,
      effectiveFrom,
      note,
      createdBy: payload.actor_employee_id === undefined ? null : payload.actor_employee_id,
    });

    const punchRedrive = await this._redrive([employeeId]);

    return {
      ...result,
      shift_code: shift.shift_code,
      shift_name: shift.shift_name,
      note,
      punch_redrive: punchRedrive,
      recalculation_required: true,
      msg: "Correction recorded. Attendance for the affected dates is NOT recalculated automatically - run a recalculation for the range when you are ready.",
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
