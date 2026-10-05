const catalogue = require("../constants/payroll_report_catalogue");
const { getReportType, DEFAULT_DISPLAY } = require("../constants/payroll_report_types");
const { has, mayUseField } = require("../usecase/employee_report");
const { locationPredicate } = require("../repository/payrun");

/**
 * Payroll Reports - the ONE query path, pure.
 *
 * Preview, count, totals, Excel and PDF all go through `buildQuery`, so the
 * rows on screen and the rows in a file can never be chosen by two different
 * WHERE clauses. No caller string becomes SQL: field keys are looked up in
 * `constants/payroll_report_catalogue.js`, values are bound.
 *
 * ============================================ THE POPULATION IS THE PAYRUN
 *
 * The rows of a report are the month's PAYRUN employees (`payrun_employee`,
 * frozen at initialization) - every one of them, narrowed only by the
 * caller's branch scope, the report type's population and the user's own
 * filters. Nothing about the employee TODAY (status, resignation, transfer)
 * and nothing about a later lock change removes a row, so the Payroll
 * Register reconciles to the payrun: same employee count, and its gross,
 * deduction and net totals equal the payrun's finalized totals.
 *
 * ========================================================= FIGURES: FINAL ONLY
 *
 * A payroll figure is shown only where that employee's calculation is
 * APPROVED_LOCKED. Any other row is still IN the report - with its figures
 * blank and Payrun Status saying why - rather than showing a non-final
 * number or silently disappearing. Every select that reads the calculation
 * goes through `finalizedOnly`, so totals are finalized totals by
 * construction. A report never calls the payroll calculation and never reads
 * the attendance engine's live rows for a figure: opening September's report
 * in December shows September as it was approved. Approved rows change only
 * through the payrun's own unlock / recalculate / re-approve flow.
 */

const FINALIZED = "c.status = 'APPROVED_LOCKED'";

/**
 * A select that reads the calculation (`c.`) is shown only for a finalized
 * row. Fields marked `always` describe the row itself (its status, its pay
 * type) and are exempt.
 */
/** Whether a field shows a calculation figure (blank for a row that is not finalized). */
const isFinalizedFigure = (field) =>
  !field.always && Object.values(catalogue.selectsOf(field)).some((expr) => /\bc\./.test(expr));

const finalizedOnly = (field, expr) =>
  !field.always && /\bc\./.test(expr) ? `IF(${FINALIZED}, ${expr}, NULL)` : expr;

const MAX_FIELDS = (() => {
  const n = Number(process.env.PAYROLL_REPORT_MAX_FIELDS);
  return Number.isSafeInteger(n) && n > 0 ? n : 60;
})();

class PayrollReportError extends Error {
  constructor(httpCode, code, message, detail = {}) {
    super(message);
    this.name = "ReportError";
    this.httpCode = httpCode;
    this.code = code;
    this.detail = detail;
  }
}

const invalid = (code, message, detail) => new PayrollReportError(422, code, message, detail);

/* ------------------------------------------------------------------ month */

function periodOf(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) {
    throw invalid("INVALID_MONTH", "Select a valid payroll month");
  }
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { year: y, month: m, days, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(days).padStart(2, "0")}` };
}

/** The calendar month before. */
const previousPeriod = (year, month) => (Number(month) === 1 ? { year: Number(year) - 1, month: 12 } : { year: Number(year), month: Number(month) - 1 });

/* -------------------------------------------------------------- discovery */

/** The catalogue as this caller may see it. Fields they may not use are ABSENT, not disabled. */
function discoverFields(actor) {
  return catalogue.FIELDS.filter((f) => f.enabled && mayUseField(f, actor)).map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    subgroup: f.subgroup || null,
    type: f.type,
    source: f.source,
    source_label: catalogue.SOURCE_LABEL[f.source] || null,
    sensitive: Boolean(f.sensitive),
    summable: catalogue.isSummable(f),
    sortable: Boolean(f.sort || f.select),
    note: f.note || null,
  }));
}

/** A report type's default columns, as far as this caller may see them. */
function defaultFieldKeys(reportType, actor) {
  const type = getReportType(reportType);
  if (!type) return [];
  return type.default_fields.filter((k) => {
    const field = catalogue.getField(k);
    return field && field.enabled && mayUseField(field, actor);
  });
}

/* ----------------------------------------------------------------- fields */

/**
 * `strict` for a request - an unknown or forbidden key is an error, with one
 * message for both so a forbidden field's existence is not disclosed.
 * `reconcile` for a saved layout or template - such keys are dropped with a
 * warning, because a template is an instruction, not a promise.
 */
function resolveFields(keys, actor, mode = "strict") {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw invalid("NO_FIELDS", "Select at least one column");
  }
  if (keys.length > MAX_FIELDS) {
    throw invalid("TOO_MANY_FIELDS", `Select at most ${MAX_FIELDS} columns`, { max_fields: MAX_FIELDS });
  }
  const fields = [];
  const warnings = [];
  const seen = new Set();
  for (const key of keys) {
    const field = catalogue.getField(key);
    if (!field || !field.enabled || !mayUseField(field, actor)) {
      if (mode === "strict") {
        throw invalid("UNKNOWN_FIELD", `'${String(key).slice(0, 40)}' is not a column you can report on`, {
          field: String(key).slice(0, 40),
        });
      }
      warnings.push({
        type: "field_unavailable",
        field: String(key).slice(0, 40),
        message: "A column in this layout is not available to you and was left out.",
        widens_result_set: false,
      });
      continue;
    }
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }
  if (fields.length === 0) {
    throw invalid("NO_USABLE_FIELDS", "None of the columns in this layout are available to you");
  }
  return { fields, warnings };
}

/* ---------------------------------------------------------------- filters */

const ids = (raw) =>
  [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);

/** Filter VALUES only. Reusable ones (outlets, departments, pay type) may be saved in a template. */
function resolveFilters(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const payType = r.pay_type === "BANK" || r.pay_type === "CASH" ? r.pay_type : null;
  return {
    outlet_ids: ids(r.outlet_ids),
    department_ids: ids(r.department_ids),
    pay_type: payType,
    search: String(r.search || "").trim().slice(0, 100),
  };
}

/** What a template may keep: reusable filters, never a one-off search. */
const persistableFilters = (filters) => {
  const f = resolveFilters(filters);
  return { outlet_ids: f.outlet_ids, department_ids: f.department_ids, pay_type: f.pay_type };
};

/* ---------------------------------------------------------------- display */

function resolveDisplay(raw, fieldKeys = null) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULT_DISPLAY };
  if (typeof r.show_totals === "boolean") out.show_totals = r.show_totals;
  if (r.sort_dir === "desc") out.sort_dir = "desc";
  const sortField = catalogue.getField(r.sort_by);
  if (sortField && (sortField.sort || sortField.select) && (!fieldKeys || fieldKeys.includes(sortField.key))) {
    out.sort_by = sortField.key;
  }
  return out;
}

/* ------------------------------------------------------------------ query */

function joinsFor(fields) {
  const wanted = new Set();
  const add = (name) => {
    const join = catalogue.JOINS[name];
    if (!join || wanted.has(name)) return;
    (join.requires || []).forEach(add);
    wanted.add(name);
  };
  for (const field of fields) {
    const names = Array.isArray(field.join) ? field.join : field.join ? [field.join] : [];
    names.forEach(add);
  }
  // Emitted in the catalogue's fixed order, so a dependency always precedes
  // the join that addresses it.
  return Object.keys(catalogue.JOINS).filter((name) => wanted.has(name));
}

/**
 * @param {object} args
 * @param {string} args.reportType
 * @param {Array}  args.fields       resolved catalogue entries
 * @param {object} args.filters      resolveFilters() output
 * @param {object} args.period       periodOf() output
 * @param {Array|null} args.store_ids the caller's branch scope: null = all, [] = none
 * @param {object} [args.display]
 * @param {"rows"|"count"|"totals"} [args.mode]
 */
function buildQuery({ reportType, fields, filters, period, store_ids, display = DEFAULT_DISPLAY, mode = "rows", limit = null, offset = 0 }) {
  const type = getReportType(reportType);
  if (!type) throw invalid("UNKNOWN_REPORT_TYPE", "That report type is not available");
  if (store_ids === undefined) throw new Error("payroll report query: the branch scope is required");

  const joinNames = joinsFor(fields);
  const joinSql = [];
  const joinParams = [];
  for (const name of joinNames) {
    const join = catalogue.JOINS[name];
    joinSql.push(join.sql);
    if (join.params) joinParams.push(...join.params(period));
  }

  const where = ["pe.period_year = ?", "pe.period_month = ?"];
  const params = [period.year, period.month];

  // FAIL CLOSED: an empty scope is `1 = 0`, never "no clause".
  const location = locationPredicate("pe.store_id", store_ids);
  if (location.clause) {
    where.push(location.clause);
    params.push(...location.params);
  }
  if (type.population) where.push(`(${type.population})`);
  if (filters.outlet_ids.length) {
    where.push("pe.store_id IN (?)");
    params.push(filters.outlet_ids);
  }
  if (filters.department_ids.length) {
    where.push("pe.department_id IN (?)");
    params.push(filters.department_ids);
  }
  if (filters.pay_type) {
    where.push(`${catalogue.PAY_TYPE} = ?`);
    params.push(filters.pay_type);
  }
  if (filters.search) {
    where.push("(pe.employee_name LIKE ? OR CAST(pe.employee_id AS CHAR) = ?)");
    params.push(`%${filters.search}%`, filters.search);
  }

  const base = [
    "FROM payrun_employee pe",
    "LEFT JOIN payrun_employee_calculation c ON c.payrun_employee_id = pe.payrun_employee_id",
  ].join("\n");
  const from = [base, ...joinSql].join("\n");
  const whereSql = `WHERE ${where.join(" AND ")}`;

  if (mode === "count") {
    // Joins carry no row multiplication (every one is to a unique key or a
    // grouped derived table), but the count needs none of them: it is taken
    // over the base rows only, so it cannot disagree with the rows.
    return {
      sql: `SELECT COUNT(*) AS matching_count,\n       SUM(${FINALIZED}) AS finalized_count\n${base}\n${whereSql}`,
      params,
    };
  }

  if (mode === "totals") {
    const sums = fields
      .map((f, i) => (catalogue.isSummable(f) ? `SUM(${finalizedOnly(f, f.select)}) AS t${i}` : null))
      .filter(Boolean);
    if (sums.length === 0) return null;
    return { sql: `SELECT ${sums.join(", ")}\n${from}\n${whereSql}`, params: [...joinParams, ...params] };
  }

  const select = ["pe.employee_id AS _employee_id", `${catalogue.PAYRUN_STATUS} AS _payrun_status`];
  fields.forEach((field, i) => {
    for (const [name, expr] of Object.entries(catalogue.selectsOf(field))) {
      select.push(`${finalizedOnly(field, expr)} AS c${i}_${name}`);
    }
  });

  let order = "pe.employee_id ASC";
  const sortField = display && display.sort_by ? catalogue.getField(display.sort_by) : null;
  if (sortField && (sortField.sort || sortField.select)) {
    order = `${finalizedOnly(sortField, sortField.sort || sortField.select)} ${display.sort_dir === "desc" ? "DESC" : "ASC"}, pe.employee_id ASC`;
  }

  const tailParams = [];
  let tail = "";
  if (limit !== null) {
    tail = " LIMIT ? OFFSET ?";
    tailParams.push(Number(limit), Number(offset));
  }

  return {
    sql: `SELECT ${select.join(",\n       ")}\n${from}\n${whereSql}\nORDER BY ${order}${tail}`,
    params: [...joinParams, ...params, ...tailParams],
  };
}

/**
 * A database row to the ordered, transformed values of one report row.
 * `post(field, row)` fills the computed columns (validation status, period).
 */
function presentRow(row, fields, post = () => null) {
  const out = {};
  fields.forEach((field, i) => {
    if (field.post) {
      out[field.key] = post(field, row);
      return;
    }
    if (field.compute) {
      const values = {};
      for (const name of Object.keys(field.selects)) values[name] = row[`c${i}_${name}`];
      out[field.key] = field.compute(values);
      return;
    }
    const raw = row[`c${i}_v`];
    out[field.key] = field.transform ? field.transform(raw) : raw === undefined ? null : raw;
  });
  return out;
}

/** Totals row from a `totals` query result. */
function presentTotals(result, fields) {
  const out = {};
  if (!result) return out;
  fields.forEach((f, i) => {
    if (!catalogue.isSummable(f)) return;
    const v = result[`t${i}`];
    out[f.key] = v === null || v === undefined ? 0 : Math.round(Number(v) * 100) / 100;
  });
  return out;
}

const columnsOf = (fields) =>
  fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    source: f.source,
    summable: catalogue.isSummable(f),
  }));

module.exports = {
  PayrollReportError,
  MAX_FIELDS,
  periodOf,
  previousPeriod,
  discoverFields,
  defaultFieldKeys,
  resolveFields,
  resolveFilters,
  persistableFilters,
  resolveDisplay,
  buildQuery,
  presentRow,
  presentTotals,
  columnsOf,
  joinsFor,
  finalizedOnly,
  isFinalizedFigure,
  FINALIZED,
  has,
  mayUseField,
};
