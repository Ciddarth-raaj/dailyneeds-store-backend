const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const { PAY_TYPES } = require("../constants/payrun");

/**
 * Payrun Initialization - the API.
 *
 * THE SURFACE, AND IT IS THREE ENDPOINTS AND A HISTORY:
 *
 *   GET  /payrun/month                 the month: population, status, reasons
 *   POST /payrun/initialize            take the snapshots (one or many)
 *   POST /payrun/pay-type              this month's BANK <-> CASH, one employee
 *   GET  /payrun/pay-type/history      who changed it, from what, when
 *
 * THERE IS NO SINGLE-EMPLOYEE INITIALIZE ENDPOINT, deliberately. "Initialize"
 * on one row posts a list of one to the same endpoint, so the single and the
 * bulk case cannot drift apart - two endpoints doing the same thing is how one
 * of them ends up missing a check.
 *
 * PERMISSIONS ARE CONJUNCTIONS (`requireAll`, AND rather than OR):
 *
 *   read the month   `view_employees` AND `view_payroll` AND `view_salary`
 *   initialize       `view_employees` AND `process_payroll`
 *   change pay type  `view_employees` AND `change_payrun_pay_type`
 *
 * WHY THE READ TAKES `view_salary` AS WELL. The Payrun screen shows an
 * APPROVED MONTHLY GROSS per employee - that is salary disclosure over the
 * whole company, and it must not become reachable through a payroll key that
 * somebody was given to look at headcounts. `view_payroll` opens the screen;
 * `view_salary` is what permits the amounts on it; `view_employees` is what
 * every /hr read already demands.
 *
 * WHY INITIALIZE IS `process_payroll`. M2 declared that key as "run a payroll
 * period (not built in M2)" and left it gating nothing. This is that act.
 * Inventing an `initialize_payrun` key beside it would leave `process_payroll`
 * permanently decorative and give administrators two boxes for one decision.
 *
 * WHY THE PAY TYPE IS ITS OWN KEY. Initializing freezes what somebody is OWED;
 * a pay type decides HOW the money reaches them. That is the payment desk's
 * decision rather than the payroll processor's, and one key covering both
 * would mean whoever runs the month can also redirect every payment in it.
 *
 * THE BRANCH SCOPE IS APPLIED TO EVERY ENDPOINT, READS AND WRITES ALIKE, with
 * the shared resolver every other employee route uses. A permission says WHAT;
 * the scope says WHICH EMPLOYEES, it fails closed, and an employee id in a
 * body can only ever be refused by it - never widen it.
 *
 * NOTHING A CLIENT SENDS IS TRUSTED AS A VALUE. The schemas below accept a
 * month, an employee id list and one of two pay-type words. They accept no
 * gross, no salary id, no attendance reference and no status: every figure in
 * a snapshot is read by the server from the server's own tables. Joi runs
 * without `allowUnknown`, so a body that so much as names `monthly_gross` is
 * refused before the usecase is reached.
 *
 * B3 APPLIES HERE TOO. The sensitive response filter and write guard are
 * mounted on this router exactly as they are on /hr, so the payrun cannot
 * become a way around `view_employee_sensitive`.
 */
class PayrunRoutes {
  constructor(payrunUsecase, permissions, sensitive, branchScope) {
    this.usecase = payrunUsecase;
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

  /**
   * The caller's branch scope for this request, or a refusal already sent.
   *
   * Returns `undefined` when it has answered the request itself, so the
   * handler returns immediately - the same shape `routes/employee_master.js`
   * uses.
   */
  async _scope(req, res, requested) {
    if (!this.branchScope) return { store_ids: null };
    const scoped = await this.branchScope.listFilters(req, requested);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return undefined;
    }
    return scoped;
  }

  init() {
    if (this.sensitive) {
      this.router.use("/payrun", this.sensitive.filterResponse);
      this.router.use("/payrun", this.sensitive.guardWrite);
    }

    const monthQuery = {
      year: Joi.number().integer().min(2000).max(2100).required(),
      month: Joi.number().integer().min(1).max(12).required(),
      store_ids: Joi.any().optional(),
      designation_id: Joi.number().integer().positive().optional(),
      status: Joi.string().valid("READY", "BLOCKED", "INITIALIZED").optional(),
    };

    /**
     * THE MONTH.
     *
     * Reads state and changes none: opening the Payrun screen must never
     * initialize anybody, and must never trigger an attendance recalculation.
     * The capability to do either is simply absent from this handler.
     */
    this.router.get(
      "/payrun/month",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, monthQuery);
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, req.query.store_ids);
          if (!scoped) return;

          res.json({
            code: 200,
            ...(await this.usecase.getMonth({
              year: Number(req.query.year),
              month: Number(req.query.month),
              store_ids: scoped.store_ids,
              designation_id: req.query.designation_id,
              status: req.query.status,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * INITIALIZE - one employee or many, by the same path.
     *
     * THE BODY SAYS WHO AND WHICH MONTH, AND NOTHING ELSE. Every value stored
     * in a snapshot is read by the server inside this request; there is no key
     * in this schema that could carry one.
     *
     * THE OUTCOME IS PER ROW. A blocked employee inside a selection does not
     * fail the batch: the eligible rows are initialized in one transaction and
     * the refusals come back named, one per employee id, in the order they
     * were sent.
     */
    this.router.post(
      "/payrun/initialize",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            year: Joi.number().integer().min(2000).max(2100).required(),
            month: Joi.number().integer().min(1).max(12).required(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(1000)
              .required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.initialize({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
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
     * THIS MONTH'S PAY TYPE, FOR ONE EMPLOYEE.
     *
     * BANK or CASH - and the enum is the whole of what may be sent, so HOLD is
     * refused by the schema and not merely unhandled further in.
     *
     * IT CANNOT REACH THE EMPLOYEE MASTER. Nothing on this path writes
     * `new_employee.payment_type`; editing THAT is `edit_payment_details` on
     * the Employee Master, unchanged.
     */
    this.router.post(
      "/payrun/pay-type",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.CHANGE_PAYRUN_PAY_TYPE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            year: Joi.number().integer().min(2000).max(2100).required(),
            month: Joi.number().integer().min(1).max(12).required(),
            employee_id: Joi.number().integer().positive().required(),
            pay_type: Joi.string().valid(...PAY_TYPES).required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.changePayType({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_id: Number(req.body.employee_id),
              pay_type: req.body.pay_type,
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /** Who changed a month's pay type, from what to what, and when. */
    this.router.get(
      "/payrun/pay-type/history",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            year: Joi.number().integer().min(2000).max(2100).required(),
            month: Joi.number().integer().min(1).max(12).required(),
            employee_id: Joi.number().integer().positive().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json({
            code: 200,
            history: await this.usecase.getPayTypeAudit({
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

module.exports = (payrunUsecase, permissions, sensitive, branchScope) =>
  new PayrunRoutes(payrunUsecase, permissions, sensitive, branchScope);
module.exports.PayrunRoutes = PayrunRoutes;
