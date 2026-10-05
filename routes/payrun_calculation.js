const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const {
  CALC_STATUS,
  CALC_CARD,
  MAX_BULK_EMPLOYEES,
  RESET_REASON,
  RESET_MODE,
  RESET_REMARK_MAX,
  LIFECYCLE_ACTION,
} = require("../constants/payrun_calculation");
const { MAX_PAYSLIP_EXPORT_BATCH } = require("../constants/payslip");
const logger = require("../utils/logger");

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
 *   POST /payrun/calculation/reset       RESET CALCULATION back to not calculated
 *   POST /payrun/calculation/unlock      UNLOCK an approved, unpublished month
 *   POST /payrun/calculation/publish     PUBLISH an approved month (release)
 *   POST /payrun/calculation/unpublish   UNPUBLISH it, back to approved & locked
 *   POST /payrun/calculation/process-attendance   re-run the EXISTING attendance
 *                                        month persist where readiness says
 *                                        it would clear a blocker
 *   GET  /payrun/calculation/history     who calculated and approved, when
 *   GET  /payrun/calculation/payslip-company   is a payslip company configured
 *   POST /payrun/calculation/payslips/export/plan  who a bulk payslip export covers
 *   POST /payrun/calculation/payslips/export  one batch of those payslips as PDFs
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

  /**
   * THE LIST'S FILTERS, as the month read takes them. A select-all action may
   * be sent with them so that it acts only on the employees the screen was
   * listing - never on somebody a filter had hidden. They narrow; they can
   * never widen: `store_ids` goes through the branch scope like the read's,
   * and the rest only remove employees from the server's own population.
   */
  _listFilterSchema() {
    const id = Joi.number().integer().positive().allow("", null).optional();
    return {
      store_ids: Joi.any().optional(),
      department_id: id,
      designation_id: id,
      status: Joi.string().valid(...Object.values(CALC_STATUS)).optional(),
      card: Joi.string().valid(...Object.values(CALC_CARD)).optional(),
      search: Joi.string().trim().max(120).allow("").optional(),
    };
  }

  /** The filters a select-all was sent with, or null for the month in scope. */
  _listFilters(body, allKey) {
    if (!(body[allKey] === true || body[allKey] === "true")) return null;
    const keys = ["department_id", "designation_id", "status", "card", "search"];
    const filters = {};
    keys.forEach((k) => {
      if (body[k] !== undefined) filters[k] = body[k];
    });
    return filters;
  }

  /** Only a select-all names a location; explicit ids are scoped as before. */
  _requestedStores(body, allKey) {
    return body[allKey] === true || body[allKey] === "true" ? body.store_ids : null;
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
            /* A summary card; the server decides who is in it. */
            card: Joi.string().valid(...Object.values(CALC_CARD)).optional(),
            search: Joi.string().trim().max(120).allow("").optional(),
            /* Department / Designation - narrow the month like the location. */
            department_id: Joi.number().integer().positive().allow("").optional(),
            designation_id: Joi.number().integer().positive().allow("").optional(),
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
              card: req.query.card,
              search: req.query.search,
              department_id: req.query.department_id,
              designation_id: req.query.designation_id,
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
          const isValid = Joi.validate(req.body, {
            ...this._bulkSchema("all_eligible"),
            ...this._listFilterSchema(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, this._requestedStores(req.body, "all_eligible"));
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
              filters: this._listFilters(req.body, "all_eligible"),
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
          const isValid = Joi.validate(req.body, {
            ...this._bulkSchema("all_eligible"),
            ...this._listFilterSchema(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, this._requestedStores(req.body, "all_eligible"));
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
              filters: this._listFilters(req.body, "all_eligible"),
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
          const isValid = Joi.validate(req.body, {
            ...this._bulkSchema("all_ready"),
            ...this._listFilterSchema(),
            mode: Joi.string().valid("INDIVIDUAL", "BULK").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, this._requestedStores(req.body, "all_ready"));
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.approve({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              all_ready: req.body.all_ready,
              mode: req.body.mode,
              store_ids: scoped.store_ids,
              filters: this._listFilters(req.body, "all_ready"),
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * RESET CALCULATION - one employee or a selection, back to NOT CALCULATED.
     *
     * `view_employees` AND `process_payroll`: the key that calculates and
     * recalculates. A reset discards only what that key can already overwrite
     * - the generated figures of an unapproved month - and it never reaches an
     * Approved & Locked employee, which stays the `approve_payrun` holder's.
     *
     * EXPLICIT IDS, A REASON AND A MODE ARE REQUIRED; a remark is required for
     * OTHER. There is no select-all flag. The month is required and every write
     * the usecase makes names it, so a reset cannot land in another month.
     * Who reset is the server's identity, never the body's.
     */
    this.router.post(
      "/payrun/calculation/reset",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
            reason: Joi.string()
              .valid(...Object.values(RESET_REASON))
              .required(),
            remark: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            mode: Joi.string()
              .valid(...Object.values(RESET_MODE))
              .required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.reset({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              reason: req.body.reason,
              remark: req.body.remark,
              mode: req.body.mode,
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
     * PROCESS ATTENDANCE - the existing attendance engine's month persist
     * (`calculateMonth({ persist: true })`), run from Payroll for the selected
     * employees whose blockers it can clear.
     *
     * THREE KEYS, ANDed: `view_employees`, `process_payroll` AND the attendance
     * module's own `recalculate_attendance` - the key that already lets
     * somebody store a month from the Attendance screens. Payroll grants
     * nobody an attendance write they could not already make.
     *
     * Explicit ids only; the month is required; the branch scope is the
     * server's. Approved & Locked employees and locked months are refused.
     */
    this.router.post(
      "/payrun/calculation/process-attendance",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL, P.RECALCULATE_ATTENDANCE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json({
            code: 200,
            ...(await this.usecase.processAttendance({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              store_ids: scoped.store_ids,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * UNLOCK - Approved & Locked (not published) back to calculated, figures kept. `unlock_payrun`.
     * Explicit ids, the month, a mode and (for unlock / unpublish) a reason.
     * The actor is the server's identity and the branch scope the server's.
     */
    this.router.post(
      "/payrun/calculation/unlock",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.UNLOCK_PAYRUN),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
            reason: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            remark: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            mode: Joi.string().valid("INDIVIDUAL", "BULK").required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.lifecycle({
              action: LIFECYCLE_ACTION.UNLOCK,
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              reason: req.body.reason,
              remark: req.body.remark,
              mode: req.body.mode,
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
     * PUBLISH - release an Approved & Locked month; refused if a source moved. `publish_payrun`.
     * Explicit ids, the month, a mode and (for unlock / unpublish) a reason.
     * The actor is the server's identity and the branch scope the server's.
     */
    this.router.post(
      "/payrun/calculation/publish",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PUBLISH_PAYRUN),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
            reason: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            remark: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            mode: Joi.string().valid("INDIVIDUAL", "BULK").required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.lifecycle({
              action: LIFECYCLE_ACTION.PUBLISH,
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              reason: req.body.reason,
              remark: req.body.remark,
              mode: req.body.mode,
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
     * UNPUBLISH - withdraw the release; back to Approved & Locked. `publish_payrun`.
     * Explicit ids, the month, a mode and (for unlock / unpublish) a reason.
     * The actor is the server's identity and the branch scope the server's.
     */
    this.router.post(
      "/payrun/calculation/unpublish",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PUBLISH_PAYRUN),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
            reason: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            remark: Joi.string().trim().max(RESET_REMARK_MAX).allow("", null).optional(),
            mode: Joi.string().valid("INDIVIDUAL", "BULK").required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.lifecycle({
              action: LIFECYCLE_ACTION.UNPUBLISH,
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              reason: req.body.reason,
              remark: req.body.remark,
              mode: req.body.mode,
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
     * PUBLISH ALL APPROVED PAYSLIPS. `publish_payrun`. The body is the month
     * and nothing else: WHO is approved is decided on the server, inside the
     * caller's branch scope, at the moment of the request.
     */
    this.router.post(
      "/payrun/calculation/publish-all",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PUBLISH_PAYRUN),
      async (req, res) => {
        try {
          /* Publish-all IS a select-all: it may carry the list's filters. */
          const isValid = Joi.validate(req.body, { ...this._month(), ...this._listFilterSchema() });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, req.body.store_ids);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.publishAllApproved({
              year: Number(req.body.year),
              month: Number(req.body.month),
              store_ids: scoped.store_ids,
              filters: this._listFilters({ ...req.body, all: true }, "all"),
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * RETRY NOTIFICATION - send the "payslip available" message again.
     * `publish_payrun`. Explicit ids; never republishes, never writes payroll.
     * The Telegram destination is resolved on the server - there is no chat
     * id field, and Joi refuses one.
     */
    this.router.post(
      "/payrun/calculation/retry-notification",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PUBLISH_PAYRUN),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(MAX_BULK_EMPLOYEES)
              .required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.retryNotification({
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
     * VIEW PAYSLIP (admin). The same permissions as the month itself and the
     * caller's branch scope. Returns the frozen snapshot - which the B3
     * sensitive filter on this router strips of UAN / PF / ESI numbers for a
     * caller without `view_employee_sensitive` - plus versions and attempts.
     */
    this.router.get(
      "/payrun/calculation/payslip",
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
            ...(await this.usecase.getPayslip({
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
     * EPFO 2026 WAGE CEILING REVISION - THE AFFECTED-EMPLOYEE REPORT.
     * READ-ONLY: three SELECTs and a pure classification. It shows salary and
     * statutory membership, so it takes the month screen's three keys AND
     * `view_employee_sensitive`.
     */
    this.router.get(
      "/payrun/calculation/pf-ceiling-impact",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.VIEW_EMPLOYEE_SENSITIVE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, { store_ids: Joi.any().optional() });
          if (isValid.error !== null) throw isValid.error;
          const scoped = await this._scope(req, res, req.query.store_ids);
          if (!scoped) return;
          res.json({ code: 200, ...(await this.usecase.getPfCeilingImpact({ store_ids: scoped.store_ids })) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * THE EPFO ECR FOR A MONTH, built from the STORED, APPROVED calculations
     * only. READ-ONLY. The text carries full UANs, so it takes
     * `view_employee_sensitive` as well. There is no unapproved preview.
     */
    this.router.get(
      "/payrun/calculation/ecr",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.VIEW_EMPLOYEE_SENSITIVE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            store_ids: Joi.any().optional(),
          });
          if (isValid.error !== null) throw isValid.error;
          const scoped = await this._scope(req, res, req.query.store_ids);
          if (!scoped) return;
          res.json({
            code: 200,
            ...(await this.usecase.getEcr({
              year: Number(req.query.year),
              month: Number(req.query.month),
              store_ids: scoped.store_ids,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * CAN PAYSLIPS BE PUBLISHED - is exactly one company Active for Payslip
     * in Master → Company Details. The month screen's read keys: it names the
     * company and nothing else (no PAN, TAN or statutory code), and Publish
     * itself re-decides it on the server.
     */
    this.router.get(
      "/payrun/calculation/payslip-company",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL),
      async (req, res) => {
        try {
          res.json({ code: 200, ...(await this.usecase.getPayslipCompanyStatus()) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * BULK PAYSLIP EXPORT - the same keys as View Payslip: whoever may read a
     * payslip here may download it.
     *
     *   POST /payrun/calculation/payslips/export/plan   who will be exported
     *   POST /payrun/calculation/payslips/export        one batch of PDFs
     *
     * BOTH TAKE THE LIST'S FILTERS and the server resolves the population
     * from them (with the branch scope); `employee_ids` only narrows it - a
     * selection on the plan, the batch on the export. Nothing is written,
     * not even the employee's "viewed" record.
     */
    const exportBody = (idsSchema) => ({
      ...this._month(),
      ...this._listFilterSchema(),
      employee_ids: idsSchema,
    });
    const exportFilters = (body) => {
      const filters = {};
      ["department_id", "designation_id", "status", "card", "search"].forEach((k) => {
        if (body[k] !== undefined) filters[k] = body[k];
      });
      return filters;
    };
    this.router.post(
      "/payrun/calculation/payslips/export/plan",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(
            req.body,
            exportBody(Joi.array().items(Joi.number().integer().positive()).min(1).max(MAX_BULK_EMPLOYEES).optional())
          );
          if (isValid.error !== null) throw isValid.error;
          const scoped = await this._scope(req, res, req.body.store_ids);
          if (!scoped) return;
          res.json({
            code: 200,
            ...(await this.usecase.planPayslipExport({
              year: Number(req.body.year),
              month: Number(req.body.month),
              store_ids: scoped.store_ids,
              filters: exportFilters(req.body),
              employee_ids: req.body.employee_ids || null,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );
    this.router.post(
      "/payrun/calculation/payslips/export",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY),
      async (req, res) => {
        try {
          const isValid = Joi.validate(
            req.body,
            exportBody(Joi.array().items(Joi.number().integer().positive()).min(1).max(MAX_PAYSLIP_EXPORT_BATCH).required())
          );
          if (isValid.error !== null) throw isValid.error;
          const scoped = await this._scope(req, res, req.body.store_ids);
          if (!scoped) return;

          const out = await this.usecase.exportPayslipPdfs({
            year: Number(req.body.year),
            month: Number(req.body.month),
            employee_ids: req.body.employee_ids,
            store_ids: scoped.store_ids,
            filters: exportFilters(req.body),
          });
          const actor = await this.permissions.actorFor(req);
          logger.Log({
            level: logger.LEVEL.INFO,
            component: "ROUTES.PAYRUN_CALCULATION",
            code: "PAYSLIP_EXPORT",
            description: `Exported ${out.files.length} payslip PDF(s) for ${out.period_year}-${out.period_month}`,
            category: "",
            ref: { actor: actor && actor.employeeId, employee_ids: out.files.map((f) => f.employee_id) },
          });
          res.set("Cache-Control", "no-store");
          res.json({ code: 200, ...out });
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
