/**
 * Stock Audit permission keys - one key per decision, as
 * constants/hr_permissions.js and constants/grn_permissions.js do:
 * `permissions.require(a, b)` is OR, so a route takes exactly ONE key.
 *
 * A key permits an ACTION; it never widens a LOCATION. Which stores a caller
 * may see is decided separately (middlewares/stock_audit_scope.js): their own
 * branch, or every programme store with STOCK_AUDIT_ALL_BRANCHES.
 */
module.exports = Object.freeze({
  // Dashboard and every report, for the caller's branch(es).
  VIEW_STOCK_AUDIT: "view_stock_audit",
  // An employee's OWN performance and incentive - nobody else's.
  VIEW_OWN_PERFORMANCE: "view_own_stock_audit_performance",
  // Every programme store instead of the caller's own branch.
  STOCK_AUDIT_ALL_BRANCHES: "stock_audit_all_branches",
  // Create / edit audit cycles.
  MANAGE_CYCLES: "manage_stock_audit_cycles",
  // Map RetailPilot users to employees (writes wh_rp_staff_map).
  MANAGE_EMPLOYEE_MAPPING: "manage_stock_audit_employee_mapping",
  // Start a synchronization (refused while sync is disabled).
  RUN_SYNC: "run_stock_audit_sync",
  // Draft policy versions (scoring thresholds and methods).
  MANAGE_POLICY: "manage_stock_audit_policy",
  // Confirm or keep unresolved a recount verification.
  REVIEW_VERIFICATION: "review_stock_audit_verification",
  // Decide a Pending Eligibility Review article.
  REVIEW_ELIGIBILITY: "review_stock_audit_eligibility",
  // Preview and calculate incentives.
  CALCULATE_INCENTIVES: "calculate_stock_audit_incentives",
  // Approve incentives and policy versions - never one's own.
  APPROVE_INCENTIVES: "approve_stock_audit_incentives",
  // Revoke an approved incentive.
  REVOKE_INCENTIVES: "revoke_stock_audit_incentives",
  // Hand approved incentives to payroll (posting itself is disabled).
  PROCESS_PAYROLL: "process_stock_audit_payroll",
});
