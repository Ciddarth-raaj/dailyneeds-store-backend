const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

const router = express.Router();

/**
 * M2 — the salary API.
 *
 * Mounted at /hr beside `routes/employee_master.js` and
 * `routes/employee_work_shift.js`, because what these endpoints describe is an
 * employee record.
 *
 * M2 IS DELIBERATELY A SMALL API. Four things and no more:
 *
 *   POST /hr/salary/preview                the pure calculation, saving nothing
 *   POST /hr/salary/employee/:id           create an initial salary as PENDING
 *   GET  /hr/salary/employee/:id/current   the current effective approved salary
 *   GET  /hr/salary/employee/:id/history   every revision
 *
 * There is NO bulk upload, no revision workflow screen and no payroll run.
 * Approve and reject exist because a record created PENDING that nothing can
 * ever approve is a dead end, and because the resolver cannot be tested
 * without them — but they are the lifecycle primitives, not a workflow.
 *
 * THE SERVER CALCULATES EVERYTHING. The Joi schemas below accept a gross, an
 * effective date, and — for an override — four component amounts. They accept
 * no `basic` outside an override, no contribution, and no CTC. Joi runs
 * without `allowUnknown`, so a body that so much as names `employee_pf` or
 * `monthly_ctc` is answered 422 before the usecase is reached. That is the
 * mechanism, not a filter further in.
 *
 * PERMISSIONS ARE PAIRS, AND BOTH HALVES ARE REQUIRED (`requireAll`, so AND
 * rather than OR):
 *
 *   preview   `view_employees` AND `view_salary`
 *   create    `view_employees` AND `add_salary`
 *   amend     `view_employees` AND `edit_salary`
 *   read      `view_employees` AND `view_salary`
 *   approve   `view_employees` AND `approve_salary_revision`
 *   reject    `view_employees` AND `approve_salary_revision`
 *
 * The employee-master half is what every other /hr router already demands, and
 * it is kept so that no salary key becomes a way to reach employee data that
 * `view_employees` did not already open.
 *
 * A MANUAL OVERRIDE NEEDS A THIRD KEY. Any request carrying
 * `manual_components` also demands `manual_salary_component_override` — see
 * `overrideGuard` at the foot of this file. Entering a salary and departing
 * from the statutory breakup are two decisions.
 *
 * B3 APPLIES HERE TOO. `filterResponse` and `guardWrite` are mounted exactly
 * as they are on /hr, so this router cannot become a way around
 * `view_employee_sensitive`.
 */
class EmployeeSalaryRoutes {
  constructor(employeeSalaryUsecase, permissions, sensitive) {
    this.usecase = employeeSalaryUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;

    this.init();
  }

  /**
   * `NotFoundError` as a 404 rather than the 500 `respondError` would give it.
   *
   * Handled here rather than by widening the shared helper: every other router
   * in the codebase relies on that helper's current behaviour, and M2 has no
   * business changing what they answer.
   */
  _fail(res, err) {
    if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  init() {
    if (this.sensitive) {
      router.use("/salary", this.sensitive.filterResponse);
      router.use("/salary", this.sensitive.guardWrite);
    }

    /**
     * The four component amounts a manual override may supply — and the only
     * amounts any endpoint here accepts from a caller.
     */
    const manualComponents = Joi.object({
      basic: Joi.number().min(0).required(),
      conveyance: Joi.number().min(0).required(),
      hra: Joi.number().min(0).required(),
      special_allowance: Joi.number().min(0).required(),
    });

    /**
     * The monthly-payroll statutory context.
     *
     * Accepted but not yet supplied by anything: ESI is charged on the wage
     * actually paid in a period, and there is no monthly payroll to report one
     * yet. The engine answers PENDING without it rather than computing a
     * contribution off the gross. These keys exist so that M4/M5 is a caller
     * change and not an engine change.
     */
    const payrollContext = {
      esi_wage: Joi.number().min(0).optional(),
      contribution_period_continues: Joi.boolean().optional(),
      employee_contribution_exempt: Joi.boolean().optional(),
    };

    const calculationBody = {
      monthly_gross: Joi.number().min(0).required(),
      effective_from: Joi.string().allow("").allow(null).optional(),
      manual_components: manualComponents.optional(),
      manual_override: Joi.boolean().optional(),
      override_reason: Joi.string().allow("").allow(null).optional(),
      ...payrollContext,
    };

    /**
     * PREVIEW — the pure calculation service, exposed.
     *
     * SAVES NOTHING. It exists so a screen can show the breakup, the statutory
     * numbers and the CTC before anybody commits to them, and so that what is
     * previewed is what gets stored: the create path runs the same function on
     * the same inputs.
     *
     * It reads the employee, so it takes `view_employees` and `view_salary` —
     * a preview returns real statutory facts about a named person.
     */
    router.post(
      "/salary/preview/:employee_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY),
      this.overrideGuard(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, calculationBody);
          if (isValid.error !== null) throw isValid.error;

          res.json(await this.usecase.calculateForEmployee(req.params.employee_id, req.body));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * CREATE — always PENDING, never approved on the way in.
     *
     * For an employee with no salary record, the effective date is NOT the
     * caller's to choose: it is the later of the opening floor and their date
     * of joining, and `effective_from` in the body is ignored for that case.
     */
    router.post(
      "/salary/employee/:employee_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.ADD_SALARY),
      this.overrideGuard(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, calculationBody);
          if (isValid.error !== null) throw isValid.error;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.createInitialSalary(req.params.employee_id, req.body, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * THE RESOLVER — the current effective approved salary.
     *
     * `as_of` defaults to today. A `null` salary is a real answer and means
     * "nothing recorded yet", which is the case for every employee until
     * somebody enters one; it does not mean zero.
     */
    router.get(
      "/salary/employee/:employee_id/current",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            as_of: Joi.string().allow("").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          res.json(await this.usecase.getCurrentSalary(req.params.employee_id, req.query.as_of));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /** Every revision for an employee, pending and rejected ones included. */
    router.get(
      "/salary/employee/:employee_id/history",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY),
      async (req, res) => {
        try {
          res.json(await this.usecase.getHistory(req.params.employee_id));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /** Amend a PENDING proposal. Approved history is immutable. */
    router.post(
      "/salary/revision/:salary_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.EDIT_SALARY),
      this.overrideGuard(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, calculationBody);
          if (isValid.error !== null) throw isValid.error;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.updatePendingSalary(req.params.salary_id, req.body, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /** Approve — the money decision, and its own permission. */
    router.post(
      "/salary/revision/:salary_id/approve",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.APPROVE_SALARY_REVISION),
      async (req, res) => {
        try {
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.approveSalary(req.params.salary_id, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /** Reject, with a required reason. */
    router.post(
      "/salary/revision/:salary_id/reject",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.APPROVE_SALARY_REVISION),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            reason: Joi.string().trim().min(1).required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.rejectSalary(req.params.salary_id, req.body.reason, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );
  }

  /**
   * A manual override demands `manual_salary_component_override` ON TOP of
   * whichever key the endpoint already required.
   *
   * IT NEVER ALLOWS ANYTHING. A body without `manual_components` passes
   * straight through to the route's own `requireAll`, which has already run.
   * All this decides is whether a THIRD key is demanded as well — and it fails
   * closed: anything that looks like an override and is not recognised still
   * demands the key.
   *
   * `__guard` is exposed so the route tests can read the wiring rather than
   * the source text, exactly as `routes/employee.js#updateDataGuard` does.
   */
  overrideGuard() {
    const guard = (req, res, next) => {
      const body = req && req.body;
      const wantsOverride =
        body &&
        typeof body === "object" &&
        (body.manual_components !== undefined ||
          body.manual_override === true ||
          body.manual_override === 1);

      if (!wantsOverride) return next();
      return this.permissions.require(P.MANUAL_SALARY_COMPONENT_OVERRIDE)(req, res, next);
    };

    guard.__guard = {
      mode: "any",
      keys: [P.MANUAL_SALARY_COMPONENT_OVERRIDE],
      dynamic: {
        override: [P.MANUAL_SALARY_COMPONENT_OVERRIDE],
        otherwise: [],
      },
    };

    return guard;
  }

  getRouter() {
    return router;
  }
}

module.exports = (employeeSalaryUsecase, permissions, sensitive) =>
  new EmployeeSalaryRoutes(employeeSalaryUsecase, permissions, sensitive);
module.exports.EmployeeSalaryRoutes = EmployeeSalaryRoutes;
