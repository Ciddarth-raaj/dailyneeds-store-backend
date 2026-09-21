const {
  validateWorkShiftConfig,
  validateWeeklySchedule,
} = require("../utils/workShift");

/**
 * What the save tells the person who made it, in one sentence.
 *
 * A shift rule change now moves attendance days that were calculated weeks
 * ago, and a silent save would give no sign of it. The two numbers that
 * matter are the days brought up to date and the days deliberately left
 * alone because their payroll month is locked.
 */
function recalculationMessage(recalculation) {
  if (!recalculation || recalculation.skipped) return "Shift updated.";
  if (recalculation.status === "FAILED" && recalculation.error) {
    return `Shift updated, but the attendance recalculation failed: ${recalculation.error}`;
  }
  const recalculated = Number(recalculation.attendance_days_recalculated) || 0;
  const skipped = Number(recalculation.attendance_days_skipped_locked) || 0;
  const base = `Shift updated. ${recalculated} open attendance ${
    recalculated === 1 ? "day" : "days"
  } recalculated. ${skipped} locked ${skipped === 1 ? "day" : "days"} skipped.`;
  return recalculation.errors && recalculation.errors.length > 0
    ? `${base} ${recalculation.errors.length} employee-month(s) could not be recalculated.`
    : base;
}

/**
 * Shaped so utils/http.js `respondError` answers 400 with the detail, the way
 * a Joi failure already does.
 */
function validationError(errors) {
  const err = new Error(errors.join("; "));
  err.name = "ValidationError";
  err.details = errors;
  return err;
}

class WorkShiftUsecase {
  constructor(workShiftRepo) {
    this.workShiftRepo = workShiftRepo;
    this.attendanceRecalculationService = null;
  }

  /**
   * The attendance recalculation a shift save now triggers.
   *
   * INJECTED, exactly as every other cross-usecase call in this codebase is,
   * because `server.js` builds the work shift usecase before the attendance
   * one. Left unwired - in a unit test, or in a deployment that does not run
   * attendance v2 - a save behaves precisely as it did before.
   */
  setAttendanceRecalculationService(service) {
    this.attendanceRecalculationService = service || null;
  }

  /**
   * PROPAGATE THE NEW RULE, after the save has committed.
   *
   * Only when the save actually CHANGED the shift's calculating configuration
   * - which is the same question `appendConfigVersionOnConnection` already
   * answers by appending a version row or not. Renaming a shift recalculates
   * nothing.
   *
   * OUTSIDE THE SAVE'S TRANSACTION, deliberately. The recalculation touches
   * many employees over several months and takes the payroll-row lock per
   * month as it goes; holding the Work Shift write open across all of that
   * would keep row locks on `work_shift` for the duration and make a shift
   * edit block on attendance. The save is committed and durable first, and
   * the recalculation is then reported - including its failures - rather than
   * being allowed to undo it.
   */
  async _propagate(result, { work_shift_id, actor_employee_id }) {
    if (!result || result.code !== 200) return result;
    const changed = result.config_version && result.config_version.appended === true;
    if (!changed) {
      return { ...result, recalculation: { skipped: true, reason: "CONFIGURATION_UNCHANGED" } };
    }
    if (
      !this.attendanceRecalculationService ||
      typeof this.attendanceRecalculationService.recalculateForShiftConfigChange !== "function"
    ) {
      return result;
    }

    let recalculation;
    try {
      recalculation = await this.attendanceRecalculationService.recalculateForShiftConfigChange({
        work_shift_id: work_shift_id || result.work_shift_id,
        actor_employee_id: actor_employee_id === undefined ? null : actor_employee_id,
      });
    } catch (err) {
      // The shift IS saved. A recalculation that fell over is reported as a
      // failure of the recalculation, never as a failure of the save.
      recalculation = { status: "FAILED", error: err && err.message ? err.message : String(err) };
    }

    return { ...result, recalculation, msg: recalculationMessage(recalculation) };
  }

  /**
   * Every work shift, configuration only.
   *
   * `active` is optional and narrows the list. Absent, the answer is what it
   * has always been: every work shift, active and inactive alike.
   */
  async get({ active } = {}) {
    return this.workShiftRepo.get({ active });
  }

  /** A work shift's full configuration plus its 7-day schedule, or null. */
  async getWorkShiftWithSchedule(work_shift_id) {
    return this.workShiftRepo.getWorkShiftWithSchedule(work_shift_id);
  }

  /** Just the weekly schedule rows for a work shift. */
  async getWeeklySchedule(work_shift_id) {
    return this.workShiftRepo.getWeeklySchedule(work_shift_id);
  }

  /**
   * Create a work shift together with its complete 7-day schedule, in one
   * transaction. The schedule is mandatory: a new shift must not be able to
   * exist in a half-defined state that payroll would later have to guess at.
   */
  async create(payload) {
    if (!payload || typeof payload !== "object") {
      throw validationError(["Work shift details must be an object"]);
    }

    const errors = [];

    const { errors: configErrors, value: config } = validateWorkShiftConfig(payload, {
      isCreate: true,
    });
    errors.push(...configErrors);

    let weeklySchedule = null;
    if (payload.weekly_schedule === undefined) {
      errors.push(
        "weekly_schedule is required when creating a work shift - send all 7 days, Sunday..Saturday"
      );
    } else {
      const scheduleResult = validateWeeklySchedule(payload.weekly_schedule);
      errors.push(...scheduleResult.errors);
      if (scheduleResult.value) weeklySchedule = scheduleResult.value;
    }

    if (errors.length > 0) throw validationError(errors);

    // `actor_employee_id` is stamped on the configuration VERSION the write
    // appends, so "who changed this shift, and when did it start applying" has
    // an answer. It reaches nothing else - the `work_shift` row itself is
    // written exactly as it always was.
    // A brand new shift has no attendance calculated under it, so nothing is
    // propagated here - the save is returned exactly as it always was.
    return this.workShiftRepo.createWorkShiftWithSchedule(config, weeklySchedule, {
      created_by: payload.actor_employee_id === undefined ? null : payload.actor_employee_id,
    });
  }

  /**
   * Update a work shift's configuration, its weekly schedule, or both, in one
   * transaction. Both halves are optional; whichever is absent is left
   * untouched, so a configuration-only save keeps the existing schedule.
   *
   * A schedule that IS sent is still the complete week - there is no partial
   * schedule update.
   */
  async update(work_shift_id, payload) {
    const existingRows = await this.workShiftRepo.getWorkShiftById(work_shift_id);
    const existing = existingRows && existingRows[0];
    if (!existing) return { code: 404, msg: "Work shift not found" };

    const errors = [];

    let config = {};
    if (payload.work_shift_details !== undefined) {
      // Not a create, so shift_code and shift_name are only checked if sent -
      // but `existing` is passed so the regularization rules are judged on the
      // shift as it will be, not on this request alone.
      const result = validateWorkShiftConfig(payload.work_shift_details, { existing });
      errors.push(...result.errors);
      if (result.value) config = result.value;
    }

    let weeklySchedule = null;
    if (payload.weekly_schedule !== undefined) {
      const result = validateWeeklySchedule(payload.weekly_schedule);
      errors.push(...result.errors);
      if (result.value) weeklySchedule = result.value;
    }

    if (errors.length > 0) throw validationError(errors);

    if (Object.keys(config).length === 0 && weeklySchedule === null) {
      throw validationError([
        "Nothing to update - send work_shift_details, weekly_schedule, or both",
      ]);
    }

    const result = await this.workShiftRepo.updateWorkShiftWithSchedule(
      work_shift_id,
      config,
      weeklySchedule,
      { created_by: payload.actor_employee_id === undefined ? null : payload.actor_employee_id }
    );
    return this._propagate(result, {
      work_shift_id,
      actor_employee_id: payload.actor_employee_id,
    });
  }

  /**
   * Save a work shift's weekly schedule. All seven days or nothing.
   */
  async saveWeeklySchedule(work_shift_id, rows, options = {}) {
    const { errors, value } = validateWeeklySchedule(rows);
    if (errors.length > 0) throw validationError(errors);

    const result = await this.workShiftRepo.updateWorkShiftWithSchedule(work_shift_id, {}, value, {
      created_by: options.actor_employee_id === undefined ? null : options.actor_employee_id,
    });
    return this._propagate(result, {
      work_shift_id,
      actor_employee_id: options.actor_employee_id,
    });
  }

  /** Active/inactive toggle. */
  async updateStatus(work_shift_id, active) {
    return this.workShiftRepo.updateStatus(work_shift_id, active ? 1 : 0);
  }
}

module.exports = (workShiftRepo) => {
  return new WorkShiftUsecase(workShiftRepo);
};
