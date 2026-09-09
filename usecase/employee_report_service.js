const resolver = require("./employee_report");
const rules = require("./report_template_rules");
const catalogue = require("../constants/employee_report_catalogue");
const reportConfig = require("../config/reports");
const { DATASET, isEnabledDataset } = require("../constants/report_datasets");
const P = require("../constants/hr_permissions");

/**
 * Reports — the Employee Master service.
 *
 * The layer between the routes and everything else. It owns four things and
 * deliberately no more:
 *
 *   1. RECONCILING a saved template against what exists right now.
 *   2. Running the ONE query - as a count, as a page, or as a stream.
 *   3. The template CRUD verbs, each gated by `report_template_rules`.
 *   4. Writing the export audit row.
 *
 * ===================================== THE INVARIANT THIS FILE PROTECTS ===
 *
 * `preview.matching_count` and the number of rows an export produces are the
 * same number, for the same caller, fields and filters. That holds because
 * both come from `resolver.buildQuery` with the SAME resolved filters - the
 * count is literally the same builder called with `count: true`. There is no
 * second WHERE clause anywhere in Reports, and a test asserts the parity for
 * Active, Inactive and All.
 *
 * The one thing that can break the equality is the row cap, and it does so
 * LOUDLY: an export over `MAX_ROWS` is refused outright rather than truncated,
 * because a silently short spreadsheet is worse than no spreadsheet.
 *
 * ------------------------------------------------------------------ LOGGING
 * Nothing in this file logs a row, a field value, a name, a mobile number or a
 * filter's search text. Counts, ids and field KEYS only. The export audit row
 * records the shape of what left the building, never its contents.
 */

const ROW_CAP_CODE = "TOO_MANY_ROWS";

class ReportError extends Error {
  constructor(httpCode, code, message, detail = {}) {
    super(message);
    this.name = "ReportError";
    this.httpCode = httpCode;
    this.code = code;
    this.detail = detail;
  }
}

const notFound = () =>
  // One message for "does not exist" and for "not yours". Telling somebody a
  // template id is real but belongs to a colleague is itself a disclosure.
  new ReportError(404, "TEMPLATE_NOT_FOUND", "That report was not found");

class EmployeeReportService {
  /**
   * @param employeeRepo anything with `.query(sql, params, cb)` - the shared
   *                     pool - used for the report query itself.
   * @param templateRepo repository/report_template.js
   */
  constructor(db, templateRepo) {
    this.db = db;
    this.templates = templateRepo;
  }

  _query(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  /* ---------------------------------------------------------- discovery */

  /**
   * Refuse anyone who may not reach this dataset at all.
   *
   * A 403 rather than a 404: unlike a template id, the existence of the
   * Employee Master dataset is not a secret, and pretending it is absent would
   * send somebody hunting for a bug instead of asking for the permission.
   */
  _assertDataset(actor) {
    if (this.canReachDataset(actor)) return;
    throw new ReportError(
      403,
      "DATASET_FORBIDDEN",
      "You do not have permission to report on employees"
    );
  }

  /** The field catalogue as this caller may see it, grouped for the picker. */
  describe(actor) {
    this._assertDataset(actor);
    const fields = resolver.discoverFields(actor);
    return {
      dataset_key: DATASET.EMPLOYEE_MASTER,
      groups: catalogue.GROUP_ORDER.map((group) => ({
        group,
        fields: fields.filter((f) => f.group === group),
      })).filter((g) => g.fields.length > 0),
      max_fields: reportConfig.MAX_FIELDS,
      max_rows: reportConfig.MAX_ROWS,
      can_export: this.canExport(actor),
    };
  }

  /**
   * The dataset's OWN permission, which every verb here needs before its own.
   *
   * `view_reports` says somebody may use the reporting machinery; it says
   * nothing about which data they may point it at. The Employee Master dataset
   * is HR's, so reaching it through Reports requires the same key that guards
   * the HR directory. The routes enforce this too, with `requireAll`; it is
   * repeated here because the route protects a URL and this protects the
   * operation, and only one of the two survives a future call site.
   */
  canReachDataset(actor) {
    if (actor && actor.isAdmin) return true;
    return resolver.has(actor && actor.permissions, P.VIEW_EMPLOYEES);
  }

  canExport(actor) {
    if (actor && actor.isAdmin) return true;
    // AND, not OR: the prerequisite is not satisfied by the verb.
    return (
      this.canReachDataset(actor) &&
      resolver.has(actor && actor.permissions, P.EXPORT_REPORTS)
    );
  }

  /* --------------------------------------------------------- templates */

  async listTemplates(actor) {
    this._assertDataset(actor);
    const rows = await this.templates.listVisible(DATASET.EMPLOYEE_MASTER, actor);
    return rows
      .filter((t) => rules.canSeeTemplate(t, actor))
      .map((t) => ({
        template_id: t.template_id,
        template_name: t.template_name,
        dataset_key: t.dataset_key,
        field_keys: t.field_keys,
        filters: t.filters,
        is_shared: t.is_shared,
        is_system: t.is_system,
        owner_user_id: t.owner_user_id,
        permissions: rules.templatePermissions(t, actor),
        updated_at: t.updated_at,
      }));
  }

  /** Load a template and assert the verb the caller wants to use on it. */
  async _loadFor(templateId, actor, verb) {
    // Every template verb funnels through here, so the dataset prerequisite is
    // stated once rather than repeated on each of the five.
    this._assertDataset(actor);
    const template = await this.templates.findById(templateId);
    if (!template) throw notFound();
    if (!rules.canSeeTemplate(template, actor)) throw notFound();

    const permitted = rules.templatePermissions(template, actor);
    if (!permitted[verb]) {
      if (verb === "canRun") throw notFound();
      throw new ReportError(
        403,
        "TEMPLATE_FORBIDDEN",
        rules.kindOf(template) === rules.TEMPLATE_KIND.SYSTEM
          ? "Built-in reports cannot be changed. Use Save a Copy to make your own version."
          : "This report belongs to somebody else. Use Save a Copy to make your own version."
      );
    }
    return template;
  }

  /**
   * Validate what a caller wants to save.
   *
   * Fields are checked in STRICT mode here - saving a template naming a field
   * you cannot use should fail now, not silently produce a template that
   * reconciles away to nothing every time it runs.
   */
  _validateDefinition(body, actor) {
    this._assertDataset(actor);
    const datasetKey = body.dataset_key || DATASET.EMPLOYEE_MASTER;
    if (!isEnabledDataset(datasetKey)) {
      throw new ReportError(422, "UNKNOWN_DATASET", "That report type is not available");
    }

    const { fields } = resolver.resolveFields(body.field_keys, actor, "strict");
    const filters = resolver.resolveFilters(body.filters, actor);

    return {
      dataset_key: datasetKey,
      // Stored in the caller's order, which IS the column order.
      field_keys: fields.map((f) => f.key),
      // Keys and values, never the catalogue entries the resolver works with:
      // a template stores an instruction, and re-reads the catalogue on every
      // run rather than carrying a stale copy of it.
      filters: resolver.persistableFilters(filters),
    };
  }

  _assertMayShare(isShared, actor) {
    if (!isShared) return;
    if (actor && actor.isAdmin) return;
    if (resolver.has(actor && actor.permissions, P.MANAGE_SHARED_REPORT_TEMPLATES)) return;
    throw new ReportError(
      403,
      "SHARING_FORBIDDEN",
      "You do not have permission to share a report with other users"
    );
  }

  async createTemplate(body, actor) {
    const definition = this._validateDefinition(body, actor);
    this._assertMayShare(body.is_shared, actor);

    const templateId = await this.templates.create({
      ...definition,
      template_name: String(body.template_name || "").trim().slice(0, 120),
      owner_user_id: actor.userId,
      is_shared: body.is_shared ? 1 : 0,
    });
    return this.templates.findById(templateId);
  }

  async updateTemplate(templateId, body, actor) {
    await this._loadFor(templateId, actor, "canEdit");
    const definition = this._validateDefinition(body, actor);
    this._assertMayShare(body.is_shared, actor);

    await this.templates.update(templateId, {
      ...definition,
      template_name: String(body.template_name || "").trim().slice(0, 120),
      is_shared: body.is_shared ? 1 : 0,
    });
    return this.templates.findById(templateId);
  }

  async deleteTemplate(templateId, actor) {
    await this._loadFor(templateId, actor, "canDelete");
    return this.templates.remove(templateId);
  }

  /**
   * Save a Copy. The copy is always a fresh PERSONAL template owned by whoever
   * copied it, whatever the original was - which is what makes system
   * templates safely read-only rather than merely inconvenient.
   */
  async copyTemplate(templateId, name, actor) {
    const template = await this._loadFor(templateId, actor, "canCopy");
    const copy = rules.buildCopy(template, actor, name);
    const newId = await this.templates.create(copy);
    return this.templates.findById(newId);
  }

  /* --------------------------------------------------- reconciliation */

  /**
   * Turn a saved template into something runnable NOW.
   *
   * Fields are reconciled in "reconcile" mode - a template is an instruction,
   * not a promise that everything in it still exists - and each lookup filter
   * is checked against the master it points at. The warnings that come back
   * carry `widens_result_set`, which is what the export gate reads.
   */
  async reconcile(template, actor) {
    const warnings = [];

    const { fields, warnings: fieldWarnings } = resolver.resolveFields(
      template.field_keys,
      actor,
      "reconcile"
    );
    warnings.push(...fieldWarnings);

    const saved = template.filters || {};
    const filters = { status: "active", outlet_ids: [], department_ids: [], designation_ids: [], search: "" };

    const status = rules.reconcileStatus(saved.status, resolver.STATUS_VALUES);
    filters.status = status.value;
    warnings.push(...status.warnings);

    const LOOKUPS = [
      { kind: "outlet", key: "outlet_ids", field: "outlet_ids", label: "Outlet" },
      { kind: "department", key: "department_ids", field: "department_ids", label: "Department" },
      { kind: "designation", key: "designation_ids", field: "designation_ids", label: "Designation" },
    ];

    for (const lookup of LOOKUPS) {
      const savedIds = Array.isArray(saved[lookup.key]) ? saved[lookup.key] : [];
      if (savedIds.length === 0) continue;

      const { resolvable, active } = await this.templates.resolveLookupIds(lookup.kind, savedIds);
      const result = rules.reconcileLookupFilter(savedIds, resolvable, active, {
        field: lookup.field,
        label: lookup.label,
      });
      filters[lookup.key] = result.values;
      warnings.push(...result.warnings);
    }

    filters.search = String(saved.search || "").trim().slice(0, 100);

    // The per-field filters a saved report carries. Reconciled rather than
    // refused, for the same reason the fields are: a template is an
    // instruction, not a promise that its author's permissions are still
    // yours. A filter dropped this way WIDENS the result - the warning says
    // so, and the export path already makes a widening warning
    // acknowledgeable before anything leaves the building.
    const perField = resolver.resolveFieldFilters(saved.field_filters, actor, "reconcile");
    warnings.push(...perField.warnings);
    for (const [key, value] of Object.entries(perField.mapped)) {
      // A saved report expressing its outlet or status filter as a field
      // filter lands on the same key the block above populated.
      filters[key] = value;
    }
    filters.field_filters = perField.field_filters.filter((f) => !f.mapped_to);

    return { fields, filters, warnings };
  }

  /**
   * The single entry point that turns a REQUEST - either a saved template id
   * or an ad-hoc field list - into resolved fields, filters and warnings.
   *
   * Both paths converge here, so preview and export cannot resolve a request
   * two different ways.
   */
  async resolveRequest(body, actor) {
    if (body.template_id !== undefined && body.template_id !== null && body.template_id !== "") {
      const template = await this._loadFor(body.template_id, actor, "canRun");
      const resolved = await this.reconcile(template, actor);

      // An ad-hoc override on top of a saved template - the user changed a
      // filter in the UI before running it. The override replaces the saved
      // filter wholesale and is validated strictly, so it cannot smuggle a
      // stale value past reconciliation.
      if (body.filters !== undefined && body.filters !== null) {
        resolved.filters = resolver.resolveFilters(body.filters, actor);
        // Reconciliation warnings about filters no longer apply once the user
        // has replaced the filters; field warnings still do.
        resolved.warnings = resolved.warnings.filter((w) => !String(w.type).startsWith("filter_"));
      }
      if (Array.isArray(body.field_keys) && body.field_keys.length > 0) {
        const override = resolver.resolveFields(body.field_keys, actor, "strict");
        resolved.fields = override.fields;
        resolved.warnings = resolved.warnings.filter((w) => w.type !== "field_unavailable");
      }
      return { ...resolved, template };
    }

    const { fields } = resolver.resolveFields(body.field_keys, actor, "strict");
    return {
      fields,
      filters: resolver.resolveFilters(body.filters, actor),
      // An ad-hoc request has nothing saved to go stale, so nothing to warn
      // about and nothing to acknowledge.
      warnings: [],
      template: null,
    };
  }

  /* -------------------------------------------------------------- running */

  async count(fields, filters, actor) {
    const { sql, params } = resolver.buildQuery(fields, filters, { count: true, actor });
    const rows = await this._query(sql, params);
    return rows.length ? Number(rows[0].matching_count) : 0;
  }

  /**
   * Preview: the count, plus one page of rows.
   *
   * The count is the WHOLE matching set, not the page - it is the number the
   * user reads before deciding to export, and it must be the number of rows
   * they then get.
   */
  async preview(body, actor) {
    this._assertDataset(actor);
    const { fields, filters, warnings, template } = await this.resolveRequest(body, actor);

    const pageSize = Math.min(
      Math.max(Number(body.page_size) || reportConfig.DEFAULT_PAGE_SIZE, 1),
      reportConfig.MAX_PAGE_SIZE
    );
    const page = Math.max(Number(body.page) || 1, 1);
    const offset = (page - 1) * pageSize;

    const matchingCount = await this.count(fields, filters, actor);

    const { sql, params } = resolver.buildQuery(fields, filters, {
      limit: pageSize,
      offset,
      actor,
    });
    const rows = await this._query(sql, params);

    return {
      dataset_key: DATASET.EMPLOYEE_MASTER,
      template_id: template ? template.template_id : null,
      columns: fields.map((f) => ({
        key: f.key,
        label: f.label,
        group: f.group,
        sensitive: Boolean(f.sensitive),
      })),
      rows: rows.map((row) => resolver.presentRow(row, fields)),
      matching_count: matchingCount,
      page,
      page_size: pageSize,
      filters,
      warnings,
      // Preview may show a widened result - looking is not the same as taking
      // data out of the building - but it says so, so the export gate is not
      // the first the user hears of it.
      requires_acknowledgement: rules.widensResultSet(warnings),
      over_row_limit: matchingCount > reportConfig.MAX_ROWS,
      max_rows: reportConfig.MAX_ROWS,
    };
  }

  /**
   * Everything an export needs, decided BEFORE a single row is read: the
   * resolved query, the row count, the two gates, and the audit shape.
   *
   * Both gates are here rather than in the route because both are semantic:
   * whether reconciliation widened the population, and whether the result is
   * larger than this box will stream.
   */
  async prepareExport(body, actor, format) {
    // The dataset first, so somebody without it is told that rather than being
    // told they cannot export - two different things to ask for.
    this._assertDataset(actor);
    if (!this.canExport(actor)) {
      throw new ReportError(
        403,
        "EXPORT_FORBIDDEN",
        "You do not have permission to export reports"
      );
    }

    const { fields, filters, warnings, template } = await this.resolveRequest(body, actor);

    const gate = rules.exportGate(warnings, body.acknowledge_widened_filters === true);
    if (!gate.allowed) {
      throw new ReportError(gate.httpCode, gate.code, gate.msg, { warnings: gate.warnings });
    }

    const rowCount = await this.count(fields, filters, actor);
    if (rowCount > reportConfig.MAX_ROWS) {
      // Refused, never truncated. A spreadsheet that is quietly short is worse
      // than one that never arrived, because somebody will act on it.
      throw new ReportError(
        422,
        ROW_CAP_CODE,
        `This report matches ${rowCount} employees, which is more than the ${reportConfig.MAX_ROWS} an export may contain. Narrow the filters and try again.`,
        { row_count: rowCount, max_rows: reportConfig.MAX_ROWS }
      );
    }

    const { sql, params } = resolver.buildQuery(fields, filters, { actor });

    return {
      fields,
      filters,
      warnings,
      template,
      sql,
      params,
      row_count: rowCount,
      format,
      filename: this._filename(template, format),
      sensitive_fields_included: fields.some((f) => f.sensitive),
    };
  }

  _filename(template, format) {
    const base = template ? template.template_name : "Employee Master";
    // Whatever the name contains, only these characters reach a header.
    const safe = String(base).replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "report";
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safe.replace(/\s+/g, "-")}-${stamp}.${format}`;
  }

  /**
   * Read the export in chunks, handing each batch to `onRows`.
   *
   * Chunked rather than one array, so a large export does not hold every row
   * in memory at once while the writer streams. `LIMIT/OFFSET` over a query
   * ordered by the primary key is stable for this size of data.
   */
  async streamRows(prepared, onRows) {
    const chunk = reportConfig.STREAM_CHUNK;
    let offset = 0;
    let written = 0;

    for (;;) {
      const rows = await this._query(`${prepared.sql} LIMIT ? OFFSET ?`, [
        ...prepared.params,
        chunk,
        offset,
      ]);
      if (rows.length === 0) break;

      await onRows(rows.map((row) => resolver.presentRow(row, prepared.fields)));
      written += rows.length;
      offset += rows.length;

      if (rows.length < chunk) break;
    }
    return written;
  }

  /**
   * The audit row. Shape only - the field KEYS that were exported, the filter
   * metadata, the row count. Not one exported value.
   */
  recordExport(prepared, actor) {
    return this.templates.logExport({
      dataset_key: DATASET.EMPLOYEE_MASTER,
      user_id: actor ? actor.userId : null,
      employee_id: actor ? actor.employeeId : null,
      field_keys: prepared.fields.map((f) => f.key),
      filters: {
        status: prepared.filters.status,
        outlet_ids: prepared.filters.outlet_ids,
        department_ids: prepared.filters.department_ids,
        designation_ids: prepared.filters.designation_ids,
        // Whether a search was used, never WHAT was searched for: a search
        // string is often a person's name, and this table must not hold one.
        search_used: Boolean(prepared.filters.search),
        // The per-field filters by KEY only, for exactly the same reason: a
        // filter on Employee Name carries a person's name, so the audit
        // records WHICH columns narrowed the export and never the values.
        field_filters_used: (prepared.filters.field_filters || []).map((f) => f.field.key),
      },
      row_count: prepared.row_count,
      format: prepared.format,
      sensitive_fields_included: prepared.sensitive_fields_included,
      template_id: prepared.template ? prepared.template.template_id : null,
    });
  }
}

module.exports = (db, templateRepo) => new EmployeeReportService(db, templateRepo);
module.exports.EmployeeReportService = EmployeeReportService;
module.exports.ReportError = ReportError;
module.exports.ROW_CAP_CODE = ROW_CAP_CODE;
