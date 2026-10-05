const ExcelJS = require("exceljs");

const P = require("../constants/hr_permissions");
const catalogue = require("../constants/payroll_report_catalogue");
const { REPORT_TYPES, REPORT_TYPE_ORDER, getReportType, DATASET_KEYS } = require("../constants/payroll_report_types");
const { monthLabel, MONTH_SHORT } = require("../constants/payslip");
const Q = require("../utils/payroll_report_query");
const statutoryFiles = require("../utils/payroll_statutory_files");
const rules = require("./report_template_rules");

/**
 * Payroll Reports - the service.
 *
 * REUSES, RATHER THAN PARALLELS, THE REPORTS FOUNDATION:
 *
 *   templates     the existing `report_template` table, repository and
 *                 ownership rules (`report_template_rules`) - personal /
 *                 shared / system, Save-a-Copy, reconcile-on-run. A payroll
 *                 template is filed under its report type's `dataset_key`.
 *   export audit  the existing `report_export_log`: who exported which SHAPE
 *                 of which month. Never a value.
 *   permissions   the existing keys. No new key is introduced.
 *   statutory     `utils/epfo_ecr.js` - the payrun's own ECR builder.
 *
 * What is new is only what did not exist: the payroll field catalogue, the
 * month-wise layout memory, a per-user default template, PDF, and the ESIC
 * contribution file.
 *
 * ======================================================== NOTHING IS PRICED
 *
 * Opening, previewing or exporting a report runs SELECTs over the stored,
 * APPROVED_LOCKED payrun rows. No method here calls the payroll or attendance
 * calculation, and nothing here writes a payrun table.
 */

const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
const LIMITS = {
  MAX_ROWS: positiveInt(process.env.PAYROLL_REPORT_MAX_ROWS, 20000),
  MAX_PDF_ROWS: positiveInt(process.env.PAYROLL_REPORT_MAX_PDF_ROWS, 3000),
  PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
};

const { PayrollReportError } = Q;
const notFound = () => new PayrollReportError(404, "TEMPLATE_NOT_FOUND", "That template was not found");

const STATUTORY_POST = new Set(["epf_validation", "esi_validation", "esi_reason", "esi_lwd"]);

/** One row's payrun state, in the payrun's own vocabulary. */
const rowStatus = (r) => ({
  status: r._payrun_status,
  finalized: catalogue.FINAL_STATUSES.has(r._payrun_status),
  label: catalogue.PAYRUN_STATUS_LABEL[r._payrun_status] || null,
});

/** What an export writes in a figure cell of a row that is not finalized. */
const NOT_FINALIZED = "Not finalized";

/**
 * The value an export writes for one cell: a figure of a not-finalized row
 * says so in words, so a blank is never read as a zero salary.
 */
const exportValue = (data, i, field) => {
  const status = data.row_status && data.row_status[i];
  if (status && !status.finalized && Q.isFinalizedFigure(field)) return NOT_FINALIZED;
  return data.rows[i][field.key];
};

class PayrollReportService {
  /**
   * @param reportRepo   repository/payroll_report.js
   * @param templateRepo repository/report_template.js (shared with Employee Master reports)
   * @param deps         { withBrowser } for PDF - injected so tests need no Chrome
   */
  constructor(reportRepo, templateRepo, deps = {}) {
    this.repo = reportRepo;
    this.templates = templateRepo;
    this.withBrowser = deps.withBrowser || ((fn) => require("../services/pdf_browser").withBrowser(fn));
  }

  /* ------------------------------------------------------------- access */

  _has(actor, key) {
    return Boolean(actor && (actor.isAdmin || Q.has(actor.permissions, key)));
  }

  /**
   * The dataset's own keys, repeated here because the route protects a URL
   * and this protects the operation: the same conjunction the Payrun month
   * screen requires, plus the reporting key.
   */
  canReach(actor) {
    return [P.VIEW_REPORTS, P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY].every((k) => this._has(actor, k));
  }

  canExport(actor) {
    return this.canReach(actor) && this._has(actor, P.EXPORT_REPORTS);
  }

  /** The ECR and ESIC files carry full UANs / IP numbers: B3's key as well. */
  canDownloadStatutory(actor) {
    return this.canExport(actor) && this._has(actor, P.VIEW_EMPLOYEE_SENSITIVE);
  }

  _assertReach(actor) {
    if (!this.canReach(actor)) {
      throw new PayrollReportError(403, "DATASET_FORBIDDEN", "You do not have permission to view payroll reports");
    }
  }

  _assertExport(actor) {
    this._assertReach(actor);
    if (!this.canExport(actor)) {
      throw new PayrollReportError(403, "EXPORT_FORBIDDEN", "You do not have permission to export reports");
    }
  }

  _assertStatutory(actor) {
    this._assertExport(actor);
    if (!this.canDownloadStatutory(actor)) {
      throw new PayrollReportError(403, "STATUTORY_FORBIDDEN", "You do not have permission to download statutory files");
    }
  }

  _type(reportType) {
    const type = getReportType(reportType);
    if (!type) throw new PayrollReportError(422, "UNKNOWN_REPORT_TYPE", "That report type is not available");
    return type;
  }

  _userId(actor) {
    const id = Number(actor && actor.userId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PayrollReportError(403, "NO_USER", "Saved layouts need a signed-in user");
    }
    return id;
  }

  /* ---------------------------------------------------------- discovery */

  describe(actor) {
    this._assertReach(actor);
    const fields = Q.discoverFields(actor);
    return {
      report_types: REPORT_TYPE_ORDER.map((k) => ({
        key: k,
        label: REPORT_TYPES[k].label,
        statutory_file: REPORT_TYPES[k].statutory_file || null,
        default_field_keys: Q.defaultFieldKeys(k, actor),
      })),
      groups: catalogue.GROUP_ORDER.map((group) => ({ group, fields: fields.filter((f) => f.group === group) })).filter(
        (g) => g.fields.length > 0
      ),
      sources: catalogue.SOURCE_LABEL,
      esic_reason_codes: Object.entries(statutoryFiles.ESIC_REASON).map(([code, label]) => ({
        code: Number(code),
        label,
        requires_last_working_day: statutoryFiles.ESIC_LWD_REQUIRED.has(Number(code)),
      })),
      max_fields: Q.MAX_FIELDS,
      max_rows: LIMITS.MAX_ROWS,
      max_pdf_rows: LIMITS.MAX_PDF_ROWS,
      can_export: this.canExport(actor),
      can_download_statutory: this.canDownloadStatutory(actor),
    };
  }

  async listMonths(actor, store_ids) {
    this._assertReach(actor);
    const months = await this.repo.listMonths(store_ids);
    return months.map((m) => ({ ...m, label: monthLabel(m.year, m.month) }));
  }

  /* ------------------------------------------------------------ layouts */

  /** Reconcile a stored structure (layout or template) for this actor, now. */
  _reconcile(reportType, structure, actor) {
    const warnings = [];
    let fieldKeys = Q.defaultFieldKeys(reportType, actor);
    if (Array.isArray(structure.field_keys) && structure.field_keys.length) {
      try {
        const resolved = Q.resolveFields(structure.field_keys, actor, "reconcile");
        fieldKeys = resolved.fields.map((f) => f.key);
        warnings.push(...resolved.warnings);
      } catch (err) {
        if (err.name !== "ReportError") throw err;
        warnings.push({ type: "layout_unusable", message: err.message, widens_result_set: false });
      }
    }
    return {
      field_keys: fieldKeys,
      display: Q.resolveDisplay(structure.display, fieldKeys),
      filters: Q.persistableFilters(structure.filters),
      warnings,
    };
  }

  /**
   * The columns this user sees for this report type and month:
   *
   *   1. the layout they saved for THIS month,
   *   2. else their default template for the report type,
   *   3. else the report type's built-in default columns.
   */
  async getLayout(actor, { report_type, year, month }) {
    this._assertReach(actor);
    const type = this._type(report_type);
    const period = Q.periodOf(year, month);
    const userId = this._userId(actor);

    const saved = await this.repo.getLayout({ user_id: userId, report_type: type.key, year: period.year, month: period.month });
    if (saved) {
      return { ...this._reconcile(type.key, saved, actor), template_id: saved.template_id, source: "MONTH", report_type: type.key, year: period.year, month: period.month };
    }

    const defaultId = await this.repo.getDefaultTemplateId({ user_id: userId, report_type: type.key });
    if (defaultId) {
      const template = await this.templates.findById(defaultId);
      if (template && template.dataset_key === type.dataset_key && rules.canSeeTemplate(template, actor)) {
        return {
          ...this._reconcile(type.key, this._templateStructure(template), actor),
          template_id: template.template_id,
          source: "DEFAULT_TEMPLATE",
          report_type: type.key,
          year: period.year,
          month: period.month,
        };
      }
    }

    return {
      ...this._reconcile(type.key, {}, actor),
      template_id: null,
      source: "REPORT_DEFAULT",
      report_type: type.key,
      year: period.year,
      month: period.month,
    };
  }

  /** Save this user's columns for this report type and month. Strict: unknown keys are refused. */
  async saveLayout(actor, body) {
    this._assertReach(actor);
    const type = this._type(body.report_type);
    const period = Q.periodOf(body.year, body.month);
    const userId = this._userId(actor);
    const { fields } = Q.resolveFields(body.field_keys, actor, "strict");
    const fieldKeys = fields.map((f) => f.key);
    let templateId = body.template_id || null;
    if (templateId) {
      const template = await this.templates.findById(templateId);
      if (!template || template.dataset_key !== type.dataset_key || !rules.canSeeTemplate(template, actor)) templateId = null;
    }
    await this.repo.saveLayout({
      user_id: userId,
      report_type: type.key,
      year: period.year,
      month: period.month,
      field_keys: fieldKeys,
      display: Q.resolveDisplay(body.display, fieldKeys),
      filters: Q.persistableFilters(body.filters),
      template_id: templateId,
    });
    return this.getLayout(actor, { report_type: type.key, year: period.year, month: period.month });
  }

  /** Forget this month's layout: the month falls back to the default template / report default. */
  async resetLayout(actor, { report_type, year, month }) {
    this._assertReach(actor);
    const type = this._type(report_type);
    const period = Q.periodOf(year, month);
    await this.repo.deleteLayout({ user_id: this._userId(actor), report_type: type.key, year: period.year, month: period.month });
    return this.getLayout(actor, { report_type: type.key, year: period.year, month: period.month });
  }

  /**
   * COPY COLUMNS FROM PREVIOUS MONTH - the most recent month before this one
   * that this user saved a layout for, copied as this month's layout. Separate
   * from templates: nothing is created in `report_template`.
   */
  async copyPreviousMonth(actor, { report_type, year, month }) {
    this._assertReach(actor);
    const type = this._type(report_type);
    const period = Q.periodOf(year, month);
    const userId = this._userId(actor);
    const previous = await this.repo.findLatestLayoutBefore({ user_id: userId, report_type: type.key, year: period.year, month: period.month });
    if (!previous) {
      throw new PayrollReportError(
        404,
        "NO_PREVIOUS_LAYOUT",
        `No saved ${type.label} layout before ${monthLabel(period.year, period.month)} to copy`
      );
    }
    const structure = this._reconcile(type.key, previous, actor);
    await this.repo.saveLayout({
      user_id: userId,
      report_type: type.key,
      year: period.year,
      month: period.month,
      field_keys: structure.field_keys,
      display: structure.display,
      filters: structure.filters,
      template_id: previous.template_id,
    });
    const layout = await this.getLayout(actor, { report_type: type.key, year: period.year, month: period.month });
    return {
      ...layout,
      warnings: structure.warnings,
      copied_from: { year: previous.year, month: previous.month, label: monthLabel(previous.year, previous.month) },
    };
  }

  /* ---------------------------------------------------------- templates */

  /** A template stores STRUCTURE: columns in order, display, reusable filters. Never a value. */
  _templateStructure(template) {
    const stored = template.filters || {};
    return {
      field_keys: template.field_keys || [],
      display: stored.display || {},
      filters: { outlet_ids: stored.outlet_ids, department_ids: stored.department_ids, pay_type: stored.pay_type },
    };
  }

  _typeOfDataset(datasetKey) {
    const key = REPORT_TYPE_ORDER.find((k) => REPORT_TYPES[k].dataset_key === datasetKey);
    return key ? REPORT_TYPES[key] : null;
  }

  async _loadFor(templateId, actor, verb) {
    this._assertReach(actor);
    const template = await this.templates.findById(templateId);
    if (!template || !DATASET_KEYS.includes(template.dataset_key)) throw notFound();
    if (!rules.canSeeTemplate(template, actor)) throw notFound();
    const permitted = rules.templatePermissions(template, actor);
    if (!permitted[verb]) {
      if (verb === "canRun") throw notFound();
      throw new PayrollReportError(
        403,
        "TEMPLATE_FORBIDDEN",
        rules.kindOf(template) === rules.TEMPLATE_KIND.SYSTEM
          ? "Built-in templates cannot be changed. Use Duplicate to make your own version."
          : "This template belongs to somebody else. Use Duplicate to make your own version."
      );
    }
    return template;
  }

  _assertMayShare(isShared, actor) {
    if (!isShared) return;
    if (this._has(actor, P.MANAGE_SHARED_REPORT_TEMPLATES)) return;
    throw new PayrollReportError(403, "SHARING_FORBIDDEN", "You do not have permission to share a template with other users");
  }

  _definition(body, actor) {
    const type = this._type(body.report_type);
    const { fields } = Q.resolveFields(body.field_keys, actor, "strict");
    const fieldKeys = fields.map((f) => f.key);
    return {
      type,
      dataset_key: type.dataset_key,
      field_keys: fieldKeys,
      filters: { ...Q.persistableFilters(body.filters), display: Q.resolveDisplay(body.display, fieldKeys) },
    };
  }

  async _present(template, actor, defaults) {
    const type = this._typeOfDataset(template.dataset_key);
    const structure = this._reconcile(type.key, this._templateStructure(template), actor);
    return {
      template_id: template.template_id,
      template_name: template.template_name,
      report_type: type.key,
      field_keys: structure.field_keys,
      display: structure.display,
      filters: structure.filters,
      warnings: structure.warnings,
      is_shared: Number(template.is_shared),
      is_system: Number(template.is_system),
      is_default: defaults[type.key] === template.template_id,
      permissions: rules.templatePermissions(template, actor),
      updated_at: template.updated_at,
    };
  }

  async listTemplates(actor, reportType) {
    this._assertReach(actor);
    const type = this._type(reportType);
    const rows = await this.templates.listVisible(type.dataset_key, actor);
    const defaults = actor && actor.userId ? await this.repo.listDefaultTemplateIds(actor.userId) : {};
    const visible = rows.filter((t) => rules.canSeeTemplate(t, actor));
    return Promise.all(visible.map((t) => this._present(t, actor, defaults)));
  }

  async _presentOne(templateId, actor) {
    const defaults = await this.repo.listDefaultTemplateIds(this._userId(actor));
    return this._present(await this.templates.findById(templateId), actor, defaults);
  }

  async createTemplate(actor, body) {
    this._assertReach(actor);
    const definition = this._definition(body, actor);
    this._assertMayShare(body.is_shared, actor);
    const id = await this.templates.create({
      template_name: String(body.template_name || "").trim().slice(0, 120),
      dataset_key: definition.dataset_key,
      field_keys: definition.field_keys,
      filters: definition.filters,
      owner_user_id: this._userId(actor),
      is_shared: body.is_shared ? 1 : 0,
    });
    if (body.set_default) await this.repo.setDefaultTemplate({ user_id: actor.userId, report_type: definition.type.key, template_id: id });
    return this._presentOne(id, actor);
  }

  /** Update Template: overwrite its structure (and optionally its name) with the current layout. */
  async updateTemplate(actor, templateId, body) {
    const template = await this._loadFor(templateId, actor, "canEdit");
    const definition = this._definition({ ...body, report_type: this._typeOfDataset(template.dataset_key).key }, actor);
    const isShared = body.is_shared === undefined ? Number(template.is_shared) === 1 : Boolean(body.is_shared);
    if (isShared && Number(template.is_shared) !== 1) this._assertMayShare(true, actor);
    await this.templates.update(templateId, {
      template_name: String(body.template_name || template.template_name).trim().slice(0, 120),
      field_keys: definition.field_keys,
      filters: definition.filters,
      is_shared: isShared ? 1 : 0,
    });
    return this._presentOne(templateId, actor);
  }

  async renameTemplate(actor, templateId, name) {
    const template = await this._loadFor(templateId, actor, "canEdit");
    const clean = String(name || "").trim().slice(0, 120);
    if (!clean) throw new PayrollReportError(422, "NAME_REQUIRED", "Enter a template name");
    await this.templates.update(templateId, {
      template_name: clean,
      field_keys: template.field_keys,
      filters: template.filters,
      is_shared: template.is_shared,
    });
    return this._presentOne(templateId, actor);
  }

  async duplicateTemplate(actor, templateId, name) {
    const template = await this._loadFor(templateId, actor, "canCopy");
    const copy = rules.buildCopy(template, { ...actor, userId: this._userId(actor) }, name);
    const id = await this.templates.create(copy);
    return this._presentOne(id, actor);
  }

  async deleteTemplate(actor, templateId) {
    await this._loadFor(templateId, actor, "canDelete");
    await this.templates.remove(templateId);
    await this.repo.clearDefaultsForTemplate(templateId);
    return true;
  }

  /** Set as Default (per user and report type), or clear it with `template_id: null`. */
  async setDefaultTemplate(actor, { report_type, template_id }) {
    this._assertReach(actor);
    const type = this._type(report_type);
    const userId = this._userId(actor);
    if (template_id === null || template_id === undefined) {
      await this.repo.clearDefaultTemplate({ user_id: userId, report_type: type.key });
      return { report_type: type.key, template_id: null };
    }
    const template = await this._loadFor(template_id, actor, "canRun");
    if (template.dataset_key !== type.dataset_key) {
      throw new PayrollReportError(422, "TEMPLATE_TYPE_MISMATCH", `That template is not a ${type.label} template`);
    }
    await this.repo.setDefaultTemplate({ user_id: userId, report_type: type.key, template_id: template.template_id });
    return { report_type: type.key, template_id: template.template_id };
  }

  /* --------------------------------------------------------------- data */

  _request(actor, body) {
    const type = this._type(body.report_type);
    const period = Q.periodOf(body.year, body.month);
    const { fields } = Q.resolveFields(
      Array.isArray(body.field_keys) && body.field_keys.length ? body.field_keys : Q.defaultFieldKeys(type.key, actor),
      actor,
      "strict"
    );
    const filters = Q.resolveFilters(body.filters);
    const display = Q.resolveDisplay(body.display, fields.map((f) => f.key));
    return { type, period, fields, filters, display };
  }

  /**
   * The statutory status columns, computed ONCE for the month and scope -
   * never per row, never per field - and only when one of them is selected.
   */
  async _postContext(req, store_ids) {
    const needs = new Set(req.fields.filter((f) => f.post && STATUTORY_POST.has(f.post)).map((f) => f.post));
    const ctx = { period: req.period };
    if (needs.size === 0) return ctx;
    const rows = await this.repo.listStatutoryRows({ year: req.period.year, month: req.period.month, store_ids });
    if (needs.has("epf_validation")) ctx.epf = this._epf(rows, req.period);
    if (needs.has("esi_validation") || needs.has("esi_reason") || needs.has("esi_lwd")) ctx.esi = this._esi(rows, req.period, {});
    return ctx;
  }

  _post(ctx) {
    return (field, row) => {
      const id = Number(row._employee_id);
      switch (field.post) {
        case "period":
          return monthLabel(ctx.period.year, ctx.period.month);
        case "epf_validation":
          return ctx.epf ? statutoryFiles.statusText(ctx.epf, id) || "Not a PF member" : null;
        case "esi_validation":
          return ctx.esi ? statutoryFiles.statusText(ctx.esi, id) || "Not ESI covered" : null;
        case "esi_reason": {
          const r = ctx.esi && ctx.esi.reasons.get(id);
          if (!r || r.reason_code === null) return r ? "Missing" : null;
          return r.reason_code === 0 ? null : `${r.reason_code} - ${statutoryFiles.ESIC_REASON[r.reason_code]}`;
        }
        case "esi_lwd": {
          const r = ctx.esi && ctx.esi.reasons.get(id);
          return r && r.last_working_day ? r.last_working_day : null;
        }
        default:
          return null;
      }
    };
  }

  async preview(actor, body, store_ids) {
    this._assertReach(actor);
    const req = this._request(actor, body);
    const pageSize = Math.min(positiveInt(body.page_size, LIMITS.PAGE_SIZE), LIMITS.MAX_PAGE_SIZE);
    const page = positiveInt(body.page, 1);
    const args = { reportType: req.type.key, fields: req.fields, filters: req.filters, period: req.period, store_ids, display: req.display };

    const count = Q.buildQuery({ ...args, mode: "count" });
    const rowsQ = Q.buildQuery({ ...args, mode: "rows", limit: pageSize, offset: (page - 1) * pageSize });
    const totalsQ = req.display.show_totals ? Q.buildQuery({ ...args, mode: "totals" }) : null;

    const [countRows, rows, totalRows, ctx, reconciliation] = await Promise.all([
      this.repo.query(count.sql, count.params),
      this.repo.query(rowsQ.sql, rowsQ.params),
      totalsQ ? this.repo.query(totalsQ.sql, totalsQ.params) : Promise.resolve(null),
      this._postContext(req, store_ids),
      req.type.key === REPORT_TYPES.PAYROLL_REGISTER.key ? this._payrunReconciliation(req.period, store_ids) : Promise.resolve(null),
    ]);

    const post = this._post(ctx);
    const counted = countRows.length ? countRows[0] : {};
    const matching = Number(counted.matching_count) || 0;
    return {
      report_type: req.type.key,
      period: { year: req.period.year, month: req.period.month, label: monthLabel(req.period.year, req.period.month) },
      columns: Q.columnsOf(req.fields),
      rows: rows.map((r) => Q.presentRow(r, req.fields, post)),
      // Per row, parallel to `rows`: is this payrun row finalized, and if not
      // what it is. Never an export column - the screen marks the row.
      row_status: rows.map(rowStatus),
      // Which columns are payroll figures - the ones a not-finalized row
      // shows as "Not finalized" rather than as an empty (or zero-looking) cell.
      figure_keys: req.fields.filter(Q.isFinalizedFigure).map((f) => f.key),
      totals: totalRows ? Q.presentTotals(totalRows[0], req.fields) : null,
      display: req.display,
      filters: req.filters,
      matching_count: matching,
      // Payrun employees IN this report whose figures are blank because their
      // month is not approved & locked. They are listed, not dropped.
      not_finalized_count: matching - (Number(counted.finalized_count) || 0),
      reconciliation,
      page,
      page_size: pageSize,
      statutory: ctx.epf ? { summary: ctx.epf.summary } : ctx.esi ? { summary: ctx.esi.summary } : null,
    };
  }

  /**
   * PAYROLL REGISTER == FINALIZED PAYRUN, for the month and the caller's scope.
   *
   * Two independent reads that must agree: the payrun's own totals, straight
   * from `payrun_employee` + its approved calculations
   * (`repository/payroll_report.js#payrunTotals`), and the Payroll Register
   * as the report builder produces it (no user filters, same scope). The
   * screen shows the result; a mismatch is reported, never hidden.
   */
  async _payrunReconciliation(period, store_ids) {
    const fields = ["gross_salary", "total_deductions", "net_pay"].map((k) => catalogue.getField(k));
    const args = {
      reportType: REPORT_TYPES.PAYROLL_REGISTER.key,
      fields,
      filters: Q.resolveFilters({}),
      period,
      store_ids,
      display: Q.resolveDisplay({}),
    };
    const count = Q.buildQuery({ ...args, mode: "count" });
    const totals = Q.buildQuery({ ...args, mode: "totals" });
    const [payrun, [reportCount], [reportTotals]] = await Promise.all([
      this.repo.payrunTotals({ year: period.year, month: period.month, store_ids }),
      this.repo.query(count.sql, count.params),
      this.repo.query(totals.sql, totals.params),
    ]);
    const t = Q.presentTotals(reportTotals, fields);
    const report = {
      employees: Number(reportCount && reportCount.matching_count) || 0,
      finalized: Number(reportCount && reportCount.finalized_count) || 0,
      gross: t.gross_salary,
      deductions: t.total_deductions,
      net_pay: t.net_pay,
    };
    const same = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
    return {
      payrun,
      report,
      reconciled:
        payrun.employees === report.employees &&
        payrun.finalized === report.finalized &&
        same(payrun.gross, report.gross) &&
        same(payrun.deductions, report.deductions) &&
        same(payrun.net_pay, report.net_pay),
    };
  }

  /** Every row of the report - the full eligible population, not one page. */
  async _allRows(actor, body, store_ids, cap) {
    const req = this._request(actor, body);
    const args = { reportType: req.type.key, fields: req.fields, filters: req.filters, period: req.period, store_ids, display: req.display };
    const count = Q.buildQuery({ ...args, mode: "count" });
    const [countRow] = await this.repo.query(count.sql, count.params);
    const matching = countRow ? Number(countRow.matching_count) : 0;
    if (matching > cap) {
      throw new PayrollReportError(422, "TOO_MANY_ROWS", `This report has ${matching} rows; the limit for this format is ${cap}. Narrow the filters.`, {
        matching_count: matching,
        max_rows: cap,
      });
    }
    const rowsQ = Q.buildQuery({ ...args, mode: "rows" });
    const totalsQ = req.display.show_totals ? Q.buildQuery({ ...args, mode: "totals" }) : null;
    const [rows, totalRows, ctx] = await Promise.all([
      this.repo.query(rowsQ.sql, rowsQ.params),
      totalsQ ? this.repo.query(totalsQ.sql, totalsQ.params) : Promise.resolve(null),
      this._postContext(req, store_ids),
    ]);
    const post = this._post(ctx);
    return {
      ...req,
      rows: rows.map((r) => Q.presentRow(r, req.fields, post)),
      row_status: rows.map(rowStatus),
      totals: totalRows ? Q.presentTotals(totalRows[0], req.fields) : null,
      not_finalized_count: matching - (Number(countRow && countRow.finalized_count) || 0),
    };
  }

  _filename(type, period, ext) {
    const label = type.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${label}_${MONTH_SHORT[period.month - 1]}-${period.year}.${ext}`;
  }

  /** Excel: the selected columns, in the selected order, for the full population. */
  async exportXlsx(actor, body, store_ids) {
    this._assertExport(actor);
    const data = await this._allRows(actor, body, store_ids, LIMITS.MAX_ROWS);
    const buffer = await buildWorkbook(data);
    await this._audit(actor, data, "xlsx", body.template_id);
    return { buffer, filename: this._filename(data.type, data.period, "xlsx"), row_count: data.rows.length };
  }

  /** PDF: the same columns, order, month and filters as Excel. */
  async exportPdf(actor, body, store_ids) {
    this._assertExport(actor);
    const data = await this._allRows(actor, body, store_ids, LIMITS.MAX_PDF_ROWS);
    const html = buildPdfHtml(data);
    const landscape = data.fields.length > 7;
    const buffer = await this.withBrowser((session) =>
      session.renderPdf(html, {
        format: "A4",
        landscape,
        printBackground: true,
        margin: { top: "8mm", right: "8mm", bottom: "10mm", left: "8mm" },
      })
    );
    await this._audit(actor, data, "pdf", body.template_id);
    return { buffer, filename: this._filename(data.type, data.period, "pdf"), row_count: data.rows.length };
  }

  async _audit(actor, data, format, templateId) {
    try {
      await this.templates.logExport({
        dataset_key: data.type ? data.type.dataset_key : data.dataset_key,
        user_id: actor && actor.userId,
        employee_id: actor && actor.employeeId,
        field_keys: data.fields ? data.fields.map((f) => f.key) : data.field_keys,
        filters: { ...(data.filters || {}), period: `${data.period.year}-${String(data.period.month).padStart(2, "0")}` },
        row_count: data.rows ? data.rows.length : data.row_count,
        format,
        sensitive_fields_included: data.fields ? data.fields.some((f) => f.sensitive) : true,
        template_id: templateId || null,
      });
    } catch (err) {
      // The file has been built; a failed audit row is logged by the
      // repository and must not turn a delivered export into an error.
    }
  }

  /* ------------------------------------------------------ statutory files */

  _epf(rows, period) {
    return statutoryFiles.validateEpf({
      period,
      rows: rows.map((r) => ({ employee: r.employee, calculation: r.calculation, live_uan: r.live_uan })),
    });
  }

  _esi(rows, period, overrides) {
    return statutoryFiles.validateEsi({
      period,
      overrides,
      rows: rows.map((r) => ({ employee: r.employee, calculation: r.calculation, live_ip: r.live_ip })),
    });
  }

  _overrides(list) {
    const out = {};
    for (const o of Array.isArray(list) ? list : []) {
      const id = Number(o && o.employee_id);
      if (Number.isSafeInteger(id) && id > 0) out[id] = { reason_code: o.reason_code, last_working_day: o.last_working_day || null };
    }
    return out;
  }

  _presentValidation(kind, period, v) {
    return {
      kind,
      period: { year: period.year, month: period.month, label: monthLabel(period.year, period.month) },
      summary: v.summary,
      blocked: v.blocked,
      totals: v.totals,
    };
  }

  async epfValidation(actor, { year, month }, store_ids) {
    this._assertReach(actor);
    const period = Q.periodOf(year, month);
    const rows = await this.repo.listStatutoryRows({ year: period.year, month: period.month, store_ids });
    return this._presentValidation("EPF", period, this._epf(rows, period));
  }

  async esiValidation(actor, { year, month, overrides }, store_ids) {
    this._assertReach(actor);
    const period = Q.periodOf(year, month);
    const rows = await this.repo.listStatutoryRows({ year: period.year, month: period.month, store_ids });
    return this._presentValidation("ESI", period, this._esi(rows, period, this._overrides(overrides)));
  }

  /**
   * A STATUTORY FILE IS ALL OR NOTHING. If any employee who belongs in the
   * statutory population is blocked, the file is refused (409, with the
   * Ready / Blocked counts and every blocked employee and reason) until the
   * issues are resolved. There is no "ready employees only" path: a
   * statutory submission never omits a member, silently or on request.
   */
  _gate(validation) {
    if (validation.summary.blocked > 0) {
      throw new PayrollReportError(
        409,
        "BLOCKED_EMPLOYEES",
        `${validation.summary.blocked} employee(s) are blocked. Resolve every blocked employee before the file can be generated.`,
        { summary: validation.summary, blocked: validation.blocked }
      );
    }
    if (validation.summary.ready === 0) {
      throw new PayrollReportError(422, "NOTHING_READY", "No employee is in the statutory population for this month", {
        summary: validation.summary,
        blocked: validation.blocked,
      });
    }
  }

  async ecrFile(actor, { year, month }, store_ids) {
    this._assertStatutory(actor);
    const period = Q.periodOf(year, month);
    const rows = await this.repo.listStatutoryRows({ year: period.year, month: period.month, store_ids });
    const v = this._epf(rows, period);
    this._gate(v);
    await this._audit(actor, { dataset_key: REPORT_TYPES.EPF.dataset_key, field_keys: ["EPFO_ECR"], period, filters: {}, row_count: v.summary.ready }, "ecr");
    return {
      buffer: Buffer.from(v.text, "utf8"),
      filename: `ECR_${MONTH_SHORT[period.month - 1]}-${period.year}.txt`,
      summary: v.summary,
    };
  }

  async esicFile(actor, { year, month, overrides }, store_ids) {
    this._assertStatutory(actor);
    const period = Q.periodOf(year, month);
    const rows = await this.repo.listStatutoryRows({ year: period.year, month: period.month, store_ids });
    const v = this._esi(rows, period, this._overrides(overrides));
    this._gate(v);
    const buffer = statutoryFiles.buildEsicXls(v);
    await this._audit(actor, { dataset_key: REPORT_TYPES.ESI.dataset_key, field_keys: ["ESIC_MC"], period, filters: {}, row_count: v.summary.ready }, "esic");
    return {
      buffer,
      filename: `ESIC_Contribution_${MONTH_SHORT[period.month - 1]}-${period.year}.xls`,
      summary: v.summary,
    };
  }
}

/* ============================================================== rendering */

/** Text a spreadsheet must never evaluate: a leading = + - @ is neutralised. */
const safeText = (v) => {
  const t = String(v);
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
};

const cellValue = (field, v) => {
  if (v === null || v === undefined || v === "") return null;
  if ((field.type === catalogue.TYPE.AMOUNT || field.type === catalogue.TYPE.NUMBER) && Number.isFinite(Number(v))) return Number(v);
  return safeText(v);
};

const describeFilters = (filters) => {
  const parts = [];
  if (filters.outlet_ids && filters.outlet_ids.length) parts.push(`${filters.outlet_ids.length} outlet(s)`);
  if (filters.department_ids && filters.department_ids.length) parts.push(`${filters.department_ids.length} department(s)`);
  if (filters.pay_type) parts.push(`Pay type ${filters.pay_type}`);
  if (filters.search) parts.push(`Search "${filters.search}"`);
  return parts.length ? parts.join(", ") : "None";
};

/** What the figures are, said on the file itself - including any row whose figures are blank. */
const provenance = (data) =>
  data.not_finalized_count
    ? `Finalized payrun data. ${data.not_finalized_count} payrun employee(s) are not approved & locked: listed with blank figures.`
    : "Finalized payrun data.";

async function buildWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(data.type.label.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
  ws.addRow([`${data.type.label} - ${monthLabel(data.period.year, data.period.month)}`]).font = { bold: true, size: 13 };
  ws.addRow([`${provenance(data)} Filters: ${safeText(describeFilters(data.filters))}. Rows: ${data.rows.length}.`]);
  ws.addRow([]);
  const header = ws.addRow(data.fields.map((f) => f.label));
  header.font = { bold: true };
  data.rows.forEach((row, i) => ws.addRow(data.fields.map((f) => cellValue(f, exportValue(data, i, f)))));
  if (data.totals) {
    const totals = ws.addRow(data.fields.map((f, i) => (i === 0 ? "Total" : f.key in data.totals ? data.totals[f.key] : null)));
    totals.font = { bold: true };
  }
  data.fields.forEach((f, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(Math.max(f.label.length + 2, 12), 40);
    if (f.type === catalogue.TYPE.AMOUNT) col.numFmt = "#,##0.00";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const escapeHtml = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmt = (field, v) => {
  if (v === null || v === undefined || v === "") return "";
  if (field.type === catalogue.TYPE.AMOUNT && Number.isFinite(Number(v))) {
    return Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return v;
};

function buildPdfHtml(data) {
  const numeric = (f) => f.type === catalogue.TYPE.AMOUNT || f.type === catalogue.TYPE.NUMBER;
  const th = data.fields.map((f) => `<th class="${numeric(f) ? "n" : ""}">${escapeHtml(f.label)}</th>`).join("");
  const body = data.rows
    .map((row, i) => `<tr>${data.fields.map((f) => `<td class="${numeric(f) ? "n" : ""}">${escapeHtml(fmt(f, exportValue(data, i, f)))}</td>`).join("")}</tr>`)
    .join("");
  const totals = data.totals
    ? `<tr class="t">${data.fields
        .map((f, i) => `<td class="${numeric(f) ? "n" : ""}">${i === 0 ? "Total" : f.key in data.totals ? escapeHtml(fmt(f, data.totals[f.key])) : ""}</td>`)
        .join("")}</tr>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,Helvetica,sans-serif;font-size:${data.fields.length > 12 ? 7 : 8.5}px;color:#111}
h1{font-size:13px;margin:0 0 2px} .m{color:#555;margin:0 0 8px}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #bbb;padding:3px 4px;vertical-align:top}
th{background:#eee;text-align:left} .n{text-align:right} tr.t td{font-weight:bold;background:#f6f6f6}
thead{display:table-header-group} tr{page-break-inside:avoid}
</style></head><body>
<h1>${escapeHtml(data.type.label)} - ${escapeHtml(monthLabel(data.period.year, data.period.month))}</h1>
<p class="m">${escapeHtml(provenance(data))} Filters: ${escapeHtml(describeFilters(data.filters))}. Rows: ${data.rows.length}.</p>
<table><thead><tr>${th}</tr></thead><tbody>${body}${totals}</tbody></table>
</body></html>`;
}

module.exports = (reportRepo, templateRepo, deps) => new PayrollReportService(reportRepo, templateRepo, deps);
module.exports.PayrollReportService = PayrollReportService;
module.exports.buildWorkbook = buildWorkbook;
module.exports.buildPdfHtml = buildPdfHtml;
module.exports.LIMITS = LIMITS;
