const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const {
  FNF_COMPONENT_KEYS,
  FNF_REMARKS_MAX,
  FNF_AMOUNT_MAX,
  PAYMENT_MODE,
  SETTLEMENT_REFERENCE_MAX,
  SETTLEMENT_REASON_MAX,
  EXIT_REASON,
  YES_NO,
  INTERVIEW_TEXT_MAX,
  REHIRE_ELIGIBILITY,
  REHIRE_NOTE_MAX,
} = require("../constants/fnf");

/**
 * FULL & FINAL SETTLEMENT, EXIT INTERVIEW AND REHIRE ELIGIBILITY - the API.
 *
 *   GET  /payrun/fnf/month         the month's exits and where each F&F stands
 *   GET  /payrun/fnf/items         one exit month's F&F items and their history
 *   POST /payrun/fnf/items         set / clear F&F amounts (before approval)
 *   POST /payrun/fnf/settle        record that a PUBLISHED F&F was paid
 *   POST /payrun/fnf/reopen        undo that, with a reason
 *   POST /payrun/fnf/reconcile-exit bring a late-recorded exit into the
 *                                  month's snapshot (view_employees +
 *                                  process_payroll + manage_fnf_settlement)
 *
 *   GET  /hr/exit/employee/:employee_id                  every exit (CONFIDENTIAL)
 *   GET  /hr/exit/employee/:employee_id/case/:case_id    interview + rehire history
 *   POST /hr/exit/employee/:employee_id/interview        record / edit the interview
 *   POST /hr/exit/employee/:employee_id/rehire           assess / override rehire
 *   GET  /hr/exit/employee/:employee_id/rehire-status    the current standing
 *
 * ================================================== PERMISSIONS ============
 *
 *   F&F reads    view_employees AND view_salary AND view_fnf_settlement
 *                (the list carries net pay - the view_salary disclosure)
 *   F&F writes   view_employees AND manage_fnf_settlement
 *   exit reads   view_employees AND view_exit_interview  (CONFIDENTIAL)
 *   interview    view_employees AND manage_exit_interview
 *   rehire       view_employees AND (manage_exit_interview for the first
 *                assessment | override_rehire_eligibility to change one) -
 *                which applies is decided in the usecase, under the case lock
 *
 * The branch scope is applied to every endpoint, reads and writes alike, with
 * the shared resolver. Joi runs without `allowUnknown`: no figure, status,
 * hash or actor is ever accepted from a client.
 */
class EmployeeExitRoutes {
  constructor(usecase, permissions, branchScope) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  _fail(res, err) {
    const status = { NotFoundError: 404, ConflictError: 409, ForbiddenError: 403 }[err && err.name];
    if (status) {
      res.status(status).json({ code: status, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  async _scope(req, res) {
    if (!this.branchScope) return { store_ids: null };
    const scoped = await this.branchScope.listFilters(req, null);
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

  _inScope() {
    return this.branchScope ? this.branchScope.requireEmployeeInScope() : (req, res, next) => next();
  }

  init() {
    const r = this.router;
    const date = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

    /* ------------------------------------------------------ F&F (payroll) */

    r.get(
      "/payrun/fnf/month",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY, P.VIEW_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.query, this._month());
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          res.json({ code: 200, ...(await this.usecase.getMonth({ ...v.value, store_ids: scoped.store_ids })) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.get(
      "/payrun/fnf/items",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_SALARY, P.VIEW_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.query, { ...this._month(), employee_id: Joi.number().integer().positive().required() });
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          res.json({ code: 200, ...(await this.usecase.getItems({ ...v.value, store_ids: scoped.store_ids })) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.post(
      "/payrun/fnf/items",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.MANAGE_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.body, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
            items: Joi.array()
              .items(
                Joi.object({
                  component: Joi.string().valid(...FNF_COMPONENT_KEYS).required(),
                  amount: Joi.number().min(0).max(FNF_AMOUNT_MAX).allow(null).required(),
                  remarks: Joi.string().trim().max(FNF_REMARKS_MAX).allow("", null).optional(),
                })
              )
              .min(1)
              .max(FNF_COMPONENT_KEYS.length)
              .required(),
          });
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.saveItems({ ...req.body, store_ids: scoped.store_ids, actor }));
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.post(
      "/payrun/fnf/settle",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.MANAGE_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.body, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
            payment_mode: Joi.string().valid(...Object.values(PAYMENT_MODE)).required(),
            payment_reference: Joi.string().trim().max(SETTLEMENT_REFERENCE_MAX).allow("", null).optional(),
            paid_on: date.required(),
          });
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.settle({ ...req.body, store_ids: scoped.store_ids, actor }));
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /*
     * RECONCILE A LATE-RECORDED EXIT into the month's payroll snapshot. It
     * changes what the month IS (an F&F or not), so it needs the payroll
     * processing key as well as the F&F one.
     */
    r.post(
      "/payrun/fnf/reconcile-exit",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL, P.MANAGE_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.body, { ...this._month(), employee_id: Joi.number().integer().positive().required() });
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.reconcileExit({ ...req.body, store_ids: scoped.store_ids, actor }));
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.post(
      "/payrun/fnf/reopen",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.MANAGE_FNF_SETTLEMENT),
      async (req, res) => {
        try {
          const v = Joi.validate(req.body, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
            reason: Joi.string().trim().min(1).max(SETTLEMENT_REASON_MAX).required(),
          });
          if (v.error !== null) throw v.error;
          const scoped = await this._scope(req, res);
          if (!scoped) return;
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.reopen({ ...req.body, store_ids: scoped.store_ids, actor }));
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /* ------------------------------------------ exit interview / rehire */

    const employeeParam = { employee_id: Joi.number().integer().positive().required() };

    r.get(
      "/hr/exit/employee/:employee_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW),
      this._inScope(),
      async (req, res) => {
        try {
          const v = Joi.validate(req.params, employeeParam);
          if (v.error !== null) throw v.error;
          res.json({ code: 200, ...(await this.usecase.employeeExits(v.value.employee_id)) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.get(
      "/hr/exit/employee/:employee_id/case/:case_id",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW),
      this._inScope(),
      async (req, res) => {
        try {
          const v = Joi.validate(req.params, { ...employeeParam, case_id: Joi.number().integer().positive().required() });
          if (v.error !== null) throw v.error;
          res.json({ code: 200, ...(await this.usecase.exitDetail(v.value.employee_id, v.value.case_id)) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.get(
      "/hr/exit/employee/:employee_id/rehire-status",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW),
      this._inScope(),
      async (req, res) => {
        try {
          const v = Joi.validate(req.params, employeeParam);
          if (v.error !== null) throw v.error;
          res.json({ code: 200, ...(await this.usecase.rehireStatus(v.value.employee_id)) });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    const rating = Joi.number().integer().min(1).max(5).allow(null).optional();
    r.post(
      "/hr/exit/employee/:employee_id/interview",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.MANAGE_EXIT_INTERVIEW),
      this._inScope(),
      async (req, res) => {
        try {
          const p = Joi.validate(req.params, employeeParam);
          if (p.error !== null) throw p.error;
          const v = Joi.validate(req.body, {
            exit_date: date.required(),
            interview_date: date.required(),
            primary_reason: Joi.string().valid(...Object.values(EXIT_REASON)).required(),
            rating_job_satisfaction: rating,
            rating_manager_support: rating,
            rating_work_environment: rating,
            rating_compensation: rating,
            would_recommend: Joi.string().valid(...Object.values(YES_NO)).allow(null, "").optional(),
            would_return: Joi.string().valid(...Object.values(YES_NO)).allow(null, "").optional(),
            feedback: Joi.string().trim().max(INTERVIEW_TEXT_MAX).allow("", null).optional(),
            suggestions: Joi.string().trim().max(INTERVIEW_TEXT_MAX).allow("", null).optional(),
          });
          if (v.error !== null) throw v.error;
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.saveInterview(p.value.employee_id, req.body, actor));
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    r.post(
      "/hr/exit/employee/:employee_id/rehire",
      // EITHER key lets the request in; the usecase decides which one this
      // particular write needs (first assessment vs override) under the lock.
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW),
      this.permissions.require(P.MANAGE_EXIT_INTERVIEW, P.OVERRIDE_REHIRE_ELIGIBILITY),
      this._inScope(),
      async (req, res) => {
        try {
          const p = Joi.validate(req.params, employeeParam);
          if (p.error !== null) throw p.error;
          const v = Joi.validate(req.body, {
            exit_date: date.required(),
            eligibility: Joi.string().valid(...Object.values(REHIRE_ELIGIBILITY)).required(),
            conditions: Joi.string().trim().max(REHIRE_NOTE_MAX).allow("", null).optional(),
            note: Joi.string().trim().max(REHIRE_NOTE_MAX).allow("", null).optional(),
            override_reason: Joi.string().trim().max(REHIRE_NOTE_MAX).allow("", null).optional(),
          });
          if (v.error !== null) throw v.error;
          const [canManage, canOverride] = await Promise.all([
            this.permissions.has(req, P.MANAGE_EXIT_INTERVIEW),
            this.permissions.has(req, P.OVERRIDE_REHIRE_ELIGIBILITY),
          ]);
          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.assessRehire(p.value.employee_id, req.body, { canManage, canOverride }, actor));
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

module.exports = (usecase, permissions, branchScope) => new EmployeeExitRoutes(usecase, permissions, branchScope);
module.exports.EmployeeExitRoutes = EmployeeExitRoutes;
