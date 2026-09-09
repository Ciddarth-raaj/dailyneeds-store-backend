const catalogue = require("../constants/employee_report_catalogue");
const reportConfig = require("../config/reports");
const { buildReportAccessScope } = require("../repository/employee_scope");
const P = require("../constants/hr_permissions");

/**
 * Reports — the Employee Master resolver.
 *
 * ONE QUERY PATH. Count, preview and export all go through `buildQuery`
 * below. There is no second SQL builder for export, because the moment there
 * are two, they drift: the export quietly includes somebody the preview
 * said was excluded, and nobody notices until a spreadsheet is emailed. A
 * regression test asserts `preview.matching_count === exported_row_count` for
 * the same user, fields and filters.
 *
 * NO CALLER STRING BECOMES SQL. A request carries semantic field keys and
 * filter VALUES. Keys are looked up in the catalogue - an unknown key is
 * rejected, never interpolated - and values travel as bound parameters. The
 * SELECT list, the JOINs, the WHERE structure and the ORDER BY are all
 * assembled from catalogue text.
 *
 * AUTHORIZATION IS SHARED; POPULATION IS NOT. Which rows a caller may reach
 * comes from `buildReportAccessScope` - the same access unit the HR directory
 * composes - so a future outlet restriction lands on both at once and cannot
 * be applied to one and forgotten on the other.
 *
 * What Reports does NOT inherit is the directory's own population rule, which
 * hides anyone whose name appears in `resignation`. That is a legacy quirk of
 * one screen, not authorization: inheriting it would make a "Resigned" report
 * return nothing and an "All" report quietly mean "all except the ones who
 * left". A report's population is decided by its explicit status filter.
 */

class ReportValidationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = 422;
    this.code = code;
    this.detail = detail;
  }
}

const has = (permissions, key) =>
  Array.isArray(permissions) &&
  permissions.some((p) => (p && p.permission_key ? p.permission_key : p) === key);

/** Admins reach everything through the existing user_type 2 bypass. */
const mayUseField = (field, actor) => {
  if (!field.permission) return true;
  if (actor && actor.isAdmin) return true;
  return has(actor && actor.permissions, field.permission);
};

/* ------------------------------------------------------------- discovery */

/** The catalogue as this caller may see it. Fields they cannot use are absent. */
function discoverFields(actor) {
  return catalogue.FIELDS.filter((f) => f.enabled && mayUseField(f, actor)).map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    sensitive: Boolean(f.sensitive),
    history_backed: Boolean(f.history_backed),
    default_selected: Boolean(f.default_selected),
  }));
}

/* ------------------------------------------------------ field validation */

/**
 * Validate a requested field list.
 *
 * @param mode "strict" for a direct request - unknown or unauthorized keys
 *             are an error; "reconcile" for a saved template - they are
 *             dropped with a warning, because a template is an instruction
 *             rather than a promise that everything in it still exists.
 */
function resolveFields(keys, actor, mode = "strict") {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ReportValidationError("NO_FIELDS", "Select at least one field to report on");
  }

  // The cap is checked on what was ASKED FOR, so a caller cannot slip past it
  // by naming 200 fields of which only 30 survive reconciliation.
  if (keys.length > reportConfig.MAX_FIELDS) {
    throw new ReportValidationError(
      "TOO_MANY_FIELDS",
      `Select at most ${reportConfig.MAX_FIELDS} fields; ${keys.length} were requested`,
      { max_fields: reportConfig.MAX_FIELDS, requested: keys.length }
    );
  }

  const fields = [];
  const warnings = [];
  const seen = new Set();

  for (const key of keys) {
    const field = catalogue.getField(key);

    if (!field || !field.enabled || !mayUseField(field, actor)) {
      if (mode === "strict") {
        // One message for all three cases on purpose: telling a caller that a
        // field exists but is not theirs is itself a disclosure.
        throw new ReportValidationError(
          "UNKNOWN_FIELD",
          `'${String(key).slice(0, 40)}' is not a field you can report on`,
          { field: String(key).slice(0, 40) }
        );
      }
      warnings.push({
        type: "field_unavailable",
        field: String(key).slice(0, 40),
        message: "This field is no longer available to you and was not included.",
        widens_result_set: false,
      });
      continue;
    }

    // Order is the contract, and a repeat would produce a duplicate column.
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }

  if (fields.length === 0) {
    throw new ReportValidationError(
      "NO_USABLE_FIELDS",
      "None of the fields in this report are available to you"
    );
  }

  return { fields, warnings };
}

/* ----------------------------------------------------- filter validation */

const STATUS_VALUES = ["active", "inactive", "all"];

const positiveIds = (raw, name) => {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of list) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new ReportValidationError("BAD_FILTER_VALUE", `${name} must be positive whole numbers`, {
        filter: name,
      });
    }
    out.push(n);
  }
  return [...new Set(out)];
};

/**
 * Normalize the filters. These mirror the HR directory's own controls -
 * status, outlet, department, designation, search - rather than a generic
 * field/operator/value language, which is what §12 rules out: an operator
 * grammar is a query builder, and a query builder eventually needs to accept
 * an operator from the caller.
 */
function resolveFilters(raw = {}) {
  const filters = raw && typeof raw === "object" ? raw : {};

  const status = String(filters.status ?? "active").toLowerCase();
  if (!STATUS_VALUES.includes(status)) {
    throw new ReportValidationError(
      "BAD_STATUS",
      `Employment status must be one of: ${STATUS_VALUES.join(", ")}`
    );
  }

  const search = String(filters.search ?? "").trim().slice(0, 100);

  return {
    status,
    outlet_ids: positiveIds(filters.outlet_ids, "Outlet"),
    department_ids: positiveIds(filters.department_ids, "Department"),
    designation_ids: positiveIds(filters.designation_ids, "Designation"),
    search,
  };
}

/* --------------------------------------------------------- query builder */

/**
 * The one query. `fields` are catalogue entries, already validated.
 *
 * Every fragment below is either a literal in this file or a value bound to a
 * placeholder. Nothing is concatenated from the request.
 */
function buildQuery(fields, filters, { count = false, limit = null, offset = 0, actor = null } = {}) {
  // AUTHORIZATION ONLY, plus the caller's own outlet/designation narrowing.
  //
  // Deliberately NOT the directory's population rule. The directory hides
  // anyone whose name appears in `resignation`; inheriting that here would
  // make "Resigned" return nothing and "All" quietly mean "all except the
  // ones who left" - wrong in a way a reader of the spreadsheet cannot see.
  // A report's population is decided by its status filter, below.
  const scope = buildReportAccessScope(
    { store_ids: filters.outlet_ids, designation_ids: filters.designation_ids },
    actor
  );

  const where = [...scope.conditions];
  const params = [...scope.params];

  // The status filter IS the population. `new_employee.status` is the current
  // employment state - 1 is employed, anything else is not - which is what
  // §5's "current values only" means here; the C1 employment periods carry
  // the lifecycle detail and are not consulted for a current-state report.
  if (filters.status === "active") where.push("new_employee.status = 1");
  else if (filters.status === "inactive") where.push("(new_employee.status <> 1 OR new_employee.status IS NULL)");
  // "all" adds no condition at all, and now genuinely means all.

  if (filters.department_ids.length) {
    where.push("new_employee.department_id IN (?)");
    params.push(filters.department_ids);
  }

  if (filters.search) {
    // Name or employee ID, matching the directory's single search box. The
    // wildcards are added here and the value is still bound, so a `%` typed by
    // the user is a literal percent rather than SQL structure.
    where.push("(new_employee.employee_name LIKE ? OR CAST(new_employee.employee_id AS CHAR) = ?)");
    params.push(`%${filters.search}%`, filters.search);
  }

  // Joins are added only for the fields actually selected, and only from the
  // fixed table in the catalogue.
  const needed = [...new Set(fields.map((f) => f.join).filter(Boolean))];
  const joins = needed.map((name) => catalogue.JOINS[name]).filter(Boolean).join("\n     ");

  // "All" with no filters legitimately constrains nothing, and `WHERE` with
  // an empty predicate is a syntax error rather than a wide query.
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  if (count) {
    return {
      sql: `SELECT COUNT(*) AS matching_count
              FROM new_employee
              ${joins}
             ${whereSql}`,
      params,
    };
  }

  const select = fields.map((f, i) => `${f.select} AS c${i}`).join(",\n            ");
  const paged = [...params];
  let tail = "";
  if (limit !== null) {
    // Bound, not interpolated - even though both are integers by now.
    tail = " LIMIT ? OFFSET ?";
    paged.push(Number(limit), Number(offset));
  }

  return {
    sql: `SELECT ${select}
            FROM new_employee
            ${joins}
           ${whereSql}
           ORDER BY new_employee.employee_id ASC${tail}`,
    params: paged,
  };
}

/** Turn a database row into the ordered, transformed values for one report row. */
function presentRow(row, fields) {
  const out = {};
  fields.forEach((field, i) => {
    const raw = row[`c${i}`];
    out[field.key] = field.transform ? field.transform(raw) : raw === undefined ? null : raw;
  });
  return out;
}

module.exports = {
  ReportValidationError,
  discoverFields,
  resolveFields,
  resolveFilters,
  buildQuery,
  presentRow,
  mayUseField,
  has,
  STATUS_VALUES,
  MAX_FIELDS: reportConfig.MAX_FIELDS,
  MAX_ROWS: reportConfig.MAX_ROWS,
  SENSITIVE_PERMISSION: P.VIEW_EMPLOYEE_SENSITIVE,
};
