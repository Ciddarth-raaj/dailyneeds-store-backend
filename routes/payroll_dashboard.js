const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");
const { GROUP_BY } = require("../utils/payroll_dashboard");

/**
 * Payroll Dashboard - the HTTP surface. Read only.
 *
 *   GET /payroll/dashboard/months      the 12 months of a financial year
 *   GET /payroll/dashboard/summary     every panel for one month
 *   GET /payroll/dashboard/employees   the employees behind one number (paged)
 *
 * PERMISSIONS: `requireAll(view_employees, view_payroll, view_salary)` - the
 * Payrun / Calculation & Review conjunction, unchanged. The dashboard shows
 * the same people and the same money those screens do, so it needs exactly
 * their keys and grants nothing new.
 *
 * B3 APPLIES HERE TOO, exactly as on the payrun routers: the sensitive
 * response filter runs on every route, so a caller without
 * `view_employee_sensitive` can never receive an identifier field through the
 * dashboard - today none is returned, and the filter keeps it that way.
 *
 * BRANCH SCOPE on every route, fail-closed, from the shared resolver. The
 * usecase is always handed the caller's WHOLE scope (so the Location choices
 * are every branch they may see); a `store_id` filter must be inside it - one
 * outside is refused 403, never widened and never silently ignored.
 */
const id = Joi.number().integer().positive().allow("", null).optional();
const filterSchema = { store_id: id, department_id: id, designation_id: id };
const monthSchema = {
  year: Joi.number().integer().min(2000).max(2100).required(),
  month: Joi.number().integer().min(1).max(12).required(),
};

class PayrollDashboardRoutes {
  constructor(usecase, permissions, sensitive, branchScope) {
    if (!branchScope) throw new Error("routes/payroll_dashboard: the employee branch scope is required");
    if (!sensitive) throw new Error("routes/payroll_dashboard: the sensitive-field filter is required");
    this.usecase = usecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  getRouter() {
    return this.router;
  }

  validate(payload, schema) {
    const result = Joi.validate(payload === undefined ? {} : payload, schema);
    if (result.error !== null) throw result.error;
    return result.value;
  }

  fail(res, err) {
    if (res.headersSent) return;
    if (err && err.isJoi) {
      res.status(400).json({ code: 400, error: "INVALID_REQUEST", msg: err.details ? err.details[0].message : String(err) });
    } else if (err && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, error: err.code, msg: err.message });
    } else {
      console.log(err);
      res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  }

  /**
   * The caller's scope as store ids (null = all) - or undefined, with the
   * refusal already sent, when the caller has none or names a location
   * outside it.
   */
  async _scope(req, res, storeId) {
    const scoped = await this.branchScope.listFilters(req, null);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return undefined;
    }
    if (storeId !== null && storeId !== undefined && storeId !== "") {
      const narrowed = await this.branchScope.listFilters(req, storeId);
      if (!narrowed.ok) {
        this.branchScope.refuse(res, narrowed);
        return undefined;
      }
    }
    return scoped.store_ids === undefined ? null : scoped.store_ids;
  }

  _filters(q) {
    return { store_id: q.store_id, department_id: q.department_id, designation_id: q.designation_id };
  }

  init() {
    const canView = this.permissions.requireAll(P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY);
    const r = this.router;
    r.use("/payroll/dashboard", this.sensitive.filterResponse);
    const handle = (fn) => async (req, res) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        await fn(req, res);
      } catch (err) {
        this.fail(res, err);
      }
    };

    r.get(
      "/payroll/dashboard/months",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, { fy: Joi.number().integer().min(2000).max(2100).required(), ...filterSchema });
        const store_ids = await this._scope(req, res, q.store_id);
        if (store_ids === undefined) return;
        res.json({ code: 200, ...(await this.usecase.getMonths({ fy: q.fy, store_ids, filters: this._filters(q) })) });
      })
    );

    r.get(
      "/payroll/dashboard/summary",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, {
          ...monthSchema,
          ...filterSchema,
          compare_year: Joi.number().integer().min(2000).max(2100).allow("", null).optional(),
          compare_month: Joi.number().integer().min(1).max(12).allow("", null).optional(),
        });
        const store_ids = await this._scope(req, res, q.store_id);
        if (store_ids === undefined) return;
        const compare = q.compare_year && q.compare_month ? { year: q.compare_year, month: q.compare_month } : null;
        res.json({
          code: 200,
          ...(await this.usecase.getSummary({ year: q.year, month: q.month, store_ids, filters: this._filters(q), compare })),
        });
      })
    );

    r.get(
      "/payroll/dashboard/employees",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, {
          ...monthSchema,
          ...filterSchema,
          metric: Joi.string().max(60).required(),
          group_by: Joi.string().valid(GROUP_BY).allow("", null).optional(),
          group_id: Joi.string().max(60).allow("", null).optional(),
          page: Joi.number().integer().min(1).optional(),
          page_size: Joi.number().integer().min(1).max(200).optional(),
        });
        const store_ids = await this._scope(req, res, q.store_id);
        if (store_ids === undefined) return;
        res.json({
          code: 200,
          ...(await this.usecase.getEmployees({
            year: q.year,
            month: q.month,
            store_ids,
            filters: this._filters(q),
            metric: q.metric,
            group_by: q.group_by || null,
            group_id: q.group_id === undefined || q.group_id === "" ? null : q.group_id,
            page: q.page,
            page_size: q.page_size,
          })),
        });
      })
    );
  }
}

module.exports = (...args) => new PayrollDashboardRoutes(...args);
module.exports.PayrollDashboardRoutes = PayrollDashboardRoutes;
