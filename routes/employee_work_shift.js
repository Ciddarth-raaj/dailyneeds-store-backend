const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

const router = express.Router();

/**
 * Employee Shift Assignment - the NEW manual employee -> work shift mapping.
 *
 * Mounted at /hr beside `routes/employee_master.js`, because what these
 * endpoints change is an employee record: `new_employee.default_work_shift_id`
 * and nothing else. The work shift master itself stays at /work-shift, where
 * the shifts are created and edited.
 *
 * PERMISSIONS ARE PAIRS, AND BOTH HALVES ARE REQUIRED (`requireAll`, so AND
 * rather than OR - see `constants/hr_permissions.js`):
 *
 *   read        `view_employees` AND `view_shift_assignments`
 *   assign one  `employee_edit`  AND `assign_employee_shift`
 *   assign many `employee_edit`  AND `bulk_assign_employee_shift`
 *
 * The employee-master half of each pair is exactly what this router required
 * before, and is kept: this screen is the employee master joined to the shift
 * master, and no work-shift key should become a way to reach employee data
 * that `view_employees` / `employee_edit` did not already open.
 *
 * What changed is the other half. It used to be `view_shift`, borrowed from
 * the legacy `shift_master` and held today by designations with no payroll
 * role. The Work Shift keys replace it, and they are granted to HR and to
 * administrators only. EVERY CHECK HERE IS THEREFORE NARROWER THAN IT WAS:
 * a caller who could not do this before still cannot, and some who could no
 * longer can - which is the point.
 *
 * ONE IS NOT MANY. `assign_employee_shift` and `bulk_assign_employee_shift`
 * gate the same endpoint but not the same act: correcting one person's
 * roster is an everyday fix, re-rostering four hundred in a click is not.
 * Neither key implies the other; the request's own `employee_ids` decides
 * which one is demanded.
 *
 * B3 APPLIES HERE TOO. `filterResponse` and `guardWrite` are mounted exactly
 * as they are on /hr, so this router cannot become a way around
 * `view_employee_sensitive`. The list selects no sensitive column in the
 * first place; the middleware is the guarantee rather than the mechanism.
 *
 * THE LEGACY SHIFT IS NOT TOUCHED. Nothing on this router reads or writes
 * `shift_id`, `shift_code` or `shift_master`, and /shift is unchanged.
 */
class EmployeeWorkShiftRoutes {
  constructor(employeeWorkShiftUsecase, permissions, sensitive) {
    this.usecase = employeeWorkShiftUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;

    this.init();
  }

  init() {
    if (this.sensitive) {
      router.use("/work-shift-assignments", this.sensitive.filterResponse);
      router.use("/work-shift-assignments", this.sensitive.guardWrite);
    }

    /**
     * The assignment list, filtered on the server.
     *
     * Filters: outlet, department, designation (each a comma list of ids), a
     * search over employee id or name, ASSIGNED/UNASSIGNED/ALL, and the
     * employment status - ACTIVE by default, the same default the HR employee
     * list uses.
     */
    router.get(
      "/work-shift-assignments",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SHIFT_ASSIGNMENTS),
      async (req, res) => {
        try {
          const schema = {
            store_ids: Joi.string().allow("").optional(),
            department_ids: Joi.string().allow("").optional(),
            designation_ids: Joi.string().allow("").optional(),
            assignment_status: Joi.string().optional(),
            employment_status: Joi.string().optional(),
            search: Joi.string().allow("").optional(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          res.json(await this.usecase.list(req.query));
        } catch (err) {
          respondError(res, err);
        }

        res.end();
      }
    );

    /**
     * ONE employee's current work shift, for the employee profile.
     *
     * A READ, and only a read. The profile shows which shift somebody is on;
     * changing it is the assignment screen's job, and the route that does it
     * is the POST below with its own, stricter permission.
     *
     * The same permission pair as the list, for the same reason: this is the
     * employee master joined to the shift master, and seeing it means being
     * allowed to see both.
     *
     * Declared BEFORE `/work-shift-assignments/bulk` would matter if either
     * were a wildcard - neither is, and `employee` is a literal segment, so
     * this cannot swallow another path.
     */
    router.get(
      "/work-shift-assignments/employee/:employee_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SHIFT_ASSIGNMENTS),
      async (req, res) => {
        try {
          res.json(await this.usecase.currentForEmployee(req.params.employee_id));
        } catch (err) {
          respondError(res, err);
        }

        res.end();
      }
    );

    /**
     * Assign. All or nothing: an unknown employee id or an inactive
     * work shift refuses the whole request rather than applying part of it.
     *
     * One endpoint, two permissions - see `assignGuard` below.
     */
    router.post(
      "/work-shift-assignments/bulk",
      this.assignGuard(),
      async (req, res) => {
        try {
          const schema = {
            employee_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
            work_shift_id: Joi.number().integer().positive().required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          res.json(await this.usecase.assign(req.body));
        } catch (err) {
          respondError(res, err);
        }

        res.end();
      }
    );
  }

  /**
   * The guard on the assign endpoint, chosen from the request itself.
   *
   * One employee in `employee_ids` is a single assignment and needs
   * `assign_employee_shift`; more than one is a bulk assignment and needs
   * `bulk_assign_employee_shift`. `employee_edit` is required either way.
   *
   * WHY THE BODY AND NOT THE PATH: there is one endpoint, and the frontend
   * posts through it whether a person ticked one row or four hundred. A
   * second route would be a second thing to keep guarded, and the count is
   * the fact that actually distinguishes the two acts.
   *
   * ANYTHING THAT IS NOT A SINGLE-ELEMENT ARRAY DEMANDS THE BULK KEY. A
   * missing, malformed or over-long `employee_ids` therefore asks for the
   * STRICTER permission and is refused by Joi a moment later; the failure
   * mode of an unparseable body is "too strict", never "waved through".
   * Joi still validates the body in the handler - this reads the count, it
   * does not vouch for the shape.
   */
  assignGuard() {
    const guard = (req, res, next) => {
      const ids = req && req.body ? req.body.employee_ids : undefined;
      const isSingle = Array.isArray(ids) && ids.length === 1;
      const key = isSingle ? P.ASSIGN_EMPLOYEE_SHIFT : P.BULK_ASSIGN_EMPLOYEE_SHIFT;
      return this.permissions.requireAll(P.EMPLOYEE_EDIT, key)(req, res, next);
    };

    // So the route tests can read the wiring rather than the source text,
    // exactly as they do for a plain `requireAll` guard.
    guard.__guard = {
      mode: "all",
      keys: [P.EMPLOYEE_EDIT, P.ASSIGN_EMPLOYEE_SHIFT, P.BULK_ASSIGN_EMPLOYEE_SHIFT],
      dynamic: {
        single: [P.EMPLOYEE_EDIT, P.ASSIGN_EMPLOYEE_SHIFT],
        bulk: [P.EMPLOYEE_EDIT, P.BULK_ASSIGN_EMPLOYEE_SHIFT],
      },
    };

    return guard;
  }

  getRouter() {
    return router;
  }
}

module.exports = (employeeWorkShiftUsecase, permissions, sensitive) =>
  new EmployeeWorkShiftRoutes(employeeWorkShiftUsecase, permissions, sensitive);
