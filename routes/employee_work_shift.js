const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

/**
 * Employee -> Work Shift assignment, mounted at /employee-work-shift.
 *
 * A separate router rather than additions to /employee or /work-shift:
 *
 *   * /shift is the legacy `shift_master` system and is not touched by this
 *     phase at all.
 *   * /work-shift maintains work shift definitions. Mapping employees onto
 *     them is a different job with a different permission, and the two read
 *     different tables.
 *   * /employee is the HR directory. Its list returns the full employee
 *     record; this screen must return four columns and no salary or bank
 *     data, which is a different contract rather than a parameter on that one.
 *
 * PERMISSIONS - existing keys, no new ones:
 *
 *   * the employee list is `view_employees`. It returns employee master rows,
 *     so it is gated by the key that already guards reading employees, not by
 *     a shift key.
 *   * the dropdown is `view_shift`, the same key `GET /work-shift` already
 *     requires: it returns work shift definitions and nothing about people.
 *   * the write is `employee_edit`. Assigning a shift writes a column on
 *     `new_employee`, so it is an employee edit, and `employee_edit` is what
 *     C2 made that mean. It is deliberately not `add_shifts`: maintaining the
 *     shift catalogue and deciding who works which shift are separate
 *     authorities, and the shift catalogue is not what changes here.
 *
 * Nothing on this router is in the unprotected-routes list, so every endpoint
 * is authenticated before the permission check runs.
 */
class EmployeeWorkShiftRoutes {
  constructor(employeeWorkShiftUsecase, permissions) {
    this.permissions = permissions;
    this.employeeWorkShiftUsecase = employeeWorkShiftUsecase;

    this.init();
  }

  init() {
    /**
     * The assignment screen's employee list, filtered server-side.
     *
     * Every filter is optional and they compose: no filter at all is every
     * active employee, which is the screen's initial state.
     */
    router.get("/employees", this.permissions.require(P.VIEW_EMPLOYEES), async (req, res) => {
      try {
        const schema = {
          store_id: Joi.number().optional(),
          department_id: Joi.number().optional(),
          designation_id: Joi.number().optional(),
          search: Joi.string().allow("").optional(),
          assignment_status: Joi.string()
            .valid("ALL", "ASSIGNED", "UNASSIGNED")
            .optional(),
        };

        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        // `actorFor` resolves the caller once, for `accessScope`. Empty today,
        // but this is the seam an outlet restriction lands on.
        const actor = await this.permissions.actorFor(req);

        const data = await this.employeeWorkShiftUsecase.getEmployeesForAssignment(
          req.query,
          actor
        );
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    /**
     * Active work shifts, for the bulk-action dropdown.
     *
     * Active only, and that is enforced here rather than left to the client:
     * the write rejects an inactive shift too, so a stale dropdown cannot
     * produce an assignment the backend would not have allowed.
     */
    router.get("/work-shifts", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
      try {
        const data = await this.employeeWorkShiftUsecase.getActiveWorkShifts();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    /**
     * Assign one active work shift to the selected employees.
     *
     * Joi checks the shape; the rules - at least one employee, deduplication,
     * the employees and the shift existing and being active - are in the
     * usecase and the repository transaction, so there is one copy of them.
     *
     * Writes `default_work_shift_id` only. The legacy `shift_id` and
     * `shift_code` are not named anywhere on this path.
     */
    router.post("/bulk-assign", this.permissions.require(P.EMPLOYEE_EDIT), async (req, res) => {
      try {
        const schema = {
          employee_ids: Joi.array().items(Joi.number()).required(),
          work_shift_id: Joi.number().required(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.employeeWorkShiftUsecase.bulkAssign(req.body);

        // The usecase reports a rejection as a code in the body, matching the
        // work shift routes; the HTTP status follows it so a client that
        // checks either one agrees.
        if (result && result.code && result.code !== 200) {
          res.status(result.code === 101 ? 400 : result.code).json(result);
          res.end();
          return;
        }

        res.json(result);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (employeeWorkShiftUsecase, permissions) => {
  return new EmployeeWorkShiftRoutes(employeeWorkShiftUsecase, permissions);
};
