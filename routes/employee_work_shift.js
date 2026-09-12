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
 * rather than OR - see `constants/hr_permissions.js`). The one exception is
 * the single-employee read, which M1 reduced to the employee-master key
 * alone because the shift is a field of the profile now:
 *
 *   read the LIST      `view_employees` AND `view_shift_assignments`
 *   read ONE employee  `view_employees`  (M1 review fix - see below)
 *   assign one         `employee_edit`  AND `assign_employee_shift`
 *   assign many        `employee_edit`  AND `bulk_assign_employee_shift`
 *
 * The employee-master half of each pair is exactly what this router required
 * before, and is kept: this screen is the employee master joined to the shift
 * master, and no work-shift key should become a way to reach employee data
 * that `view_employees` / `employee_edit` did not already open.
 *
 * THE ONE-EMPLOYEE READ IS NOT THE ROSTER. Shift is part of Employment
 * Details now, so anyone who may open an employee's profile must be able to
 * see which shift that employee is on - demanding `view_shift_assignments`
 * for it left the field blank for most of the people who read the profile.
 * The list endpoint, which is the roster (everybody, filterable, exportable
 * by eye), keeps the pair: seeing one person's shift and reading the whole
 * company's roster are different facts. CHANGING a shift is untouched and
 * still takes `employee_edit` AND `assign_employee_shift`.
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
     * M1 REVIEW FIX - `view_employees` ALONE. Shift moved onto Employment
     * Details, so this is now a field of the employee profile rather than a
     * corner of the roster screen, and whoever may view the employee may see
     * the shift they are on. It used to require `view_shift_assignments` as
     * well, which is held by HR and administrators only, so the field read
     * "not permitted" for exactly the people the section was built for.
     *
     * WHAT THIS DOES NOT OPEN. The response is identity and timing for ONE
     * named employee - `work_shift_id`, code, name, active flag and in/out
     * times - and carries no configuration, no other employee and nothing
     * sensitive under B3. Reading the roster still needs the pair, and
     * changing a shift still needs `employee_edit` + `assign_employee_shift`.
     *
     * Declared BEFORE `/work-shift-assignments/bulk` would matter if either
     * were a wildcard - neither is, and `employee` is a literal segment, so
     * this cannot swallow another path.
     */
    /**
     * M1. The dropdown for choosing a shift on the Employment stage of Add
     * Employee and the Employment section of the profile. Active shifts,
     * identity and timing ONLY - no configuration - which is why it is open
     * to `employee_create` (a store manager choosing a new hire's initial
     * shift) as well as to the shift keys. Declared before the `:employee_id`
     * route so "options" is never read as an id.
     */
    router.get(
      "/work-shift-assignments/options",
      this.permissions.require(P.EMPLOYEE_CREATE, P.ASSIGN_EMPLOYEE_SHIFT, P.VIEW_SHIFT_ASSIGNMENTS, P.VIEW_WORK_SHIFTS),
      async (req, res) => {
        try {
          res.json(await this.usecase.activeOptions());
        } catch (err) {
          respondError(res, err);
        }
        res.end();
      }
    );

    router.get(
      "/work-shift-assignments/employee/:employee_id",
      this.permissions.require(P.VIEW_EMPLOYEES),
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

          // The payload is built field by field rather than spread from the
          // body, so nothing a caller invents can reach the usecase. The actor
          // comes from the token and is stamped on the A0 assignment-history
          // row as who made the change; the effective date is the server's,
          // and there is deliberately no way to ask for a backdated one here.
          res.json(
            await this.usecase.assign({
              employee_ids: req.body.employee_ids,
              work_shift_id: req.body.work_shift_id,
              actor_employee_id: req.decoded ? req.decoded.employee_id : null,
            })
          );
        } catch (err) {
          respondError(res, err);
        }

        res.end();
      }
    );

    /**
     * CORRECT a historical assignment. A different endpoint, a different
     * permission and a different shape from `assign` above, deliberately:
     *
     *   - `effective_from` is REQUIRED here and impossible there, so the
     *     ordinary route can never be used to backdate anything.
     *   - `note` is required, and is stored on the appended history row.
     *   - one employee, never a list: a bulk backdate is not a correction.
     *   - `correct_employee_shift_assignment` is granted by migration to
     *     nobody, because this changes what payroll will recalculate.
     *
     * No frontend field is added for this. It is the safe backend path the
     * append-only resolver has always implied, made explicit and audited.
     */
    router.post(
      "/work-shift-assignments/correction",
      this.permissions.requireAll(P.EMPLOYEE_EDIT, P.CORRECT_EMPLOYEE_SHIFT_ASSIGNMENT),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            work_shift_id: Joi.number().integer().positive().required(),
            effective_from: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            note: Joi.string().min(10).max(255).required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.usecase.correctAssignment({
              employee_id: req.body.employee_id,
              work_shift_id: req.body.work_shift_id,
              effective_from: req.body.effective_from,
              note: req.body.note,
              actor_employee_id: req.decoded ? req.decoded.employee_id : null,
            })
          );
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
