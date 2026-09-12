const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

const router = express.Router();

/**
 * M2 — the salary API. M4 adds ONE read to it.
 *
 * Mounted at /hr beside `routes/employee_master.js` and
 * `routes/employee_work_shift.js`, because what these endpoints describe is an
 * employee record.
 *
 * THE SURFACE, AND IT IS STILL SMALL:
 *
 *   POST /hr/salary/preview/:id            the pure calculation, saving nothing
 *   POST /hr/salary/employee/:id           create a salary proposal as PENDING
 *   GET  /hr/salary/employee/:id/current   the current effective approved salary
 *   GET  /hr/salary/employee/:id/history   every revision
 *   POST /hr/salary/revision/:id           amend a PENDING proposal
 *   POST /hr/salary/revision/:id/approve   the money decision
 *   POST /hr/salary/revision/:id/reject    with a required reason
 *   GET  /hr/salary/pending                M4: the cross-employee approval queue
 *
 * M4 BUILDS TWO SCREENS ON THIS AND ADDS ONE ENDPOINT. Salary Revision &
 * History and Salary Approval are driven by the seven primitives M2 already
 * defined; the only thing they could not be built from is a list of everybody's
 * pending proposals, which no per-employee endpoint can answer without the
 * browser reading six hundred histories. That is the whole of the addition.
 *
 * There is STILL no bulk upload, no payroll run, no payslip and no attendance
 * calculation. Those are M5 and later, and nothing here anticipates them.
 *
 * THE SERVER CALCULATES EVERYTHING. The Joi schemas below accept a gross, an
 * effective date, and — for an override — four component amounts. They accept
 * no `basic` outside an override, no contribution, and no CTC. Joi runs
 * without `allowUnknown`, so a body that so much as names `employee_pf` or
 * `monthly_ctc` is answered 422 before the usecase is reached. That is the
 * mechanism, not a filter further in.
 *
 * PERMISSIONS ARE CONJUNCTIONS, AND EVERY HALF IS REQUIRED (`requireAll`, so
 * AND rather than OR):
 *
 *   preview   `view_employees` AND `view_salary`
 *   create    `view_employees` AND `add_salary`
 *   amend     `view_employees` AND `edit_salary`
 *   read      `view_employees` AND `view_salary`
 *   approve   `view_employees` AND `approve_salary_revision`
 *   reject    `view_employees` AND `approve_salary_revision`
 *   queue     `view_employees` AND `view_salary` AND `approve_salary_revision`
 *
 * The queue is the one triple, and the third key is the point of it: every
 * other read here answers a question about ONE employee somebody navigated to,
 * while this one lists every outstanding pay proposal in the company. That is
 * an approver's worklist, so it takes the approver's key.
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
      /*
       * M4 — the proposer's business reason. A STRING, and the only other
       * thing besides the four override components that a caller may put on a
       * salary record; it is not an amount and nothing is computed from it.
       *
       * Accepted as optional HERE and required in the usecase, because whether
       * it is required depends on the SOURCE, which the server decides: an
       * opening salary legitimately has none, a revision must have one. Joi
       * cannot see that decision, and a schema that demanded it unconditionally
       * would make the first salary for every employee unenterable.
       */
      revision_reason: Joi.string().allow("").allow(null).optional(),
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

    /**
     * M4 — THE PENDING APPROVAL QUEUE, ACROSS ALL EMPLOYEES.
     *
     * The one read the Salary Approval screen makes. It exists because the
     * alternative is a browser walking the employee master and reading every
     * history to find four pending rows - which is hundreds of requests, and
     * hundreds of salary histories handed to a client that wanted none of them.
     *
     * THREE KEYS, NOT TWO, AND ALL OF THEM (`requireAll`):
     *
     *   `view_employees`           this returns employee names and outlets
     *   `view_salary`              it returns salary figures
     *   `approve_salary_revision`  it is the approver's worklist
     *
     * The third is what makes this different from every other read on this
     * router. A queue of everybody's outstanding pay proposals is not the same
     * disclosure as one employee's structure that somebody opened deliberately,
     * so it is gated on the key that says you are the person who decides them.
     * Holding it still does not let you approve your own - that rule is in the
     * usecase and applies to the action, not to the list.
     *
     * FILTERS ARE OPTIONAL AND ARE FILTERS ONLY. Employee, outlet and an
     * effective-date window; none of them can widen what comes back beyond
     * PENDING, which is fixed in the SQL rather than defaulted here.
     *
     * NO PAGINATION. A worklist people empty is a handful of rows - see
     * `QUEUE_MAX_ROWS` in the usecase, which is a safety cap and not a page.
     */
    router.get(
      "/salary/pending",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY, P.APPROVE_SALARY_REVISION),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            employee_id: Joi.number().integer().optional(),
            store_id: Joi.number().integer().optional(),
            effective_from: Joi.string().allow("").optional(),
            effective_to: Joi.string().allow("").optional(),
            as_of: Joi.string().allow("").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.getPendingQueue(req.query, actor));
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
