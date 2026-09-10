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
 * PERMISSIONS ARE EXISTING KEYS, AND BOTH ARE REQUIRED (`requireAll`, so AND
 * rather than OR - see `constants/hr_permissions.js`):
 *
 *   read   `view_employees` AND `view_shift`. The screen joins the employee
 *          master to the shift master, so it asks for permission on both.
 *   write  `employee_edit` AND `view_shift`. `employee_edit` is already the
 *          authority to change an employee's posting - it is what gates
 *          `shift_id` on POST /hr/employee/:id - and `view_shift` is what
 *          says the caller may see the shift they are assigning.
 *
 * No new permission key is declared and no existing one is widened: a caller
 * who could not do this before still cannot.
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
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SHIFT),
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
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SHIFT),
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
     * Bulk assign. All or nothing: an unknown employee id or an inactive
     * work shift refuses the whole request rather than applying part of it.
     */
    router.post(
      "/work-shift-assignments/bulk",
      this.permissions.requireAll(P.EMPLOYEE_EDIT, P.VIEW_SHIFT),
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

  getRouter() {
    return router;
  }
}

module.exports = (employeeWorkShiftUsecase, permissions, sensitive) =>
  new EmployeeWorkShiftRoutes(employeeWorkShiftUsecase, permissions, sensitive);
