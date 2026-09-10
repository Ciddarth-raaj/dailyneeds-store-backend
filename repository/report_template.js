const logger = require("../utils/logger");

/**
 * Reports — saved templates, the export audit trail, and the lookups
 * reconciliation needs.
 *
 * ===================================== WHAT THIS LAYER DOES NOT DO ========
 *
 * It does not build report SQL. The one report query lives in
 * `usecase/employee_report.js#buildQuery`, assembled from catalogue text, and
 * this file never sees a field key as anything but an opaque string it stores
 * and returns. A repository that also knew how to turn a saved template into a
 * SELECT would be a second query builder, and the two would drift.
 *
 * It also does not decide who may see a template. That is
 * `usecase/report_template_rules.js`. What this layer does is refuse to LOAD
 * what the caller cannot see in the first place - the visibility predicate is
 * in the WHERE clause of `listVisible`, not applied to rows after they arrive -
 * so a personal template belonging to somebody else never reaches the process
 * that would then have to remember to hide it. `findById` deliberately returns
 * the row regardless, because the caller needs to tell "no such template" from
 * "not yours" and both answers are the usecase's to shape.
 *
 * ------------------------------------------------------------------ JSON
 * `field_keys` and `filters` are JSON columns. The `mysql` driver returns them
 * already parsed on MySQL 8, but returns a string on some configurations, so
 * every read goes through `parseJson` rather than trusting either. Writes bind
 * `JSON.stringify(...)` - never a concatenated fragment.
 */

const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch (err) {
    // A template whose JSON will not parse is corrupt, not fatal: the caller
    // gets an empty field list and reconciliation reports it as unusable.
    return fallback;
  }
};

/** One stored row, in the shape the rules and usecase layers expect. */
const present = (row) => ({
  template_id: Number(row.template_id),
  template_name: row.template_name,
  dataset_key: row.dataset_key,
  field_keys: parseJson(row.field_keys, []),
  filters: parseJson(row.filters, {}),
  owner_user_id: row.owner_user_id === null ? null : Number(row.owner_user_id),
  is_shared: Number(row.is_shared),
  is_system: Number(row.is_system),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

class ReportTemplateRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.REPORT_TEMPLATE",
      code: `REPOSITORY.REPORT_TEMPLATE.${code}`,
      description: err.toString(),
      category: "",
      // `ref` carries ids and counts only. Never a field value, never a filter
      // value, never a row - see the audit-log note below.
      ref,
    });
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ------------------------------------------------------------ templates */

  /**
   * Templates this actor may see: every system and shared template, plus their
   * own personal ones.
   *
   * The ownership test is in SQL rather than a filter afterwards. Somebody
   * else's personal template is not "loaded and then hidden" - it is never
   * selected, so no later change to the presentation can leak it.
   */
  listVisible(datasetKey, actor) {
    const userId = actor && actor.userId !== undefined && actor.userId !== null
      ? Number(actor.userId)
      : null;
    return this._query(
      "LIST-VISIBLE",
      `SELECT * FROM report_template
        WHERE dataset_key = ?
          AND (is_system = 1 OR is_shared = 1 OR owner_user_id <=> ?)
        ORDER BY is_system DESC, template_name ASC`,
      [datasetKey, userId]
    ).then((rows) => rows.map(present));
  }

  /**
   * One template by id, WITHOUT a visibility predicate.
   *
   * Deliberate: the usecase has to distinguish "no such template" from "not
   * yours", and it applies `templatePermissions` itself. Every call site is
   * required to do so - the route tests assert it.
   */
  findById(templateId) {
    return this._query(
      "FIND-BY-ID",
      "SELECT * FROM report_template WHERE template_id = ? LIMIT 1",
      [Number(templateId)]
    ).then((rows) => (rows.length ? present(rows[0]) : null));
  }

  create(template) {
    return this._query(
      "CREATE",
      `INSERT INTO report_template
         (template_name, dataset_key, field_keys, filters, owner_user_id, is_shared, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        template.template_name,
        template.dataset_key,
        JSON.stringify(template.field_keys || []),
        JSON.stringify(template.filters || {}),
        // The CHECK constraint refuses a system template with an owner and an
        // owned template without one; `is_system` is hardcoded 0 above, so
        // this API cannot mint a system template however it is called.
        Number(template.owner_user_id),
        template.is_shared ? 1 : 0,
      ]
    ).then((result) => Number(result.insertId));
  }

  /**
   * Update the mutable parts of a template. `owner_user_id` and `is_system`
   * are absent on purpose: a template cannot change hands or be promoted to a
   * system template by an edit.
   */
  update(templateId, patch) {
    return this._query(
      "UPDATE",
      `UPDATE report_template
          SET template_name = ?, field_keys = ?, filters = ?, is_shared = ?
        WHERE template_id = ? AND is_system = 0`,
      [
        patch.template_name,
        JSON.stringify(patch.field_keys || []),
        JSON.stringify(patch.filters || {}),
        patch.is_shared ? 1 : 0,
        Number(templateId),
      ]
    ).then((result) => Number(result.affectedRows) > 0);
  }

  /** `is_system = 0` in the WHERE, so a seeded template cannot be deleted. */
  remove(templateId) {
    return this._query(
      "DELETE",
      "DELETE FROM report_template WHERE template_id = ? AND is_system = 0",
      [Number(templateId)]
    ).then((result) => Number(result.affectedRows) > 0);
  }

  /* ------------------------------------------------------------ the audit */

  /**
   * Record that an export happened: who, what SHAPE, how many rows.
   *
   * NEVER a value. `field_keys` says PAN was in the export; it does not say
   * whose or what. `filters` says outlet 2; `row_count` says 216. An audit log
   * containing the values it audits is a second copy of the leak it exists to
   * detect, and it is the copy nobody thinks to protect.
   */
  logExport(entry) {
    return this._query(
      "LOG-EXPORT",
      `INSERT INTO report_export_log
         (dataset_key, user_id, employee_id, field_keys, filters,
          row_count, format, sensitive_fields_included, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.dataset_key,
        entry.user_id === undefined ? null : entry.user_id,
        entry.employee_id === undefined ? null : entry.employee_id,
        JSON.stringify(entry.field_keys || []),
        JSON.stringify(entry.filters || {}),
        Number(entry.row_count) || 0,
        entry.format,
        entry.sensitive_fields_included ? 1 : 0,
        entry.template_id === undefined || entry.template_id === null
          ? null
          : Number(entry.template_id),
      ]
    ).then((result) => Number(result.insertId));
  }

  /* --------------------------------------------- lookups for reconciliation */

  /**
   * Which saved filter ids still resolve, and which are still active.
   *
   * Reconciliation needs both: an id that no longer exists must be dropped,
   * while an id that exists but is inactive is KEPT and merely flagged -
   * a closed branch's staff are exactly who a leavers report is about, and
   * dropping the filter because the branch shut would silently widen the
   * report to every branch.
   *
   * Ids are bound as one list; the table and column names come from the fixed
   * map below and never from a caller.
   */
  resolveLookupIds(kind, ids) {
    const SOURCES = {
      // `outlets` spells it `is_active`; the two masters spell it `status`.
      // Both are pinned by a test, because getting the column wrong here would
      // mark every outlet inactive and quietly flag every saved filter.
      outlet: { table: "outlets", id: "outlet_id", active: "is_active" },
      department: { table: "department", id: "department_id", active: "status" },
      designation: { table: "designation", id: "designation_id", active: "status" },
    };
    const source = SOURCES[kind];
    if (!source) return Promise.reject(new Error(`unknown lookup '${kind}'`));

    const list = [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))];
    if (list.length === 0) {
      return Promise.resolve({ resolvable: new Set(), active: new Set() });
    }

    return this._query(
      "RESOLVE-LOOKUP",
      `SELECT ${source.id} AS id, ${source.active} AS active
         FROM ${source.table}
        WHERE ${source.id} IN (?)`,
      [list]
    ).then((rows) => {
      const resolvable = new Set();
      const active = new Set();
      for (const row of rows) {
        const id = Number(row.id);
        resolvable.add(id);
        // A NULL status is treated as active: several master rows predate the
        // column, and calling those inactive would flag every old outlet.
        if (row.active === null || Number(row.active) === 1) active.add(id);
      }
      return { resolvable, active };
    });
  }
}

module.exports = (db) => new ReportTemplateRepository(db);
module.exports.ReportTemplateRepository = ReportTemplateRepository;
module.exports.parseJson = parseJson;
module.exports.present = present;
