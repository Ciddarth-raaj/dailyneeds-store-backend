/**
 * Payroll Reports - the report types.
 *
 * Each type is a POPULATION (which of the month's PAYRUN employees it covers) plus a
 * DEFAULT column set. Every type reads the same catalogue and the same one
 * query path (`utils/payroll_report_query.js`); a type adds a WHERE condition
 * from the fixed text below and nothing else.
 *
 * `dataset_key` is what a saved template is filed under in `report_template`,
 * so templates are per report type and reusable across months.
 */

const REPORT_TYPE = {
  PAYROLL_REGISTER: "PAYROLL_REGISTER",
  EPF: "EPF",
  ESI: "ESI",
  BANK: "BANK",
  OT: "OT",
  DEDUCTIONS: "DEDUCTIONS",
  ATTENDANCE: "ATTENDANCE",
};

const REPORT_TYPES = {
  [REPORT_TYPE.PAYROLL_REGISTER]: {
    key: REPORT_TYPE.PAYROLL_REGISTER,
    label: "Payroll Register",
    dataset_key: "PAYROLL_REGISTER",
    population: null,
    default_fields: ["employee_id", "employee_name", "outlet_department", "paid_days", "gross_salary", "total_deductions", "net_pay"],
  },
  [REPORT_TYPE.EPF]: {
    key: REPORT_TYPE.EPF,
    label: "EPF",
    dataset_key: "PAYROLL_EPF",
    // PF members and the unresolved: a pending PF question is exactly who an
    // EPF report has to show, not hide.
    // The SAME rule as the ECR's statutory population
    // (`utils/payroll_statutory_files.js#validateEpf`): the stored PF status
    // where the employee has a calculation, the payrun snapshot otherwise.
    population: "IF(c.payrun_calculation_id IS NULL, COALESCE(pe.pf_applicable, 0) = 1, COALESCE(c.pf_status, '') <> 'NOT_APPLICABLE')",
    statutory_file: "ECR",
    default_fields: [
      "employee_id", "employee_name", "uan", "pf_member_id", "gross_salary", "epf_wages", "eps_wages",
      "edli_wages", "employee_pf", "employer_eps", "employer_epf", "ncp_days", "eps_status", "epf_validation",
    ],
  },
  [REPORT_TYPE.ESI]: {
    key: REPORT_TYPE.ESI,
    label: "ESI",
    dataset_key: "PAYROLL_ESI",
    population: "IF(c.payrun_calculation_id IS NULL, COALESCE(pe.esi_applicable, 0) = 1, COALESCE(c.esi_status, '') <> 'NOT_APPLICABLE')",
    statutory_file: "ESIC",
    default_fields: [
      "employee_id", "employee_name", "esi_number", "esi_days", "esi_wages", "employee_esi", "employer_esi",
      "esi_status", "esi_zero_reason", "esi_last_working_day", "esi_validation",
    ],
  },
  [REPORT_TYPE.BANK]: {
    key: REPORT_TYPE.BANK,
    label: "Bank",
    dataset_key: "PAYROLL_BANK",
    population: "IF(c.status = 'APPROVED_LOCKED', c.pay_type, pe.pay_type) = 'BANK'",
    default_fields: ["employee_id", "employee_name", "bank_name", "bank_account_number", "bank_ifsc", "net_pay"],
  },
  [REPORT_TYPE.OT]: {
    key: REPORT_TYPE.OT,
    label: "OT",
    dataset_key: "PAYROLL_OT",
    population: "COALESCE(c.approved_ot_minutes, 0) > 0",
    default_fields: ["employee_id", "employee_name", "outlet", "approved_ot_hours", "approved_ot_minutes", "ot_hourly_rate", "ot_amount", "payroll_month"],
  },
  [REPORT_TYPE.DEDUCTIONS]: {
    key: REPORT_TYPE.DEDUCTIONS,
    label: "Deductions",
    dataset_key: "PAYROLL_DEDUCTIONS",
    population: null,
    default_fields: [
      "employee_id", "employee_name", "outlet", "employee_pf", "employee_esi", "advance_recovery",
      "shortage_recovery", "missing_hours_deduction", "total_deductions",
    ],
  },
  [REPORT_TYPE.ATTENDANCE]: {
    key: REPORT_TYPE.ATTENDANCE,
    label: "Attendance / Payroll Days",
    dataset_key: "PAYROLL_ATTENDANCE",
    population: null,
    default_fields: [
      "employee_id", "employee_name", "outlet", "paid_days", "present_days", "absent_days", "weekly_off",
      "lop_days", "payable_days", "ot_hours_days", "shortage_hours", "extra_days", "attendance_snapshot_status",
    ],
  },
};

const REPORT_TYPE_ORDER = [
  REPORT_TYPE.PAYROLL_REGISTER,
  REPORT_TYPE.EPF,
  REPORT_TYPE.ESI,
  REPORT_TYPE.BANK,
  REPORT_TYPE.OT,
  REPORT_TYPE.DEDUCTIONS,
  REPORT_TYPE.ATTENDANCE,
];

const getReportType = (key) => (typeof key === "string" && REPORT_TYPES[key]) || null;
const DATASET_KEYS = REPORT_TYPE_ORDER.map((k) => REPORT_TYPES[k].dataset_key);

/** Display preferences a layout or template may carry. Anything else is dropped. */
const DEFAULT_DISPLAY = Object.freeze({ show_totals: true, sort_by: null, sort_dir: "asc" });

module.exports = {
  REPORT_TYPE,
  REPORT_TYPES,
  REPORT_TYPE_ORDER,
  DATASET_KEYS,
  DEFAULT_DISPLAY,
  getReportType,
};
