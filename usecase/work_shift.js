const {
  validateWorkShiftConfig,
  validateWeeklySchedule,
} = require("../utils/workShift");

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

    return this.workShiftRepo.createWorkShiftWithSchedule(config, weeklySchedule);
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

    return this.workShiftRepo.updateWorkShiftWithSchedule(
      work_shift_id,
      config,
      weeklySchedule
    );
  }

  /**
   * Save a work shift's weekly schedule. All seven days or nothing.
   */
  async saveWeeklySchedule(work_shift_id, rows) {
    const { errors, value } = validateWeeklySchedule(rows);
    if (errors.length > 0) throw validationError(errors);

    return this.workShiftRepo.updateWorkShiftWithSchedule(work_shift_id, {}, value);
  }

  /** Active/inactive toggle. */
  async updateStatus(work_shift_id, active) {
    return this.workShiftRepo.updateStatus(work_shift_id, active ? 1 : 0);
  }
}

module.exports = (workShiftRepo) => {
  return new WorkShiftUsecase(workShiftRepo);
};
