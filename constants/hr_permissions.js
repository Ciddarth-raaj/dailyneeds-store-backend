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

  // Stage 0C / C2. Reading a stored Aadhaar back in full - which PF and ESI
  // filing will need - is a decision above `view_employee_sensitive`: seeing
  // that someone has an Aadhaar ending 4321 is not the same as reading all
  // twelve digits. Declared by the C2 Aadhaar migration, granted to nobody.
  VIEW_AADHAAR_FULL: "view_aadhaar_full",

  // Stage 0C / C2. Running a paid external bank check, and accepting a name
  // that did not quite match, are separate decisions from editing an
  // employee. Declared by the C2 Sandbox migration, granted to nobody.
  VERIFY_EMPLOYEE_BANK: "verify_employee_bank",
  CONFIRM_BANK_NAME_MISMATCH: "confirm_bank_name_mismatch",

  // Stage 0C / C2. Allowing two ACTIVE employees to share one bank account.
  // Declared and granted to NOBODY, including HR Executive: the usual cause
  // of a duplicate is a typo, and whoever typed it should not be the one who
  // waves it through. In practice an administrator, through the user_type 2
  // bypass, with a stated reason that is audited.
  OVERRIDE_DUPLICATE_BANK_ACCOUNT: "override_duplicate_bank_account",

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

  // The Work Shift system - the new payroll/attendance shift master on
  // `work_shift`, and the employee -> work shift mapping on
  // `new_employee.default_work_shift_id`.
  //
  // Its first phase borrowed `view_shift` / `add_shifts` from the LEGACY
  // `shift_master`, which was right while nothing depended on the new master
  // and wrong now: `view_shift` is held today by designations that have
  // nothing to do with payroll (Operations among them), so borrowing it put
  // the roster in front of people who were never meant to see it. These five
  // keys say what they gate and are granted to HR - and, through the
  // middleware's user_type 2 bypass, to administrators - and to nobody else.
  //
  // Five rather than two because the four actions are four decisions:
  //
  //   VIEW_WORK_SHIFTS            read the shift master and its schedules
  //   MANAGE_WORK_SHIFTS          create, edit and activate/deactivate them
  //   VIEW_SHIFT_ASSIGNMENTS      read who is on which shift
  //   ASSIGN_EMPLOYEE_SHIFT       move ONE employee onto a shift
  //   BULK_ASSIGN_EMPLOYEE_SHIFT  move MANY in one action
  //
  // The last two are separate because the blast radius is: correcting one
  // person's roster is an everyday fix, and re-rostering four hundred people
  // in a single click is not. Neither implies the other, and each gates
  // exactly the action it names.
  //
  // These narrow the existing checks and never widen them: every endpoint
  // keeps the employee-master key (`view_employees` / `employee_edit`) it
  // already required, so nobody can reach employee data through a work-shift
  // key they could not reach before.
  VIEW_WORK_SHIFTS: "view_work_shifts",
  MANAGE_WORK_SHIFTS: "manage_work_shifts",
  VIEW_SHIFT_ASSIGNMENTS: "view_shift_assignments",
  ASSIGN_EMPLOYEE_SHIFT: "assign_employee_shift",
  BULK_ASSIGN_EMPLOYEE_SHIFT: "bulk_assign_employee_shift",

  // Reports. Declared by the reports-foundation migration and granted to
  // NOBODY by it.
  //
  // `VIEW_REPORTS` is discovery and preview, and confers no field access of
  // its own: a caller sees exactly the columns their existing B2/B3
  // permissions already allow, so a report cannot become a way around
  // `view_employee_sensitive`. `EXPORT_REPORTS` is the separate decision to
  // take data out of the building in bulk - somebody may reasonably be
  // trusted to look at a screen and not to email a spreadsheet.
  VIEW_REPORTS: "view_reports",
  EXPORT_REPORTS: "export_reports",
  MANAGE_SHARED_REPORT_TEMPLATES: "manage_shared_report_templates",

  // Attendance - Part 1, the raw Biomax punch flow. Declared by the
  // biomax-raw-attendance migration. The three READ keys are granted to HR
  // EXECUTIVE by it; device management is administrators only (no grant, the
  // user_type 2 bypass); re-derivation is granted to nobody and gates no
  // route yet.
  //
  //   VIEW_RAW_ATTENDANCE          the Attendance List (employee x date rows)
  //   EXPORT_RAW_ATTENDANCE        its CSV
  //   VIEW_ATTENDANCE_PUNCH_AUDIT  the Punch Audit tab (one row per physical
  //                                punch, device/location filters) and its CSV.
  //                                Its own key on purpose (D7): reading
  //                                attendance is not the same decision as
  //                                seeing which terminal and IP every punch
  //                                came from.
  //   VIEW_BIOMAX_DEVICES          read the device registry and its history
  //   MANAGE_BIOMAX_DEVICES        add, move, replace, deactivate a device
  //   REDERIVE_ATTENDANCE          reserved: the audited historical
  //                                re-derivation, not built in Part 1
  VIEW_RAW_ATTENDANCE: "view_raw_attendance",
  EXPORT_RAW_ATTENDANCE: "export_raw_attendance",
  VIEW_ATTENDANCE_PUNCH_AUDIT: "view_attendance_punch_audit",
  VIEW_BIOMAX_DEVICES: "view_biomax_devices",
  MANAGE_BIOMAX_DEVICES: "manage_biomax_devices",
  REDERIVE_ATTENDANCE: "rederive_attendance",

  // Historical pull scaffolding. Asking a terminal for backdated punches
  // (GET_LOG_DATA) is its own decision: declared by the historical-pull
  // migration, granted to nobody, so administrators only through the
  // user_type 2 bypass until it is granted deliberately.
  MANAGE_BIOMAX_HISTORICAL_PULL: "manage_biomax_historical_pull",

  // DigiSME Excel attendance import (the permanent fallback path). Its own
  // decision, declared by the import migration and granted to nobody:
  // administrators only, through the user_type 2 bypass, until granted.
  MANAGE_ATTENDANCE_IMPORT: "manage_attendance_import",
};
