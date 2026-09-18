const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const { CALC_STATUS, MAX_BULK_EMPLOYEES } = require("../constants/payrun_calculation");

/**
 * Payrun Calculation & Review - the API. A STAGE of /payrun, mounted under it.
 *
 * THE SURFACE:
 *
 *   GET  /payrun/calculation/month       the stage: population, statuses, counts
 *   GET  /payrun/calculation/employee    ONE employee's full breakup
 *   POST /payrun/calculation/calculate   compute the months not computed yet
 *   POST /payrun/calculation/recalculate refresh the sources on computed ones
 *   POST /payrun/calculation/approve     APPROVE & LOCK, employee by employee
 *   GET  /payrun/calculation/history     who calculated and approved, when
 *
 * THERE IS NO SINGLE-EMPLOYEE VARIANT OF ANY OF THE THREE WRITES, deliberately
 * and for the reason `routes/payrun.js` gives: one row posts a list of one, so
 * the single and the bulk case cannot drift apart - two endpoints doing the
 * same thing is how one of them ends up missing a check.
 *
 * CALCULATE AND RECALCULATE ARE TWO ENDPOINTS ONTO ONE IMPLEMENTATION. They
 * differ only in who is in scope - the ones with no calculation, or the ones
 * that have one - and the usecase takes that as a mode. Two URLs because they
 * are two buttons with two different consequences, one implementation because
 * they produce the same row from the same reads.
 *
 * ================================================== PERMISSIONS ============
 *
 *   read     `view_employees` AND `view_payroll` AND `view_salary` - the same
 *            conjunction `GET /payrun/month` and the adjustments month use.
 *            The third is not decoration: this screen shows per-employee NET
 *            PAY across the whole company, which is the disclosure
 *            `view_salary` governs, and it must not become reachable through a
 *            payroll key somebody was granted to look at headcounts.
 *
 *   calculate / recalculate   `view_employees` AND `process_payroll`. The same
 *            key that initializes a month and puts figures into it; computing
 *            it from them is the same person one stage later.
 *
 *   approve  `view_employees` AND `approve_payrun` - THE NEW KEY, and the only
 *            one this stage adds. Approval LOCKS the employee's month: after
 *            it, the figures cannot be recalculated, the adjustments cannot be
 *            edited and the pay type cannot be changed. Letting
 *            `process_payroll` do it would mean whoever enters an incentive
 *            also signs it off, and this repository already separates the two
 *            wherever money is concerned - see `add_salary` and
 *            `approve_salary_revision`.
 *
 * NOTHING A CLIENT SENDS IS TRUSTED AS A VALUE. The schemas below accept a
 * month, employee ids, a select-all flag and two read filters. They accept no
 * amount, no rate, no net pay, no status, no hash, no `approved_by` and no
 * timestamp: every figure is computed by the server inside the request and who
 * approved something is the SERVER'S identity, from `permissions.actorFor(req)`.
 * Joi runs without `allowUnknown`, so a body that so much as names `net_pay` is
 * refused before the usecase is reached.
 *
 * THE BRANCH SCOPE IS APPLIED TO EVERY ENDPOINT, READS AND WRITES ALIKE, with
 * the shared resolver every other employee route uses. It fails closed, and an
 * employee id in a body can only ever be refused by it - never widen it.
 *
 * B3 APPLIES HERE TOO: the sensitive response filter and write guard are
 * mounted on this router exactly as they are on /payrun and /hr.
 */
class PayrunCalculationRoutes {
  constructor(calculationUsecase, permissions, sensitive, branchScope) {
    this.usecase = calculationUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  /** `NotFoundError` as a 404 rather than the 500 the shared helper would give it. */
  _fail(res, err) {
    if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  /** The caller's branch scope, or a refusal already sent. See `routes/payrun.js`. */
  async _scope(req, res, requested) {
    if (!this.branchScope) return { store_ids: null };
    const scoped = await this.branchScope.listFilters(req, requested);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return undefined;
    }
    return scoped;
  }

  _month() {
    return {
      year: Joi.number().integer().min(2000).max(2100).required(),
      month: Joi.number().integer().min(1).max(12).required(),
    };
  }

  /**
   * THE BODY EVERY BULK ACTION TAKES: WHICH MONTH, AND WHO.
   *
   * `employee_ids` OR `all_eligible`, NEVER BOTH, and the usecase refuses the
   * pair rather than resolving it - "everybody, and also these forty" has two
   * readings and the wrong one processes six hundred people nobody asked for.
   *
   * `all_eligible` CARRIES NO LIST, which is the point of it. Who is eligible
   * is decided on the server from the server's own reads at the moment of the
   * request; a browser sending the ids it believes are ready would be acting on
   * a month that may be minutes old.
   */
  _bulkSchema(allKey) {
    return {
      ...this._month(),
      employee_ids: Joi.array()
        .items(Joi.number().integer().positive())
        .min(1)
        .max(MAX_BULK_EMPLOYEES)
        .optional(),
      [allKey]: Joi.boolean().optional(),
    };
  }

  init() {
    if (this.sensitive) {
      this.router.use("/payrun/calculation", this.sensitive.filterResponse);
      this.router.use("/payrun/calculation", this.sensitive.guardWrite);
    }

    /**
     * THE MONTH.
     *
     * READS STATE AND CHANGES NONE. Opening the review screen must never
     * calculate anybody, must never recalculate a stale employee "helpfully",
     * and must never trigger an attendance run. The capability to do any of
     * them is simply absent from this handler.
     */
    this.router.get(
      "/payrun/calculation/month",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            store_ids: Joi.any().optional(),
            status: Joi.string().valid(...Object.values(CALC_STATUS)).optional(),
            search: Joi.string().trim().max(120).allow("").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, req.query.store_ids);
          if (!scoped) return;

          res.json({
            code: 200,
            ...(await this.usecase.getMonth({
              year: Number(req.query.year),
              month: Number(req.query.month),
              store_ids: scoped.store_ids,
              status: req.query.status,
              search: req.query.search,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /** ONE EMPLOYEE'S FULL BREAKUP - salary, OT, adjustments, statutory, final. */
    this.router.get(
      "/payrun/calculation/employee",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json({
            code: 200,
            ...(await this.usecase.getEmployee({
              year: Number(req.query.year),
              month: Number(req.query.month),
              employee_id: Number(req.query.employee_id),
              store_ids: scoped.store_ids,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * CALCULATE - the employees who have no calculation yet.
     *
     * AN ALREADY-CALCULATED EMPLOYEE IS SKIPPED, NOT SILENTLY RECOMPUTED.
     * "Calculate All Eligible" must not quietly redo two hundred employees
     * somebody has already reviewed; refreshing one is Recalculate, which is a
     * different button because it is a different intention.
     */
    this.router.post(
      "/payrun/calculation/calculate",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this._bulkSchema("all_eligible"));
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.calculate({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              all_eligible: req.body.all_eligible,
              mode: "CALCULATE",
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * RECALCULATE - refresh the sources on an employee who already has a
     * calculation.
     *
     * THIS IS THE EXPLICIT ACT A `RECALCULATION_REQUIRED` ROW IS WAITING FOR.
     * Nothing in this feature recalculates anybody because a source moved; a
     * person does it, here, and until they do the stored figures are exactly
     * what they were.
     *
     * IT PRESERVES EVERYTHING THE PAYRUN OWNS. The Incentive, Bonus, Arrears,
     * Advance Recovery, Shortage Recovery, Balance Advance, the no-adjustment
     * confirmation and the monthly pay type are not written by any path behind
     * this endpoint - the usecase re-reads them from the tables that own them.
     *
     * A LOCKED EMPLOYEE IS REFUSED BY NAME.
     */
    this.router.post(
      "/payrun/calculation/recalculate",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this._bulkSchema("all_eligible"));
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.calculate({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              all_eligible: req.body.all_eligible,
              mode: "RECALCULATE",
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * APPROVE & LOCK - employee by employee.
     *
     * THE ONE ACT IN THIS FEATURE THAT CANNOT BE TAKEN BACK, so every clause
     * of the ready rule is re-decided on the server at the moment of the
     * request, and the approval is recorded against the calculation hash the
     * caller was shown: an employee recalculated between the screen loading
     * and the button being pressed is refused rather than approved on figures
     * nobody looked at.
     *
     * IT LOCKS EMPLOYEES AND NEVER THE MONTH. Everybody not named in the call
     * is exactly as editable afterwards as before it - and that is structural:
     * nothing behind this endpoint writes `payrun_period`.
     */
    this.router.post(
      "/payrun/calculation/approve",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.APPROVE_PAYRUN),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this._bulkSchema("all_ready"));
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.approve({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              all_ready: req.body.all_ready,
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /** Who calculated, recalculated and approved one employee's month, and when. */
    this.router.get(
      "/payrun/calculation/history",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json({
            code: 200,
            history: await this.usecase.getHistory({
              year: Number(req.query.year),
              month: Number(req.query.month),
              employee_id: Number(req.query.employee_id),
            }),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (calculationUsecase, permissions, sensitive, branchScope) =>
  new PayrunCalculationRoutes(calculationUsecase, permissions, sensitive, branchScope);
module.exports.PayrunCalculationRoutes = PayrunCalculationRoutes;
