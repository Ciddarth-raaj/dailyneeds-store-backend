const {
  validateWorkShiftConfig,
  validateWeeklySchedule,
} = require("../utils/workShift");

/**
 * What the save tells the person who made it, in one sentence.
 *
 * A shift rule change reaches attendance days that were calculated weeks ago,
 * and a silent save would give no sign of it. The save does NOT do that work
 * and does not wait for it, so the sentence reports the RUN that now owes it:
 * the counts belong to the run, which the Recalculate Attendance screen shows
 * and which can be retried if it fails.
 */
function recalculationMessage(propagationRunId) {
  if (!propagationRunId) return "Shift updated.";
  return (
    `Shift updated. Attendance recalculation queued (run #${propagationRunId}): ` +
    "every finished attendance day on this shift in an open payroll month will be recalculated " +
    "and stored under the new rule. Days still in progress are shown live under the new rule and " +
    "are stored by the next recalculation after they close. Payroll-locked months are skipped."
  );
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
  }

  /**
   * WHAT A RULE-CHANGING SAVE SAYS.
   *
   * The propagation is NOT started here and is not this usecase's to start:
   * `repository/work_shift.js` writes the obligation in the SAME transaction
   * as the configuration version, so a committed rule change and the promise
   * to propagate it can never come apart. If the queue row could not be
   * written, the save itself rolled back and there is nothing to report.
   *
   * All this does is put the run's id in front of the person who made the
   * change.
   */
  _withRecalculationMessage(result) {
    if (!result || result.code !== 200) return result;
    const runId = result.config_version ? result.config_version.propagation_run_id : null;
    return { ...result, msg: recalculationMessage(runId) };
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
    return this._withRecalculationMessage(result);
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
    return this._withRecalculationMessage(result);
  }

  /** Active/inactive toggle. */
  async updateStatus(work_shift_id, active) {
    return this.workShiftRepo.updateStatus(work_shift_id, active ? 1 : 0);
  }
}

module.exports = (workShiftRepo) => {
  return new WorkShiftUsecase(workShiftRepo);
};
