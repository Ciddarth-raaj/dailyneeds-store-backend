const { STATUS_GROUP } = require("../constants/payrun");
const { CALC_STATUS, CALC_CARD, READY_BLOCKER } = require("../constants/payrun_calculation");
const { BLOCK_REASON } = require("../constants/payrun");
const { monthWindow, exitedByMonthEnd, toDateOnly } = require("./payrun_eligibility");

/**
 * Payroll Dashboard - the pure half. It merges what the two payrun usecases
 * already decided about a month and counts it; it decides nothing about any
 * employee's pay.
 *
 * ONE ROW PER EMPLOYEE, ATTRIBUTED THE WAY THE PAYRUN SCREENS ATTRIBUTE THEM:
 * an initialized employee by their month's snapshot (location, department,
 * designation - exactly Calculation & Review's view), everybody else by the
 * Employee Master as it is today (exactly Initialization's view).
 *
 * MONEY IS PAISE, AS INTEGERS, until it leaves as a two-decimal rupee string,
 * so no total is the sum of floating-point rupees.
 */

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAME = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const GROUP_BY = ["location", "department", "designation", "employment_type"];
const NONE = "NONE";

const METRIC = {
  ALL: "ALL",
  INITIALIZED: "INITIALIZED",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  COSTED: "COSTED",
  DED_PF: "DED_PF",
  DED_ESI: "DED_ESI",
  DED_ADVANCE: "DED_ADVANCE",
  DED_OTHER: "DED_OTHER",
  MOVE_JOINED: "MOVE_JOINED",
  MOVE_REJOINED: "MOVE_REJOINED",
  MOVE_RESIGNED: "MOVE_RESIGNED",
  HEADCOUNT: "HEADCOUNT",
};

/* ------------------------------------------------------------------ money */

function toPaise(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function rupees(paise) {
  if (paise === null || paise === undefined) return null;
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function figuresInPaise(figures) {
  if (!figures) return null;
  const net = toPaise(figures.net);
  if (net === null) return null;
  const z = (v) => toPaise(v) || 0;
  return {
    gross: z(figures.gross),
    deductions: z(figures.deductions),
    net,
    pf: z(figures.pf),
    esi: z(figures.esi),
    advance: z(figures.advance),
    // Shortage recovery and the missing-hours deduction - the two employee
    // deductions that are neither statutory nor an advance.
    other: z(figures.shortage) + z(figures.missing_hours),
  };
}

/* ----------------------------------------------------------------- months */

/** April of `fy` to March of `fy + 1`. */
function financialYearMonths(fy) {
  const start = Number(fy);
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return { year: m >= 4 ? start : start + 1, month: m };
  });
}

/** The financial year (its starting calendar year) a month belongs to. */
function financialYearOf(year, month) {
  return Number(month) >= 4 ? Number(year) : Number(year) - 1;
}

function shortLabel(year, month) {
  return `${MONTH_ABBR[month - 1]} '${String(year).slice(-2)}`;
}

function longLabel(year, month) {
  return `${MONTH_NAME[month - 1]} ${year}`;
}

/** The previous payroll month. */
function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * THE MONTH STRIP'S STATE, from stored progress only.
 *
 *   FUTURE       starts after today's month
 *   NOT_STARTED  nobody initialized
 *   INITIALIZED  initialized, nobody calculated
 *   CALCULATING  some calculated, not all approved
 *   APPROVED     everybody initialized is approved & locked
 *   PUBLISHED    ... and every payslip is published
 */
function monthStatus(totals, { year, month }, today) {
  const ym = year * 100 + month;
  const todayYm = today.year * 100 + today.month;
  const t = totals || { initialized: 0, calculated: 0, approved: 0, published: 0 };
  if (!t.initialized) return ym > todayYm ? "FUTURE" : "NOT_STARTED";
  if (t.published === t.initialized) return "PUBLISHED";
  if (t.approved === t.initialized) return "APPROVED";
  if (t.calculated > 0) return "CALCULATING";
  return "INITIALIZED";
}

function buildMonthStrip({ fy, totals, today }) {
  const byKey = new Map((totals || []).map((t) => [`${t.year}-${t.month}`, t]));
  return financialYearMonths(fy).map(({ year, month }) => {
    const t = byKey.get(`${year}-${month}`) || null;
    return {
      year,
      month,
      label: shortLabel(year, month),
      status: monthStatus(t, { year, month }, today),
      initialized: t ? t.initialized : 0,
      calculated: t ? t.calculated : 0,
      approved: t ? t.approved : 0,
      published: t ? t.published : 0,
      gross: t && t.calculated > 0 ? rupees(toPaise(t.gross)) : null,
    };
  });
}

/* ------------------------------------------------------------------ merge */

const idOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function inWindow(date, window) {
  const d = toDateOnly(date);
  return Boolean(d && d >= window.from && d <= window.to);
}

/**
 * ONE ROW PER EMPLOYEE FOR THE MONTH.
 *
 * @param initRows   `PayrunUsecase.getMonth(...).rows` - the population in
 *                   scope by the Employee Master, each READY / BLOCKED /
 *                   INITIALIZED.
 * @param calcRows   `PayrunCalculationUsecase.getMonthFigures(...).rows` -
 *                   the initialized employees in scope by their SNAPSHOT.
 *
 * AN INITIALIZED EMPLOYEE IS TAKEN FROM `calcRows` ONLY. If the snapshot puts
 * them outside the caller's scope, the calculation stage does not return them
 * and neither does this - whatever the master says today. A snapshot inside
 * the scope whose master has since moved out is still this scope's payroll,
 * which is the calculation screen's answer too.
 */
function mergeMonth({ year, month, initRows = [], calcRows = [], facts = [], rejoins = [] }) {
  const window = monthWindow(year, month);
  const factOf = new Map(facts.map((f) => [Number(f.employee_id), f]));
  const rejoined = new Set(rejoins.map((r) => Number(r.employee_id)));
  const initOf = new Map(initRows.map((r) => [Number(r.employee_id), r]));
  const rows = [];

  const movement = (id, joining, resignation, exited) => {
    const isRejoin = rejoined.has(id) && inWindow(joining, window);
    return {
      joined: !isRejoin && inWindow(joining, window),
      rejoined: isRejoin,
      resigned: exited === undefined ? exitedByMonthEnd({ year, month, ended_on: resignation }) : exited === true,
    };
  };

  calcRows.forEach((c) => {
    const id = Number(c.employee_id);
    const live = initOf.get(id) || null;
    const fact = factOf.get(id) || {};
    const joining = live ? live.date_of_joining : c.date_of_joining;
    const resignation = live ? live.resignation_date : c.resignation_date;
    rows.push({
      employee_id: id,
      employee_name: c.employee_name,
      store_id: idOrNull(c.store_id),
      store_name: c.location || c.store_name || null,
      department_id: idOrNull(c.department_id),
      department_name: c.department_name || null,
      designation_id: idOrNull(c.designation_id),
      designation_name: c.designation_name || null,
      employment_type: fact.employment_type || null,
      date_of_joining: joining || null,
      resignation_date: resignation || null,
      initialized: true,
      init_status: STATUS_GROUP.INITIALIZED,
      init_reasons: [],
      calc_status: c.status,
      status_label: c.status_label || c.status,
      blockers: (c.blockers || []).map((b) => ({ code: b.code, label: b.label })),
      recalculation_reasons: (c.recalculation_reasons || []).map((r) => ({ code: r.code, label: r.label })),
      attendance_needs_action: c.attendance_needs_action === true,
      statutory_hold: Boolean(c.statutory_hold),
      figures: figuresInPaise(c.figures),
      movement: movement(id, joining, resignation, live ? live.exited_in_month : undefined),
    });
  });

  initRows.forEach((r) => {
    if (r.initialized === true || r.status === STATUS_GROUP.INITIALIZED) return;
    const id = Number(r.employee_id);
    const fact = factOf.get(id) || {};
    rows.push({
      employee_id: id,
      employee_name: r.employee_name,
      store_id: idOrNull(r.store_id),
      store_name: r.store_name || null,
      department_id: idOrNull(fact.department_id !== undefined ? fact.department_id : r.department_id),
      department_name: fact.department_name || null,
      designation_id: idOrNull(r.designation_id),
      designation_name: r.designation_name || null,
      employment_type: fact.employment_type || null,
      date_of_joining: r.date_of_joining || null,
      resignation_date: r.resignation_date || null,
      initialized: false,
      init_status: r.status,
      init_reasons: (r.blocking_reasons || []).map((b) => ({ code: b.code, label: b.label })),
      calc_status: null,
      status_label: r.status === STATUS_GROUP.BLOCKED ? "Blocked - cannot initialize" : "Ready to initialize",
      blockers: [],
      recalculation_reasons: [],
      attendance_needs_action: false,
      statutory_hold: false,
      figures: null,
      movement: movement(id, r.date_of_joining, r.resignation_date, r.exited_in_month),
    });
  });

  rows.sort((a, b) => String(a.employee_name || "").localeCompare(String(b.employee_name || "")) || a.employee_id - b.employee_id);
  return rows;
}

/* ---------------------------------------------------------------- filters */

function normalizeFilters({ store_id = null, department_id = null, designation_id = null } = {}) {
  return {
    store_id: idOrNull(store_id),
    department_id: idOrNull(department_id),
    designation_id: idOrNull(designation_id),
  };
}

function matches(row, f) {
  if (f.store_id !== null && row.store_id !== f.store_id) return false;
  if (f.department_id !== null && row.department_id !== f.department_id) return false;
  if (f.designation_id !== null && row.designation_id !== f.designation_id) return false;
  return true;
}

function applyFilters(rows, filters) {
  const f = normalizeFilters(filters);
  return rows.filter((row) => matches(row, f));
}

function countBy(rows, idKey, nameKey) {
  const map = new Map();
  rows.forEach((row) => {
    const id = row[idKey];
    if (id === null || id === undefined) return;
    const entry = map.get(id) || { id, name: row[nameKey] || `#${id}`, count: 0 };
    entry.count += 1;
    map.set(id, entry);
  });
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * THE DEPENDENT CHOICES, from the month's own population in scope - so a
 * branch-scoped user is never offered a branch, department or designation
 * that only exists among employees they may not see. Departments are those
 * within the chosen location; designations those within the chosen location
 * AND department. A selection that is no longer offered is still listed (with
 * count 0) so the control can show it and the user can clear it.
 */
function filterOptions(rows, filters) {
  const f = normalizeFilters(filters);
  const atLocation = rows.filter((r) => f.store_id === null || r.store_id === f.store_id);
  const atDepartment = atLocation.filter((r) => f.department_id === null || r.department_id === f.department_id);
  const keep = (list, id) =>
    id === null || list.some((o) => o.id === id) ? list : [...list, { id, name: `#${id}`, count: 0 }];
  return {
    locations: keep(countBy(rows, "store_id", "store_name"), f.store_id),
    departments: keep(countBy(atLocation, "department_id", "department_name"), f.department_id),
    designations: keep(countBy(atDepartment, "designation_id", "designation_name"), f.designation_id),
  };
}

/* ------------------------------------------------------------- aggregates */

function sumFigures(rows) {
  const t = { costed: 0, gross: 0, deductions: 0, net: 0, pf: 0, esi: 0, advance: 0, other: 0 };
  rows.forEach((row) => {
    if (!row.figures) return;
    t.costed += 1;
    ["gross", "deductions", "net", "pf", "esi", "advance", "other"].forEach((k) => {
      t[k] += row.figures[k];
    });
  });
  return t;
}

function kpis(rows) {
  const initialized = rows.filter((r) => r.initialized).length;
  const t = sumFigures(rows);
  return {
    total_employees: rows.length,
    initialized,
    not_initialized: rows.length - initialized,
    payroll_cost: rupees(t.gross),
    total_deductions: rupees(t.deductions),
    net_payable: rupees(t.net),
    costed_employees: t.costed,
    uncosted_initialized: initialized - t.costed,
  };
}

function groupKey(row, by) {
  switch (by) {
    case "location":
      return { id: row.store_id, name: row.store_name };
    case "department":
      return { id: row.department_id, name: row.department_name };
    case "designation":
      return { id: row.designation_id, name: row.designation_name };
    case "employment_type":
      return { id: row.employment_type, name: row.employment_type };
    default:
      return { id: null, name: null };
  }
}

function headcount(rows) {
  const out = {};
  GROUP_BY.forEach((by) => {
    const map = new Map();
    rows.forEach((row) => {
      const g = groupKey(row, by);
      const id = g.id === null || g.id === undefined ? NONE : String(g.id);
      const entry = map.get(id) || {
        id,
        name: id === NONE ? "Not set" : g.name || `#${g.id}`,
        count: 0,
        initialized: 0,
      };
      entry.count += 1;
      if (row.initialized) entry.initialized += 1;
      map.set(id, entry);
    });
    out[by] = [...map.values()].sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
  });
  return out;
}

/**
 * THE DEDUCTION BREAKDOWN. PT and Income Tax / TDS are listed because payroll
 * users look for them - and listed as NOT TRACKED, with no amount: DnDS
 * stores no monthly figure for either (`constants/payroll_report_catalogue.js`),
 * and a zero would be a statement nobody made.
 */
const DEDUCTIONS = [
  { key: "PF", label: "PF (employee)", field: "pf", metric: METRIC.DED_PF },
  { key: "ESI", label: "ESI (employee)", field: "esi", metric: METRIC.DED_ESI },
  { key: "PT", label: "Professional Tax", field: null },
  { key: "IT", label: "Income Tax / TDS", field: null },
  { key: "ADVANCE", label: "Advance Recovery", field: "advance", metric: METRIC.DED_ADVANCE },
  { key: "OTHER", label: "Other (shortage, missing hours)", field: "other", metric: METRIC.DED_OTHER },
];

function earnings(rows) {
  const t = sumFigures(rows);
  return {
    gross: rupees(t.gross),
    net: rupees(t.net),
    deductions: rupees(t.deductions),
    costed_employees: t.costed,
    breakdown: DEDUCTIONS.map((d) => ({
      key: d.key,
      label: d.label,
      tracked: d.field !== null,
      amount: d.field === null ? null : rupees(t[d.field]),
      employees: d.field === null ? null : rows.filter((r) => r.figures && r.figures[d.field] !== 0).length,
      metric: d.metric || null,
    })),
  };
}

const COMPARISON = [
  { key: "EMPLOYEE_COUNT", label: "Employee Count", count: true },
  { key: "INITIALIZED", label: "Initialized", count: true },
  { key: "GROSS", label: "Gross Wages", field: "gross" },
  { key: "NET", label: "Net Payable", field: "net" },
  { key: "DEDUCTIONS", label: "Total Deductions", field: "deductions" },
  { key: "PF", label: "PF (employee)", field: "pf" },
  { key: "ESI", label: "ESI (employee)", field: "esi" },
  { key: "PT", label: "Professional Tax", untracked: true },
  { key: "IT", label: "Income Tax / TDS", untracked: true },
  { key: "ADVANCE", label: "Advance Recovery", field: "advance" },
];

/** Selected month vs the comparison month: values, difference, % change. */
function comparison(baseRows, compareRows, base, compare) {
  const b = sumFigures(baseRows);
  const c = sumFigures(compareRows);
  const valueOf = (rows, t, m) => {
    if (m.key === "EMPLOYEE_COUNT") return rows.length;
    if (m.key === "INITIALIZED") return rows.filter((r) => r.initialized).length;
    return t[m.field];
  };
  return {
    base: { ...base, label: longLabel(base.year, base.month) },
    compare: { ...compare, label: longLabel(compare.year, compare.month) },
    metrics: COMPARISON.map((m) => {
      if (m.untracked) {
        return { key: m.key, label: m.label, tracked: false, money: true, base: null, compare: null, difference: null, percent: null };
      }
      const bv = valueOf(baseRows, b, m);
      const cv = valueOf(compareRows, c, m);
      const diff = bv - cv;
      const fmt = (v) => (m.count ? v : rupees(v));
      return {
        key: m.key,
        label: m.label,
        tracked: true,
        money: !m.count,
        base: fmt(bv),
        compare: fmt(cv),
        difference: fmt(diff),
        percent: cv === 0 ? null : Math.round((diff / Math.abs(cv)) * 1000) / 10,
      };
    }),
  };
}

const MOVEMENT = [
  { key: "JOINED", label: "New Joined", flag: "joined", metric: METRIC.MOVE_JOINED },
  { key: "REJOINED", label: "Rejoined", flag: "rejoined", metric: METRIC.MOVE_REJOINED },
  { key: "RESIGNED", label: "Resigned / Exited", flag: "resigned", metric: METRIC.MOVE_RESIGNED },
];

function peopleMovement(rows) {
  return MOVEMENT.map((m) => {
    const group = rows.filter((r) => r.movement[m.flag]);
    const t = sumFigures(group);
    return {
      key: m.key,
      label: m.label,
      metric: m.metric,
      count: group.length,
      costed_employees: t.costed,
      payroll_cost: rupees(t.gross),
      deductions: rupees(t.deductions),
      net_wages: rupees(t.net),
    };
  });
}

/* --------------------------------------------------------- action required */

const hasBlocker = (row, code) => row.blockers.some((b) => b.code === code);
const hasInitReason = (row, code) => row.init_reasons.some((b) => b.code === code);

/**
 * WHAT IS STOPPING THE MONTH, each item one rule the payrun already applies.
 * Nothing here is a new validation: every predicate reads a status, a
 * blocking reason or a blocker the two stages computed, except NEGATIVE_NET_PAY,
 * which reads the stored net pay itself.
 *
 * `target` is where the payroll user fixes it: the Payrun stage and card.
 */
const ACTIONS = [
  {
    key: "NOT_INITIALIZED_READY",
    label: "Ready to initialize",
    description: "Eligible employees whose payroll month has not been initialized yet.",
    severity: "medium",
    test: (r) => !r.initialized && r.init_status === STATUS_GROUP.READY,
    target: { stage: "INITIALIZATION", card: "READY" },
  },
  {
    key: "SALARY_NOT_APPROVED",
    label: "Salary configuration issues",
    description: "No approved salary is effective for the month, so the employee cannot be initialized.",
    severity: "high",
    test: (r) => !r.initialized && hasInitReason(r, BLOCK_REASON.SALARY_NOT_APPROVED),
    target: { stage: "INITIALIZATION", card: "BLOCKED" },
  },
  {
    key: "STATUTORY_SETUP",
    label: "PF / ESI configuration issues",
    description: "PF / ESI applicability or identifiers are missing (initialization blocker or calculation hold).",
    severity: "high",
    test: (r) =>
      r.initialized
        ? r.statutory_hold || hasBlocker(r, READY_BLOCKER.STATUTORY_SETUP_INCOMPLETE)
        : hasInitReason(r, BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE),
    target: null, // decided by who is affected - see actionItems
  },
  {
    key: "ATTENDANCE_NEEDS_ACTION",
    label: "Payroll attendance pending",
    description: "Attendance is not settled or has pending regularization / OT requests.",
    severity: "high",
    test: (r) => r.initialized && r.attendance_needs_action,
    target: { stage: "CALCULATION", card: CALC_CARD.ATTENDANCE_NEEDS_ACTION },
  },
  {
    key: "ADJUSTMENT_PENDING",
    label: "Adjustments not confirmed",
    description: "Neither an adjustment recorded nor 'no adjustment' confirmed.",
    severity: "medium",
    test: (r) => r.initialized && hasBlocker(r, READY_BLOCKER.ADJUSTMENT_PENDING_CONFIRMATION),
    target: { stage: "ADJUSTMENTS", card: "NO_ADJUSTMENT_PENDING_CONFIRMATION" },
  },
  {
    key: "NOT_CALCULATED",
    label: "Not calculated",
    description: "Initialized employees with no calculation yet.",
    severity: "medium",
    test: (r) => r.calc_status === CALC_STATUS.NOT_CALCULATED,
    target: { stage: "CALCULATION", card: CALC_CARD.NOT_CALCULATED },
  },
  {
    key: "RECALCULATION_REQUIRED",
    label: "Recalculation required",
    description: "A salary, attendance, adjustment or statutory source changed after calculation.",
    severity: "high",
    test: (r) => r.calc_status === CALC_STATUS.RECALCULATION_REQUIRED,
    target: { stage: "CALCULATION", card: CALC_CARD.RECALCULATION_REQUIRED },
  },
  {
    key: "CALCULATION_INCOMPLETE",
    label: "Payroll calculation errors",
    description: "The calculation left a statutory figure unresolved or did not complete.",
    severity: "high",
    test: (r) =>
      r.initialized &&
      (hasBlocker(r, READY_BLOCKER.CALCULATION_INCOMPLETE) ||
        r.recalculation_reasons.some((x) => x.code === "CALCULATION_FAILED")),
    target: { stage: "CALCULATION", card: CALC_CARD.ALL },
  },
  {
    key: "NEGATIVE_NET_PAY",
    label: "Negative net pay",
    description: "Deductions exceed earnings in the stored calculation.",
    severity: "high",
    test: (r) => Boolean(r.figures) && r.figures.net < 0,
    target: { stage: "CALCULATION", card: CALC_CARD.ALL },
  },
  {
    key: "PENDING_APPROVAL",
    label: "Pending payroll verification",
    description: "Calculated and ready, waiting for Approve & Lock.",
    severity: "low",
    test: (r) => r.calc_status === CALC_STATUS.READY_FOR_APPROVAL,
    target: { stage: "CALCULATION", card: CALC_CARD.READY_FOR_APPROVAL },
  },
];

function actionOf(key) {
  return ACTIONS.find((a) => a.key === key) || null;
}

function actionItems(rows) {
  return ACTIONS.map((a) => {
    const affected = rows.filter(a.test);
    let target = a.target;
    if (!target) {
      target = affected.some((r) => r.initialized)
        ? { stage: "CALCULATION", card: CALC_CARD.ALL }
        : { stage: "INITIALIZATION", card: "BLOCKED" };
    }
    return {
      key: a.key,
      label: a.label,
      description: a.description,
      severity: a.severity,
      count: affected.length,
      metric: `ACTION_${a.key}`,
      target,
    };
  });
}

/* ------------------------------------------------------------- drill-down */

/** The employees behind one number. `null` when the metric is not known. */
function selectRows(rows, { metric, group_by = null, group_id = null }) {
  const m = String(metric || "").toUpperCase();
  const fig = (field) => (r) => Boolean(r.figures) && r.figures[field] !== 0;
  switch (m) {
    case METRIC.ALL:
      return rows;
    case METRIC.INITIALIZED:
      return rows.filter((r) => r.initialized);
    case METRIC.NOT_INITIALIZED:
      return rows.filter((r) => !r.initialized);
    case METRIC.COSTED:
      return rows.filter((r) => Boolean(r.figures));
    case METRIC.DED_PF:
      return rows.filter(fig("pf"));
    case METRIC.DED_ESI:
      return rows.filter(fig("esi"));
    case METRIC.DED_ADVANCE:
      return rows.filter(fig("advance"));
    case METRIC.DED_OTHER:
      return rows.filter(fig("other"));
    case METRIC.MOVE_JOINED:
      return rows.filter((r) => r.movement.joined);
    case METRIC.MOVE_REJOINED:
      return rows.filter((r) => r.movement.rejoined);
    case METRIC.MOVE_RESIGNED:
      return rows.filter((r) => r.movement.resigned);
    case METRIC.HEADCOUNT: {
      if (!GROUP_BY.includes(group_by)) return null;
      const wanted = group_id === null || group_id === undefined ? NONE : String(group_id);
      return rows.filter((r) => {
        const g = groupKey(r, group_by);
        const id = g.id === null || g.id === undefined ? NONE : String(g.id);
        return id === wanted;
      });
    }
    default: {
      if (m.startsWith("ACTION_")) {
        const action = actionOf(m.slice("ACTION_".length));
        return action ? rows.filter(action.test) : null;
      }
      return null;
    }
  }
}

function presentRow(row) {
  const f = row.figures;
  const money = (k) => (f ? rupees(f[k]) : null);
  const reasons = row.initialized
    ? [...row.blockers, ...row.recalculation_reasons].map((b) => b.label)
    : row.init_reasons.map((b) => b.label);
  return {
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    location: row.store_name,
    department: row.department_name,
    designation: row.designation_name,
    employment_type: row.employment_type,
    date_of_joining: row.date_of_joining,
    resignation_date: row.resignation_date,
    initialized: row.initialized,
    status: row.initialized ? row.calc_status : row.init_status,
    status_label: row.status_label,
    reasons: [...new Set(reasons)],
    gross: money("gross"),
    deductions: money("deductions"),
    net: money("net"),
    pf: money("pf"),
    esi: money("esi"),
    advance: money("advance"),
    other: money("other"),
    stage: row.initialized ? "CALCULATION" : "INITIALIZATION",
  };
}

function drilldown(rows, { page = 1, page_size = 50 } = {}) {
  const size = Math.min(Math.max(Number(page_size) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const t = sumFigures(rows);
  return {
    total: rows.length,
    page: current,
    page_size: size,
    totals: { costed_employees: t.costed, gross: rupees(t.gross), deductions: rupees(t.deductions), net: rupees(t.net) },
    rows: rows.slice((current - 1) * size, current * size).map(presentRow),
  };
}

module.exports = {
  METRIC,
  GROUP_BY,
  NONE,
  ACTIONS,
  toPaise,
  rupees,
  financialYearMonths,
  financialYearOf,
  shortLabel,
  longLabel,
  previousMonth,
  monthStatus,
  buildMonthStrip,
  mergeMonth,
  normalizeFilters,
  applyFilters,
  filterOptions,
  kpis,
  headcount,
  earnings,
  comparison,
  peopleMovement,
  actionItems,
  selectRows,
  presentRow,
  drilldown,
};
