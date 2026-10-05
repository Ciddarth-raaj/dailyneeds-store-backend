const P = require("./hr_permissions");
const employeeCatalogue = require("./employee_report_catalogue");
const { balancedComponents, toPaise, money } = require("../utils/payslip_snapshot");

/**
 * Payroll Reports - the field catalogue.
 *
 * THE SAME SAFETY MODEL AS `employee_report_catalogue.js`, which this file
 * reuses rather than restates: a caller sends semantic field KEYS and nothing
 * else, and every column, expression and join in a payroll report query is
 * looked up here. An unknown key is rejected, never interpolated.
 *
 * ================================================== WHERE A FIGURE COMES FROM
 *
 * Every field names its `source`, and the picker shows it, because a payroll
 * report mixes three different kinds of truth:
 *
 *   PAYRUN           a figure STORED on the approved `payrun_employee_calculation`
 *                    row. Frozen at approval. Nothing here recalculates it.
 *   PAYRUN_SNAPSHOT  a value the month's `payrun_employee` row froze at payrun
 *                    initialization (name, outlet, designation, joining date,
 *                    structure, UAN / PF / ESI numbers). Historical.
 *   ATTENDANCE_MONTH the attendance month summary the payrun read. It lives in
 *                    tables attendance keeps recalculating, so it is shown ONLY
 *                    while that summary is still the exact one the payrun read
 *                    (`calculated_at` unchanged). Once attendance is corrected
 *                    after payroll, these cells go blank and the Attendance
 *                    Snapshot Status column says why - a later correction never
 *                    silently rewrites September.
 *   CURRENT_MASTER   the Employee Master AS IT IS TODAY. The payrun does not
 *                    snapshot these (bank details, mobile, PAN, ...), so a
 *                    historical month shows the current value, and says so.
 *
 * Two snapshot fields fall back to the live master when the snapshot is empty -
 * UAN and ESI/IP number - exactly as `usecase/payrun_calculation.js#getEcr`
 * does for UAN: a number recorded after initialization is the same member's
 * identity, not a different historical value.
 *
 * Department is snapshotted as an ID; its NAME is the department's current
 * name (`snap_department`), which only differs if the department was renamed.
 *
 * ============================================================ NOT AVAILABLE
 *
 * DnDS stores no monthly figure for TDS, loan recovery, penalty, holidays,
 * paid leave or permission counts, so there are no such fields. Inventing a
 * zero for them would be a statement nobody made.
 *
 * ============================================================= PERMISSIONS
 *
 * Reaching the dataset already requires `view_payroll` + `view_salary` (see
 * the routes), so pay figures carry no extra key. Identifiers carry exactly
 * the key B3 gives them elsewhere: UAN, PF number, ESI number, PF/ESI
 * applicability and every bank field are `view_employee_sensitive`. The
 * Employee Master group inherits each field's permission from the Employee
 * Master catalogue unchanged, so Reports is never a way around B3.
 */

const SOURCE = {
  PAYRUN: "PAYRUN",
  PAYRUN_SNAPSHOT: "PAYRUN_SNAPSHOT",
  ATTENDANCE_MONTH: "ATTENDANCE_MONTH",
  CURRENT_MASTER: "CURRENT_MASTER",
  COMPUTED: "COMPUTED",
};

const SOURCE_LABEL = {
  PAYRUN: "Finalized payrun",
  PAYRUN_SNAPSHOT: "Payrun-time snapshot",
  ATTENDANCE_MONTH: "Attendance month read by the payrun",
  CURRENT_MASTER: "Current Employee Master",
  COMPUTED: "Computed for the report",
};

const TYPE = { TEXT: "text", NUMBER: "number", AMOUNT: "amount", DATE: "date" };

/* --------------------------------------------------------------- helpers */

const asAmount = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const asNumber = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asText = (value) => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
};

const TRISTATE = (value) => {
  if (value === null || value === undefined || value === "") return "Not recorded";
  return Number(value) === 1 ? "Yes" : "No";
};

const STATUTORY_STATUS = (value) => {
  if (value === "APPLIED") return "Applied";
  if (value === "NOT_APPLICABLE") return "Not applicable";
  if (value === "PENDING") return "Pending";
  return asText(value);
};

/** The attendance month is the one the payrun read, and nobody has recalculated it since. */
const ATTENDANCE_FRESH =
  "(amp.attendance_monthly_payroll_id IS NOT NULL AND amp.calculated_at = c.attendance_calculated_at)";
const fresh = (expr) => `IF(${ATTENDANCE_FRESH}, ${expr}, NULL)`;

/** Earned salary components - the payslip's own split of the stored Salary Earnings. */
const EARNED_SELECTS = {
  earnings: "c.salary_earnings",
  basic: "pe.basic",
  hra: "pe.hra",
  conveyance: "pe.conveyance",
  special_allowance: "pe.special_allowance",
};
const earnedComponent = (index) => (v) => {
  const total = toPaise(v.earnings);
  if (total === null) return null;
  const split = balancedComponents(
    total,
    [v.basic, v.hra, v.conveyance, v.special_allowance].map(toPaise)
  );
  if (!split) return null;
  return asAmount(money(split.parts[index]));
};

const f = (key, label, group, spec) => ({
  key,
  label,
  group,
  type: TYPE.TEXT,
  source: SOURCE.PAYRUN,
  enabled: true,
  ...spec,
});

/**
 * THE PAYRUN ROW'S OWN STATE. Every employee in the month's payrun is in the
 * report; a figure is shown only when that employee's calculation is
 * APPROVED_LOCKED (see `utils/payroll_report_query.js#finalizedOnly`), and
 * this column says what the row is when it is not.
 */
const PAYRUN_STATUS =
  "CASE WHEN c.payrun_calculation_id IS NULL THEN 'NOT_CALCULATED' " +
  "WHEN c.status = 'APPROVED_LOCKED' AND c.published_at IS NOT NULL THEN 'PUBLISHED' " +
  "WHEN c.status = 'APPROVED_LOCKED' THEN 'APPROVED_LOCKED' " +
  "WHEN c.unlocked_at IS NOT NULL THEN 'UNLOCKED' ELSE 'PENDING_APPROVAL' END";
/**
 * In the words of the payrun's own state model: a calculation is
 * CALCULATED or APPROVED_LOCKED (`payrun_employee_calculation.status`),
 * published when `published_at` is set, and was unlocked for correction when
 * `unlocked_at` is set on a row that is CALCULATED again. Every non-final
 * label says "Not Finalized" first, so a blank figure is never read as zero.
 */
const PAYRUN_STATUS_LABEL = {
  NOT_CALCULATED: "Not Finalized - Not Calculated",
  PENDING_APPROVAL: "Not Finalized - Pending Approval",
  UNLOCKED: "Not Finalized - Unlocked for correction (Not Locked)",
  APPROVED_LOCKED: "Finalized - Approved & Locked",
  PUBLISHED: "Finalized - Published",
};
const FINAL_STATUSES = new Set(["APPROVED_LOCKED", "PUBLISHED"]);
/** The month's pay type: the approved calculation's, else the payrun snapshot's. */
const PAY_TYPE = "IF(c.status = 'APPROVED_LOCKED', c.pay_type, pe.pay_type)";

/* ---------------------------------------------------------------- groups */

const G = {
  EMPLOYEE: "Employee (as at payrun)",
  EARNINGS: "Payroll - Earnings",
  DEDUCTIONS: "Payroll - Deductions",
  NET: "Payroll - Totals",
  EMPLOYER: "Employer Contributions",
  STATUTORY: "Statutory (EPF / ESI)",
  ATTENDANCE: "Attendance / Payroll Days",
  BANK: "Bank (current master)",
  RECORD: "Payrun Record",
  MASTER: "Employee Master (current)",
};

const PAYROLL_FIELDS = [
  /* ------------------------------------------------ employee, as at payrun */
  f("employee_id", "Employee ID", G.EMPLOYEE, { select: "pe.employee_id", type: TYPE.NUMBER, transform: asNumber }),
  f("employee_name", "Employee Name", G.EMPLOYEE, { select: "pe.employee_name", source: SOURCE.PAYRUN_SNAPSHOT }),
  f("outlet", "Outlet", G.EMPLOYEE, { select: "pe.store_name", source: SOURCE.PAYRUN_SNAPSHOT, sort: "pe.store_name" }),
  f("department", "Department", G.EMPLOYEE, {
    select: "snap_department.department_name", join: "snap_department", source: SOURCE.PAYRUN_SNAPSHOT,
    note: "Department as at payrun; shown under the department's current name.",
  }),
  f("outlet_department", "Outlet / Department", G.EMPLOYEE, {
    select: "CONCAT_WS(' / ', pe.store_name, snap_department.department_name)",
    join: "snap_department", source: SOURCE.PAYRUN_SNAPSHOT,
  }),
  f("designation", "Designation", G.EMPLOYEE, { select: "pe.designation_name", source: SOURCE.PAYRUN_SNAPSHOT }),
  f("date_of_joining", "Date of Joining", G.EMPLOYEE, {
    select: "DATE_FORMAT(pe.date_of_joining, '%Y-%m-%d')", sort: "pe.date_of_joining",
    type: TYPE.DATE, source: SOURCE.PAYRUN_SNAPSHOT,
  }),
  f("last_working_day", "Last Working Day", G.EMPLOYEE, {
    select: "DATE_FORMAT(pe.resignation_date, '%Y-%m-%d')", sort: "pe.resignation_date",
    type: TYPE.DATE, source: SOURCE.PAYRUN_SNAPSHOT,
  }),
  f("pay_type", "Pay Type", G.EMPLOYEE, { select: PAY_TYPE, always: true }),
  f("uan", "UAN", G.EMPLOYEE, {
    select: "COALESCE(NULLIF(TRIM(pe.uan), ''), NULLIF(TRIM(new_employee.uan), ''))",
    join: "new_employee", source: SOURCE.PAYRUN_SNAPSHOT,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    note: "Payrun snapshot; the current UAN is used only when none was recorded at payrun (same rule as the ECR).",
  }),
  f("pf_member_id", "PF Member ID", G.EMPLOYEE, {
    select: "pe.pf_number", source: SOURCE.PAYRUN_SNAPSHOT,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
  }),
  f("esi_number", "ESI / IP Number", G.EMPLOYEE, {
    select: "COALESCE(NULLIF(TRIM(pe.esi_number), ''), NULLIF(TRIM(new_employee.esi_number), ''))",
    join: "new_employee", source: SOURCE.PAYRUN_SNAPSHOT,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    note: "Payrun snapshot; the current IP number is used only when none was recorded at payrun.",
  }),
  f("pf_applicable", "PF Applicable", G.EMPLOYEE, {
    select: "pe.pf_applicable", transform: TRISTATE, source: SOURCE.PAYRUN_SNAPSHOT,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
  }),
  f("esi_applicable", "ESI Applicable", G.EMPLOYEE, {
    select: "pe.esi_applicable", transform: TRISTATE, source: SOURCE.PAYRUN_SNAPSHOT,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
  }),
  f("payroll_month", "Payroll Month", G.EMPLOYEE, { post: "period", source: SOURCE.COMPUTED }),

  /* ------------------------------------------------------------- earnings */
  f("monthly_gross", "Monthly Gross (structure)", G.EARNINGS, { select: "c.monthly_gross", type: TYPE.AMOUNT, transform: asAmount }),
  f("daily_rate", "Daily Rate", G.EARNINGS, { select: "c.daily_rate", type: TYPE.AMOUNT, transform: asAmount }),
  f("structure_basic", "Basic (structure)", G.EARNINGS, { select: "pe.basic", type: TYPE.AMOUNT, transform: asAmount, source: SOURCE.PAYRUN_SNAPSHOT }),
  f("structure_hra", "HRA (structure)", G.EARNINGS, { select: "pe.hra", type: TYPE.AMOUNT, transform: asAmount, source: SOURCE.PAYRUN_SNAPSHOT }),
  f("salary_earnings", "Salary Earnings", G.EARNINGS, { select: "c.salary_earnings", type: TYPE.AMOUNT, transform: asAmount }),
  f("basic", "Basic", G.EARNINGS, { selects: EARNED_SELECTS, compute: earnedComponent(0), type: TYPE.AMOUNT, note: "Earned Basic, split exactly as on the payslip." }),
  f("hra", "HRA", G.EARNINGS, { selects: EARNED_SELECTS, compute: earnedComponent(1), type: TYPE.AMOUNT, note: "Earned HRA, split exactly as on the payslip." }),
  f("conveyance", "Conveyance", G.EARNINGS, { selects: EARNED_SELECTS, compute: earnedComponent(2), type: TYPE.AMOUNT }),
  f("special_allowance", "Special Allowance", G.EARNINGS, { selects: EARNED_SELECTS, compute: earnedComponent(3), type: TYPE.AMOUNT }),
  f("extra_day_amount", "Extra Days Amount", G.EARNINGS, { select: "c.extra_day_amount", type: TYPE.AMOUNT, transform: asAmount }),
  f("incentive", "Incentive", G.EARNINGS, { select: "c.incentive", type: TYPE.AMOUNT, transform: asAmount }),
  f("bonus", "Bonus", G.EARNINGS, { select: "c.bonus", type: TYPE.AMOUNT, transform: asAmount }),
  f("arrears", "Arrears", G.EARNINGS, { select: "c.arrears", type: TYPE.AMOUNT, transform: asAmount }),
  f("other_earnings", "Other Earnings", G.EARNINGS, {
    select: "(COALESCE(c.extra_day_amount, 0) + COALESCE(c.bonus, 0) + COALESCE(c.arrears, 0))",
    type: TYPE.AMOUNT, transform: asAmount, note: "Extra Days + Bonus + Arrears.",
  }),
  f("approved_ot_hours", "OT Hours (approved)", G.EARNINGS, { select: "c.approved_ot_hours", type: TYPE.NUMBER, transform: asNumber }),
  f("approved_ot_minutes", "OT Minutes (approved)", G.EARNINGS, { select: "c.approved_ot_minutes", type: TYPE.NUMBER, transform: asNumber }),
  f("ot_hourly_rate", "OT Rate (per hour)", G.EARNINGS, {
    select: "c.ot_hourly_rate", type: TYPE.AMOUNT, transform: asAmount,
    note: "Blank when the month was priced at more than one rate (see the payslip's OT breakup).",
  }),
  f("ot_amount", "OT Amount", G.EARNINGS, { select: "c.ot_amount", type: TYPE.AMOUNT, transform: asAmount }),
  f("gross_salary", "Gross Salary", G.EARNINGS, { select: "c.total_earnings", type: TYPE.AMOUNT, transform: asAmount }),

  /* ----------------------------------------------------------- deductions */
  f("employee_pf", "PF (Employee)", G.DEDUCTIONS, { select: "c.employee_pf", type: TYPE.AMOUNT, transform: asAmount }),
  f("employee_esi", "ESI (Employee)", G.DEDUCTIONS, { select: "c.employee_esi", type: TYPE.AMOUNT, transform: asAmount }),
  f("advance_recovery", "Advance Recovery", G.DEDUCTIONS, { select: "c.advance_recovery", type: TYPE.AMOUNT, transform: asAmount }),
  f("shortage_recovery", "Other Deduction (Shortage Recovery)", G.DEDUCTIONS, { select: "c.shortage_recovery", type: TYPE.AMOUNT, transform: asAmount }),
  f("missing_hours_deduction", "Missing Hours Deduction", G.DEDUCTIONS, { select: "c.missing_hours_deduction", type: TYPE.AMOUNT, transform: asAmount }),
  f("total_deductions", "Total Deductions", G.DEDUCTIONS, { select: "c.total_employee_deductions", type: TYPE.AMOUNT, transform: asAmount }),
  f("balance_advance", "Balance Advance (informational)", G.DEDUCTIONS, { select: "c.balance_advance", type: TYPE.AMOUNT, transform: asAmount }),

  /* --------------------------------------------------------------- totals */
  f("net_pay_rounding", "Net Pay Rounding", G.NET, { select: "c.net_pay_rounding", type: TYPE.AMOUNT, transform: asAmount }),
  f("net_pay", "Net Pay", G.NET, { select: "c.net_pay", type: TYPE.AMOUNT, transform: asAmount }),

  /* ---------------------------------------------------- employer side */
  f("employer_pf_total", "Employer PF (total)", G.EMPLOYER, { select: "c.employer_pf_total", type: TYPE.AMOUNT, transform: asAmount }),
  f("employer_eps", "EPS Contribution", G.EMPLOYER, { select: "c.employer_eps", type: TYPE.AMOUNT, transform: asAmount }),
  f("employer_epf", "Employer EPF Balance / Difference", G.EMPLOYER, { select: "c.employer_epf", type: TYPE.AMOUNT, transform: asAmount }),
  f("edli", "EDLI Contribution", G.EMPLOYER, { select: "c.edli", type: TYPE.AMOUNT, transform: asAmount }),
  f("pf_admin_charge", "PF Admin Charge", G.EMPLOYER, { select: "c.pf_admin_charge", type: TYPE.AMOUNT, transform: asAmount }),
  f("employer_esi", "ESI (Employer)", G.EMPLOYER, { select: "c.employer_esi", type: TYPE.AMOUNT, transform: asAmount }),

  /* ------------------------------------------------------------ statutory */
  f("pf_status", "PF Status", G.STATUTORY, { select: "c.pf_status", transform: STATUTORY_STATUS }),
  f("epf_wages", "EPF Wages", G.STATUTORY, { select: "c.pf_wage", type: TYPE.AMOUNT, transform: asAmount }),
  f("eps_wages", "EPS Wages", G.STATUTORY, { select: "c.eps_wage", type: TYPE.AMOUNT, transform: asAmount }),
  f("edli_wages", "EDLI Wages", G.STATUTORY, { select: "c.edli_wage", type: TYPE.AMOUNT, transform: asAmount }),
  f("ncp_days", "NCP Days", G.STATUTORY, { select: "c.ncp_days", type: TYPE.NUMBER, transform: asNumber }),
  f("eps_status", "EPS Eligibility / Status", G.STATUTORY, {
    select:
      "CASE WHEN c.pf_status <> 'APPLIED' THEN c.pf_status " +
      "WHEN c.eps_wage IS NULL THEN 'UNRESOLVED' " +
      "WHEN c.eps_wage > 0 THEN 'EPF_EPS' ELSE 'EPF_ONLY' END",
    transform: (v) =>
      ({ EPF_EPS: "EPF + EPS", EPF_ONLY: "EPF only (no EPS)", UNRESOLVED: "EPS unresolved", PENDING: "PF pending", NOT_APPLICABLE: "Not a PF member" }[v] || asText(v)),
  }),
  f("pf_scenario", "PF Scenario", G.STATUTORY, { select: "c.pf_scenario" }),
  f("epf_validation", "EPF Validation Status", G.STATUTORY, { post: "epf_validation", source: SOURCE.COMPUTED }),
  f("esi_status", "ESI Eligibility / Status", G.STATUTORY, { select: "c.esi_status", transform: STATUTORY_STATUS }),
  f("esi_wages", "ESI Wages", G.STATUTORY, { select: "c.esi_wage", type: TYPE.AMOUNT, transform: asAmount }),
  f("esi_days", "ESI Number of Days", G.STATUTORY, { select: "c.salary_days", type: TYPE.NUMBER, transform: asNumber }),
  f("esi_zero_reason", "ESI Zero-wage Reason", G.STATUTORY, { post: "esi_reason", source: SOURCE.COMPUTED }),
  f("esi_last_working_day", "ESI Last Working Day", G.STATUTORY, { post: "esi_lwd", source: SOURCE.COMPUTED, type: TYPE.DATE }),
  f("esi_validation", "ESI Validation Status", G.STATUTORY, { post: "esi_validation", source: SOURCE.COMPUTED }),

  /* -------------------------------------------------- attendance / days */
  f("paid_days", "Paid Days", G.ATTENDANCE, { select: "c.salary_days", type: TYPE.NUMBER, transform: asNumber }),
  f("lop_days", "LOP Days", G.ATTENDANCE, {
    select: "c.ncp_days", type: TYPE.NUMBER, transform: asNumber,
    note: "Days in the month's salary base that were not paid (the NCP days the payrun stored).",
  }),
  f("payable_days", "Payable Days", G.ATTENDANCE, {
    select: "IF(c.ncp_days IS NULL, NULL, c.salary_days + c.ncp_days)", type: TYPE.NUMBER, transform: asNumber,
    note: "The month's salary base: Paid Days + LOP Days.",
  }),
  f("extra_days", "Extra Days", G.ATTENDANCE, { select: "c.extra_days", type: TYPE.NUMBER, transform: asNumber }),
  f("shortage_hours", "Shortage (hours)", G.ATTENDANCE, {
    select: "ROUND(c.missing_hours_minutes / 60, 2)", type: TYPE.NUMBER, transform: asNumber,
  }),
  f("ot_hours_days", "OT Hours", G.ATTENDANCE, { select: "c.approved_ot_hours", type: TYPE.NUMBER, transform: asNumber }),
  f("present_days", "Present Days", G.ATTENDANCE, {
    select: fresh("amp.attendance_days"), join: "amp", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("weekly_off", "Weekly Off (notional)", G.ATTENDANCE, {
    select: fresh("amp.notional_offs"), join: "amp", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("days_in_employment", "Days in Employment (month)", G.ATTENDANCE, {
    select: fresh("amp.available_dates"), join: "amp", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("absent_days", "Absent Days", G.ATTENDANCE, {
    select: fresh("COALESCE(adc.absent_days, 0)"), join: "adc", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("late_days", "Late (days)", G.ATTENDANCE, {
    select: fresh("COALESCE(adc.late_days, 0)"), join: "adc", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("early_out_days", "Early Out (days)", G.ATTENDANCE, {
    select: fresh("COALESCE(adc.early_out_days, 0)"), join: "adc", type: TYPE.NUMBER, transform: asNumber, source: SOURCE.ATTENDANCE_MONTH,
  }),
  f("attendance_snapshot_status", "Attendance Snapshot Status", G.ATTENDANCE, {
    select:
      `CASE WHEN amp.attendance_monthly_payroll_id IS NULL THEN 'NOT_LINKED' WHEN ${ATTENDANCE_FRESH} THEN 'UNCHANGED' ELSE 'CHANGED' END`,
    join: "amp", source: SOURCE.COMPUTED,
    transform: (v) =>
      ({ NOT_LINKED: "No attendance month linked", UNCHANGED: "As read by the payrun", CHANGED: "Changed after payrun - not shown" }[v] || v),
  }),

  /* ------------------------------------------------- bank (current master) */
  f("bank_name", "Bank Name", G.BANK, {
    select: "new_employee.bank_name", join: "new_employee", source: SOURCE.CURRENT_MASTER,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
  }),
  f("bank_account_number", "Account Number", G.BANK, {
    select: "new_employee.account_no", join: "new_employee", source: SOURCE.CURRENT_MASTER,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    note: "Full account number - the payrun does not snapshot bank details, so this is today's value.",
  }),
  f("bank_ifsc", "IFSC", G.BANK, {
    select: "new_employee.ifsc", join: "new_employee", source: SOURCE.CURRENT_MASTER,
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
  }),

  /* --------------------------------------------------------- the record */
  f("payrun_status", "Payrun Status", G.RECORD, { select: PAYRUN_STATUS, always: true, transform: (v) => PAYRUN_STATUS_LABEL[v] || v }),
  f("approved_at", "Approved At", G.RECORD, { select: "DATE_FORMAT(c.approved_at, '%Y-%m-%d %H:%i')", type: TYPE.DATE, always: true }),
  f("published_at", "Published At", G.RECORD, { select: "DATE_FORMAT(c.published_at, '%Y-%m-%d %H:%i')", type: TYPE.DATE, always: true }),
  f("calculation_revision", "Calculation Revision", G.RECORD, { select: "c.calculation_revision", type: TYPE.NUMBER, transform: asNumber, always: true }),
];

/* ------------------------------------------ employee master, as it is today */

/**
 * Employee Master keys the payrun already snapshots. They are NOT offered a
 * second time from the live master: one report with two "Outlet" columns
 * that disagree for anybody who transferred is a trap, and the snapshot is the
 * historically right answer. The rest of the Employee Master catalogue is
 * offered as it stands - same SELECT, same JOIN, same permission, same
 * transform - under an `em_` key, so a field added there appears here.
 */
const SNAPSHOTTED_MASTER_KEYS = new Set([
  "employee_id",
  "employee_name",
  "outlet",
  "department",
  "designation",
  "date_of_joining",
  "resignation_date",
  "uan",
  "pf_number",
  "esi_number",
  "pf_applicable",
  "esi_applicable",
  "bank_name",
  "account_no",
  "ifsc",
]);

const MASTER_PREFIX = "em_";

const MASTER_FIELDS = employeeCatalogue.FIELDS.filter(
  (m) => m.enabled && m.group !== "Payroll" && !SNAPSHOTTED_MASTER_KEYS.has(m.key)
).map((m) => ({
  key: `${MASTER_PREFIX}${m.key}`,
  label: m.label,
  group: G.MASTER,
  subgroup: m.group,
  type: TYPE.TEXT,
  source: SOURCE.CURRENT_MASTER,
  select: m.select,
  // `new_employee` first: every Employee Master expression addresses it.
  join: m.join ? ["new_employee", `em:${m.join}`] : "new_employee",
  transform: m.transform,
  permission: m.permission,
  sensitive: Boolean(m.sensitive),
  enabled: true,
}));

const FIELDS = [...PAYROLL_FIELDS, ...MASTER_FIELDS];

/* ------------------------------------------------------------------ joins */

/**
 * Fixed join text, keyed by name. `em:<name>` reuses the Employee Master
 * catalogue's own join text verbatim. `adc` is the only join that takes
 * parameters - the month's date range - and they are bound, never spliced.
 */
const JOINS = {
  new_employee: { sql: "LEFT JOIN new_employee ON new_employee.employee_id = pe.employee_id" },
  snap_department: {
    sql: "LEFT JOIN department snap_department ON snap_department.department_id = pe.department_id",
  },
  amp: {
    sql: "LEFT JOIN attendance_monthly_payroll amp ON amp.attendance_monthly_payroll_id = c.attendance_monthly_payroll_id",
  },
  adc: {
    requires: ["amp"],
    sql: [
      "LEFT JOIN (",
      "  SELECT d.employee_id,",
      "         SUM(d.status = 'ABSENT') AS absent_days,",
      "         SUM(COALESCE(d.late_minutes, 0) > 0) AS late_days,",
      "         SUM(COALESCE(d.early_exit_minutes, 0) > 0) AS early_out_days",
      "    FROM attendance_day_calculation d",
      "   WHERE d.attendance_date BETWEEN ? AND ?",
      "   GROUP BY d.employee_id",
      ") adc ON adc.employee_id = pe.employee_id",
    ].join("\n"),
    params: (period) => [period.from, period.to],
  },
};
for (const [name, sql] of Object.entries(employeeCatalogue.JOINS)) {
  JOINS[`em:${name}`] = { sql, requires: ["new_employee"] };
}

const GROUP_ORDER = [G.EMPLOYEE, G.EARNINGS, G.DEDUCTIONS, G.NET, G.EMPLOYER, G.STATUTORY, G.ATTENDANCE, G.BANK, G.RECORD, G.MASTER];

const BY_KEY = new Map(FIELDS.map((x) => [x.key, x]));
const getField = (key) => (typeof key === "string" ? BY_KEY.get(key) || null : null);

/** The field keys a SELECT needs to resolve, in order: one alias per select. */
const selectsOf = (field) => {
  if (field.post) return {};
  if (field.selects) return field.selects;
  return { v: field.select };
};

/** Totals make sense for a stored amount with a single SQL expression. */
const isSummable = (field) => field.type === TYPE.AMOUNT && Boolean(field.select) && !field.post;

module.exports = {
  SOURCE,
  SOURCE_LABEL,
  TYPE,
  G,
  FIELDS,
  PAYROLL_FIELDS,
  MASTER_FIELDS,
  MASTER_PREFIX,
  JOINS,
  GROUP_ORDER,
  BY_KEY,
  getField,
  selectsOf,
  isSummable,
  ATTENDANCE_FRESH,
  SNAPSHOTTED_MASTER_KEYS,
  PAYRUN_STATUS,
  PAYRUN_STATUS_LABEL,
  FINAL_STATUSES,
  PAY_TYPE,
};
