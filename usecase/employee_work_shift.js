const { ASSIGNMENT_STATUS } = require("../repository/employee_work_shift");

/**
 * Shaped so utils/http.js `respondError` answers 400 with the detail, the way
 * a Joi failure already does. Same helper shape as usecase/work_shift.js.
 */
function validationError(errors) {
  const err = new Error(errors.join("; "));
  err.name = "ValidationError";
  err.details = errors;
  return err;
}

/**
 * Employee -> Work Shift assignment.
 *
 * The rules that decide whether an assignment is allowed live here, and the
 * SQL that carries it out lives in the repository. Nothing in this file
 * derives an assignment: there is no fallback that picks a shift when the
 * caller did not, and no path that reads the legacy `shift_id` / `shift_code`
 * to fill one in. An employee is unassigned until HR says otherwise.
 */
class EmployeeWorkShiftUsecase {
  constructor(employeeWorkShiftRepo) {
    this.employeeWorkShiftRepo = employeeWorkShiftRepo;
  }

  /** The assignment screen's employee list. */
  async getEmployeesForAssignment(filters, actor) {
    return this.employeeWorkShiftRepo.getEmployeesForAssignment(filters, actor);
  }

  /** Active work shifts only, for the bulk-action dropdown. */
  async getActiveWorkShifts() {
    return this.employeeWorkShiftRepo.getActiveWorkShifts();
  }

  /**
   * Assign one active work shift to a set of employees.
   *
   * Deduplicates before writing. A selection can repeat an id - a stale
   * checkbox, a retried request - and `WHERE employee_id IN (1, 1, 1)` would
   * otherwise make `assigned_count` disagree with the number of people
   * actually changed, which is the number the confirmation dialog quoted.
   *
   * Existence and active-ness of both the employees and the shift are checked
   * inside the repository's transaction rather than here, because a check in
   * this layer would be a separate connection and could go stale before the
   * write.
   */
  async bulkAssign(payload) {
    if (!payload || typeof payload !== "object") {
      throw validationError(["Request body must be an object"]);
    }

    const errors = [];
    const { employee_ids, work_shift_id } = payload;

    let uniqueEmployeeIds = [];
    if (!Array.isArray(employee_ids)) {
      errors.push("employee_ids is required and must be an array");
    } else if (employee_ids.length === 0) {
      errors.push("Select at least one employee");
    } else {
      const invalid = employee_ids.filter(
        (id) => !Number.isInteger(Number(id)) || Number(id) <= 0
      );
      if (invalid.length > 0) {
        errors.push("employee_ids must all be positive integers");
      } else {
        uniqueEmployeeIds = [...new Set(employee_ids.map((id) => Number(id)))];
      }
    }

    const workShiftId = Number(work_shift_id);
    if (
      work_shift_id === undefined ||
      work_shift_id === null ||
      !Number.isInteger(workShiftId) ||
      workShiftId <= 0
    ) {
      // There is no "unassign" here on purpose: this phase changes an
      // assignment by assigning a different active shift, and clearing one is
      // not a request the screen can make.
      errors.push("work_shift_id is required and must be a positive integer");
    }

    if (errors.length > 0) throw validationError(errors);

    return this.employeeWorkShiftRepo.bulkAssignWorkShift(uniqueEmployeeIds, workShiftId);
  }
}

module.exports = (employeeWorkShiftRepo) => {
  return new EmployeeWorkShiftUsecase(employeeWorkShiftRepo);
};

module.exports.ASSIGNMENT_STATUS = ASSIGNMENT_STATUS;
