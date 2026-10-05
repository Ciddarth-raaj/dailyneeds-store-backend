const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");
const { REPORT_TYPE_ORDER } = require("../constants/payroll_report_types");

/**
 * Payroll Reports - the HTTP surface, mounted at /reports/payroll.
 *
 *   GET    /meta                      report types, the column catalogue this caller may use
 *   GET    /months                    months with a finalized payrun, in scope
 *   GET    /layout                    this user's columns for a report type + month
 *   PUT    /layout                    save them (month-wise memory)
 *   DELETE /layout                    forget this month's layout (back to default)
 *   POST   /layout/copy-previous      copy the latest earlier month's layout
 *   GET    /templates                 templates for a report type
 *   POST   /templates                 Save as New Template
 *   PUT    /templates/:id             Update Template (structure, optionally name)
 *   PATCH  /templates/:id/name        Rename Template
 *   POST   /templates/:id/duplicate   Duplicate Template
 *   DELETE /templates/:id             Delete Template
 *   PUT    /default-template          Set as Default (or clear)
 *   POST   /preview                   one page, the count and the totals
 *   POST   /export/xlsx | /export/pdf the full population, same columns and order
 *   GET    /epf/validation            Ready / Blocked for the ECR
 *   POST   /epf/ecr                   Download ECR File
 *   POST   /esi/validation            Ready / Blocked for the ESIC file
 *   POST   /esi/contribution-file     Download Contribution File
 *
 * PERMISSIONS - all `requireAll`, which is AND:
 *
 *   read      view_reports + view_employees + view_payroll + view_salary - the
 *             Payrun month screen's own conjunction plus the reporting key.
 *   export    the above + export_reports.
 *   statutory the above + view_employee_sensitive - the ECR / ESIC files carry
 *             full UANs and IP numbers, exactly as `GET /payrun/calculation/ecr`.
 *
 * Column-level access (UAN, bank, PAN, ...) is decided by the catalogue, so a
 * field the caller may not see is not in the picker and is refused if named.
 *
 * BRANCH SCOPE on every data route, fail-closed, from the shared resolver the
 * payrun screens use. Requests carry semantic keys and values only; Joi runs
 * without `allowUnknown`.
 */

const monthSchema = {
  year: Joi.number().integer().min(2000).max(2100).required(),
  month: Joi.number().integer().min(1).max(12).required(),
};
const reportType = Joi.string().valid(REPORT_TYPE_ORDER);
const fieldKeys = Joi.array().items(Joi.string().max(60)).max(100);
const filtersSchema = Joi.object({
  outlet_ids: Joi.array().items(Joi.number().integer().positive()).max(200).optional(),
  department_ids: Joi.array().items(Joi.number().integer().positive()).max(200).optional(),
  pay_type: Joi.string().valid(["BANK", "CASH", ""]).allow(null).optional(),
  search: Joi.string().max(100).allow("").optional(),
});
const displaySchema = Joi.object({
  show_totals: Joi.boolean().optional(),
  sort_by: Joi.string().max(60).allow(null, "").optional(),
  sort_dir: Joi.string().valid(["asc", "desc"]).optional(),
});
const overridesSchema = Joi.array()
  .items(
    Joi.object({
      employee_id: Joi.number().integer().positive().required(),
      reason_code: Joi.number().integer().min(0).max(12).allow(null).optional(),
      last_working_day: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).allow(null, "").optional(),
    })
  )
  .max(5000);

const runSchema = {
  report_type: reportType.required(),
  ...monthSchema,
  field_keys: fieldKeys.optional(),
  filters: filtersSchema.optional(),
  display: displaySchema.optional(),
  template_id: Joi.number().integer().positive().allow(null).optional(),
  page: Joi.number().integer().min(1).optional(),
  page_size: Joi.number().integer().min(1).max(200).optional(),
};
const layoutSchema = {
  report_type: reportType.required(),
  ...monthSchema,
  field_keys: fieldKeys.min(1).required(),
  filters: filtersSchema.optional(),
  display: displaySchema.optional(),
  template_id: Joi.number().integer().positive().allow(null).optional(),
};
const templateSchema = {
  report_type: reportType.required(),
  template_name: Joi.string().min(1).max(120).required(),
  field_keys: fieldKeys.min(1).required(),
  filters: filtersSchema.optional(),
  display: displaySchema.optional(),
  is_shared: Joi.boolean().optional(),
  set_default: Joi.boolean().optional(),
};
const templateUpdateSchema = {
  template_name: Joi.string().min(1).max(120).optional(),
  field_keys: fieldKeys.min(1).required(),
  filters: filtersSchema.optional(),
  display: displaySchema.optional(),
  is_shared: Joi.boolean().optional(),
};

class PayrollReportRoutes {
  constructor(service, permissions, branchScope) {
    if (!branchScope) throw new Error("routes/payroll_report: the employee branch scope is required");
    this.service = service;
    this.permissions = permissions;
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
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err && (err.name === "ReportError" || err.name === "ValidationError") && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, error: err.code, msg: err.message, ...(err.detail || {}) });
    } else if (err && err.isJoi) {
      res.status(400).json({ code: 400, error: "INVALID_REQUEST", msg: err.details ? err.details[0].message : err.toString() });
    } else if (err && (err.name === "SystemAccountError" || err.name === "UnauthenticatedError")) {
      res.status(err.status).json({ code: err.status, error: err.code, msg: err.message });
    } else {
      console.log(err);
      res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  }

  /** The caller's branch scope as store ids (null = all), or a refusal already sent. */
  async _scope(req, res) {
    const scoped = await this.branchScope.listFilters(req, null);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return undefined;
    }
    return scoped.store_ids === undefined ? null : scoped.store_ids;
  }

  _send(res, file, contentType, extraHeaders = {}) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Statutory-Members");
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, String(v));
    res.end(file.buffer);
  }

  init() {
    const { requireAll } = this.permissions;
    const READ = [P.VIEW_REPORTS, P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY];
    const canView = requireAll(...READ);
    const canExport = requireAll(...READ, P.EXPORT_REPORTS);
    const canStatutory = requireAll(...READ, P.EXPORT_REPORTS, P.VIEW_EMPLOYEE_SENSITIVE);
    const actor = (req) => this.branchScope.actorFor(req);
    const r = this.router;

    const handle = (fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        this.fail(res, err);
      }
    };

    r.get("/meta", canView, handle(async (req, res) => res.json(this.service.describe(await actor(req)))));

    r.get(
      "/months",
      canView,
      handle(async (req, res) => {
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        res.json({ months: await this.service.listMonths(await actor(req), store_ids) });
      })
    );

    /* ------------------------------------------------------------ layout */

    r.get(
      "/layout",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, { report_type: reportType.required(), ...monthSchema });
        res.json({ layout: await this.service.getLayout(await actor(req), q) });
      })
    );
    r.put(
      "/layout",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, layoutSchema);
        res.json({ layout: await this.service.saveLayout(await actor(req), body) });
      })
    );
    r.delete(
      "/layout",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, { report_type: reportType.required(), ...monthSchema });
        res.json({ layout: await this.service.resetLayout(await actor(req), q) });
      })
    );
    r.post(
      "/layout/copy-previous",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, { report_type: reportType.required(), ...monthSchema });
        res.json({ layout: await this.service.copyPreviousMonth(await actor(req), body) });
      })
    );

    /* --------------------------------------------------------- templates */

    r.get(
      "/templates",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, { report_type: reportType.required() });
        res.json({ templates: await this.service.listTemplates(await actor(req), q.report_type) });
      })
    );
    r.post(
      "/templates",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, templateSchema);
        res.status(201).json({ template: await this.service.createTemplate(await actor(req), body) });
      })
    );
    r.put(
      "/templates/:templateId",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, templateUpdateSchema);
        res.json({ template: await this.service.updateTemplate(await actor(req), Number(req.params.templateId), body) });
      })
    );
    r.patch(
      "/templates/:templateId/name",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, { template_name: Joi.string().min(1).max(120).required() });
        res.json({ template: await this.service.renameTemplate(await actor(req), Number(req.params.templateId), body.template_name) });
      })
    );
    r.post(
      "/templates/:templateId/duplicate",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, { template_name: Joi.string().max(120).allow("").optional() });
        res.status(201).json({
          template: await this.service.duplicateTemplate(await actor(req), Number(req.params.templateId), body.template_name),
        });
      })
    );
    r.delete(
      "/templates/:templateId",
      canView,
      handle(async (req, res) => {
        await this.service.deleteTemplate(await actor(req), Number(req.params.templateId));
        res.json({ code: 200, msg: "Template deleted" });
      })
    );
    r.put(
      "/default-template",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, {
          report_type: reportType.required(),
          template_id: Joi.number().integer().positive().allow(null).required(),
        });
        res.json({ default: await this.service.setDefaultTemplate(await actor(req), body) });
      })
    );

    /* ------------------------------------------------------------- data */

    r.post(
      "/preview",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, runSchema);
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        res.json(await this.service.preview(await actor(req), body, store_ids));
      })
    );
    r.post(
      "/export/xlsx",
      canExport,
      handle(async (req, res) => {
        const body = this.validate(req.body, runSchema);
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        const file = await this.service.exportXlsx(await actor(req), body, store_ids);
        this._send(res, file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      })
    );
    r.post(
      "/export/pdf",
      canExport,
      handle(async (req, res) => {
        const body = this.validate(req.body, runSchema);
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        const file = await this.service.exportPdf(await actor(req), body, store_ids);
        this._send(res, file, "application/pdf");
      })
    );

    /* -------------------------------------------------------- statutory */

    r.get(
      "/epf/validation",
      canView,
      handle(async (req, res) => {
        const q = this.validate(req.query, monthSchema);
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        res.json(await this.service.epfValidation(await actor(req), q, store_ids));
      })
    );
    r.post(
      "/epf/ecr",
      canStatutory,
      handle(async (req, res) => {
        // The month and nothing else: no column list, and no way to ask for a
        // partial file - a body naming either is refused by Joi.
        const body = this.validate(req.body, monthSchema);
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        const file = await this.service.ecrFile(await actor(req), body, store_ids);
        this._send(res, file, "text/plain; charset=utf-8", { "X-Statutory-Members": file.summary.ready });
      })
    );
    r.post(
      "/esi/validation",
      canView,
      handle(async (req, res) => {
        const body = this.validate(req.body, { ...monthSchema, overrides: overridesSchema.optional() });
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        res.json(await this.service.esiValidation(await actor(req), body, store_ids));
      })
    );
    r.post(
      "/esi/contribution-file",
      canStatutory,
      handle(async (req, res) => {
        const body = this.validate(req.body, {
          ...monthSchema,
          overrides: overridesSchema.optional(),
        });
        const store_ids = await this._scope(req, res);
        if (store_ids === undefined) return;
        const file = await this.service.esicFile(await actor(req), body, store_ids);
        // Excel 97-2003 (.xls), the format the ESIC portal accepts.
        this._send(res, file, "application/vnd.ms-excel", { "X-Statutory-Members": file.summary.ready });
      })
    );
  }
}

module.exports = (service, permissions, branchScope) => new PayrollReportRoutes(service, permissions, branchScope);
module.exports.PayrollReportRoutes = PayrollReportRoutes;
