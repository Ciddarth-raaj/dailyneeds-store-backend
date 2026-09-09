const {
  validateShiftConfig,
  validateWeeklySchedule,
} = require("../utils/shiftSchedule");

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

class ShiftUsecase {
    constructor(shiftRepo) {
        this.shiftRepo = shiftRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.shiftRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.shiftRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    getShiftById(shift_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.shiftRepo.getShiftById(shift_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }

    /**
     * Update a shift's configuration, its weekly schedule, or both, in one
     * transaction. `shift.shift_details` and `shift.weekly_schedule` are each
     * optional; whichever is absent is left untouched.
     */
    async updateShiftDetails(shift) {
      const errors = [];

      let config = {};
      if (shift.shift_details !== undefined) {
        const result = validateShiftConfig(shift.shift_details);
        errors.push(...result.errors);
        if (result.value) config = result.value;
      }

      let weeklySchedule = null;
      if (shift.weekly_schedule !== undefined) {
        const result = validateWeeklySchedule(shift.weekly_schedule);
        errors.push(...result.errors);
        if (result.value) weeklySchedule = result.value;
      }

      if (errors.length > 0) throw validationError(errors);

      if (Object.keys(config).length === 0 && weeklySchedule === null) {
        throw validationError([
          "Nothing to update - send shift_details, weekly_schedule, or both",
        ]);
      }

      const result = await this.shiftRepo.updateShiftWithSchedule(
        shift.shift_id,
        config,
        weeklySchedule
      );
      return result.code;
    }

    /** A shift's full configuration plus its weekly schedule, or null. */
    async getShiftWithSchedule(shift_id) {
      return this.shiftRepo.getShiftWithSchedule(shift_id);
    }

    /** Just the weekly schedule rows for a shift. */
    async getWeeklySchedule(shift_id) {
      return this.shiftRepo.getWeeklySchedule(shift_id);
    }

    /**
     * Save a shift's weekly schedule. The rows sent are the whole week: a day
     * present is written, a day absent is removed.
     */
    async saveWeeklySchedule(shift_id, rows) {
      const { errors, value } = validateWeeklySchedule(rows);
      if (errors.length > 0) throw validationError(errors);

      const result = await this.shiftRepo.updateShiftWithSchedule(shift_id, {}, value);
      return result;
    }

    /**
     * Create a shift, optionally with its weekly schedule, in one transaction.
     *
     * Accepts both the legacy field names (`shift_in_time`, `shift_out_time`,
     * `status`) and the Phase 1 ones (`start_time`, `end_time`, `active`).
     */
    async create(shift) {
      const { errors, value } = validateShiftConfig(shift);

      let weeklySchedule = null;
      if (shift.weekly_schedule !== undefined) {
        const scheduleResult = validateWeeklySchedule(shift.weekly_schedule);
        errors.push(...scheduleResult.errors);
        if (scheduleResult.value) weeklySchedule = scheduleResult.value;
      }

      if (errors.length > 0) throw validationError(errors);

      // shift_in_time and shift_out_time are NOT NULL on the table, so a new
      // shift cannot be created without both times.
      const required = [];
      if (!value.shift_name) required.push("shift_name is required");
      if (!value.start_time) required.push("start_time (or shift_in_time) is required");
      if (!value.end_time) required.push("end_time (or shift_out_time) is required");
      if (required.length > 0) throw validationError(required);

      // A shift created without an explicit flag is active. The legacy route
      // made `status` optional but would fail on the insert if it was left
      // out, so there is no prior behaviour here to preserve.
      if (value.active === undefined) value.active = 1;

      return this.shiftRepo.createShiftWithSchedule(value, weeklySchedule);
    }
}

module.exports = (shiftRepo) => {
    return new ShiftUsecase(shiftRepo);
};
