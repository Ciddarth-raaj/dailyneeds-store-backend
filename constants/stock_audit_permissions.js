/**
 * Stock Audit & SAPL permission keys - one key per decision, as
 * constants/hr_permissions.js and constants/grn_permissions.js do:
 * `permissions.require(a, b)` is OR, so a route takes exactly ONE key.
 * Mirrored for the web app in components/stockAudit/permissions.js.
 *
 * A key permits an ACTION; it never widens a LOCATION. Which stores a caller
 * sees is decided by the branch scope: own branch, or all five stores with
 * VIEW_ALL_STORES. HR reporting keys grant NO approval or payroll right.
 */
module.exports = Object.freeze({
  VIEW_OWN_PERFORMANCE: "view_own_stock_audit_performance", // employee self-service, own figures only
  VIEW_STORE: "view_stock_audit", // store-wise monitoring, own branch
  VIEW_ALL_STORES: "view_stock_audit_all_stores", // company-wide monitoring
  MANAGE_EMPLOYEE_MAPPING: "manage_stock_audit_employee_mapping",
  MANAGE_CYCLES: "manage_stock_audit_cycles",
  IMPORT_ALLOTMENT: "import_stock_audit_allotment",
  APPROVE_ALLOTMENT_IMPORT: "approve_stock_audit_allotment_import",
  REVIEW_VERIFICATION: "review_stock_audit_verification",
  REVIEW_ELIGIBILITY: "review_stock_audit_eligibility",
  CALCULATE_INCENTIVES: "calculate_stock_audit_incentives",
  APPROVE_INCENTIVES: "approve_stock_audit_incentives", // never one's own
  REVOKE_INCENTIVES: "revoke_stock_audit_incentives",
  MANAGE_POLICY: "manage_stock_audit_policy",
  RUN_SYNC: "run_stock_audit_sync",
  VIEW_SAPL: "view_sapl_leaderboard",
  MANAGE_SAPL: "manage_sapl_competition",
  MANAGE_SAPL_PRIZE: "manage_sapl_prize_distribution",
  VIEW_HR_REPORTS: "view_stock_audit_hr_reports",
  DOWNLOAD_HR_PDF: "download_stock_audit_hr_pdf",
  PROCESS_PAYROLL: "process_stock_audit_payroll",
  MANAGE_ROLES: "manage_stock_audit_roles", // responsible Supervisor / Store Manager / Operations Manager per cycle
  APPROVE_EXCLUSIONS: "approve_stock_audit_exclusions", // never one's own request
});
