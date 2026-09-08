/**
 * Stage 0B / B2 — the permission key each HR endpoint requires.
 *
 * One key per endpoint, never a list: `permissions.require(a, b)` is OR, so
 * passing two keys would weaken the check to either-of rather than both-of.
 * Where two are genuinely required, use `permissions.requireAll(...)`.
 *
 * Reads and writes are separated everywhere, and the employee master is
 * split further: the ordinary directory (`view_employees`) is not the same
 * decision as bank details (`view_banks`), family (`view_family`) or the
 * Aadhaar document (`view_employee_sensitive`). A designation that can see
 * the staff list therefore does not thereby see anyone's bank account.
 *
 * `EDIT_EMPLOYEE_SENSITIVE` is declared by the B2 migration but gates no
 * route yet: writing those fields still goes through `add_employees`, and
 * the field-level split is B3.
 *
 * Not listed, deliberately: `/employee/get-details` and
 * `/designation/permissions`, which every signed-in user needs to bootstrap
 * the app, and which are authenticated-only by design.
 */
module.exports = {
  // employee master
  VIEW_EMPLOYEES: "view_employees",

  // Stage 0C / C2 - the local lifecycle actions. Separate keys because they
  // are separate decisions: recording that somebody has left is not the same
  // authority as correcting their phone number, and `add_employees` cannot
  // express the difference. A designation that holds `add_employees` today
  // receives all four in the C2 migration, so nobody's effective access
  // changes on deploy.
  EMPLOYEE_CREATE: "employee_create",
  EMPLOYEE_EDIT: "employee_edit",
  EMPLOYEE_RESIGN: "employee_resign",
  EMPLOYEE_REJOIN: "employee_rejoin",
  VIEW_EMPLOYEE_LIFECYCLE: "view_employee_lifecycle",

  ADD_EMPLOYEES: "add_employees",
  VIEW_BANKS: "view_banks",
  ADD_BANKS: "add_banks",
  VIEW_FAMILY: "view_family",
  ADD_FAMILY: "add_family",

  // documents
  VIEW_DOCUMENTS: "view_documents",
  ADD_DOCUMENTS: "add_documents",
  VIEW_EMPLOYEE_SENSITIVE: "view_employee_sensitive",
  EDIT_EMPLOYEE_SENSITIVE: "edit_employee_sensitive",

  // salary / advance
  VIEW_SALARY_ADVANCE: "view_salary_advance",
  ADD_SALARY_ADVANCE: "add_salary_advance",

  // resignation
  VIEW_RESIGNATION: "view_resignation",
  ADD_RESIGNATION: "add_resignation",

  // masters
  VIEW_DESIGNATION: "view_designation",
  ADD_DESIGNATION: "add_designation",
  VIEW_DEPARTMENT: "view_department",
  ADD_DEPARTMENT: "add_department",
  VIEW_SHIFT: "view_shift",
  ADD_SHIFTS: "add_shifts",
  VIEW_STORES: "view_stores",
  ADD_STORES: "add_stores",
};
