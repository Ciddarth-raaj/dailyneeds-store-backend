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

  // M1 - Employee Master restructure. The two post-onboarding sections a
  // store manager never completes, each behind its own key so that Payment
  // Details (Cash/Bank and the account) and Statutory Details (PAN, PF, ESI)
  // can be granted separately. Both still sit UNDER B3: the columns stay in
  // `constants/sensitive_fields.js`, so `edit_employee_sensitive` is required
  // as well, and the M1 migration grants these only to designations that
  // already hold `add_employees` together with `edit_employee_sensitive` -
  // nobody's effective access changes on deploy.
  EDIT_PAYMENT_DETAILS: "edit_payment_details",
  EDIT_STATUTORY_DETAILS: "edit_statutory_details",

  // M2 - Salary and payroll. Declared by the M2 migration and granted to
  // NOBODY by it, so administrators only (through the user_type 2 bypass)
  // until a designation is granted one deliberately on the Designation screen.
  //
  // These are the most powerful rights in the HR system - what everyone is
  // paid, and the authority to change it - so there is deliberately no
  // inheritance rule handing them to whoever already holds `add_employees` or
  // `edit_employee_sensitive`. Recording somebody's PAN and deciding their pay
  // are not the same authority, and an inheritance rule is how the second
  // quietly follows the first onto thirty designations nobody re-examined.
  //
  //   VIEW_SALARY                       read a structure and its history
  //   ADD_SALARY                        propose an initial salary
  //   EDIT_SALARY                       amend a PENDING proposal
  //   MANUAL_SALARY_COMPONENT_OVERRIDE  depart from the automatic Basic
  //   APPROVE_SALARY_REVISION           approve or reject - the money decision
  //   VIEW_PAYROLL                      the Payroll section (M1 placeholder)
  //   PROCESS_PAYROLL                   run a period (not built in M2)
  //   HR_REPORTS                        HR / payroll reporting
  //
  // ADD and APPROVE are separate on purpose. Nothing is ever created APPROVED,
  // including by an administrator: if proposing a salary also agreed it, the
  // approval key would be decorative.
  //
  // MANUAL_SALARY_COMPONENT_OVERRIDE is separate from ADD/EDIT for the same
  // reason. Entering a salary is an everyday HR act; moving Basic away from
  // the automatic breakup changes the PF wage and therefore what is filed, so
  // it is a second decision and is granted to far fewer people.
  VIEW_SALARY: "view_salary",
  ADD_SALARY: "add_salary",
  EDIT_SALARY: "edit_salary",
  MANUAL_SALARY_COMPONENT_OVERRIDE: "manual_salary_component_override",
  APPROVE_SALARY_REVISION: "approve_salary_revision",
  VIEW_PAYROLL: "view_payroll",
  PROCESS_PAYROLL: "process_payroll",
  HR_REPORTS: "hr_reports",

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

  // Attendance v2 - the calculation engine and its monthly payroll roll-up.
  //
  // Reading calculated minutes and RE-RUNNING the engine are separate keys
  // because a recalculation rewrites what payroll will read; and the monthly
  // roll-up is a third, because somebody entitled to see how long a colleague
  // worked is not thereby entitled to see what those minutes are worth.
  //
  // `manage_employee_break_override` changes somebody's NRM, and therefore
  // their pay, so the migration grants it to NOBODY - an administrator grants
  // it deliberately on the designation screen.
  VIEW_CALCULATED_ATTENDANCE: "view_calculated_attendance",
  RECALCULATE_ATTENDANCE: "recalculate_attendance",
  VIEW_ATTENDANCE_PAYROLL: "view_attendance_payroll",
  MANAGE_EMPLOYEE_BREAK_OVERRIDE: "manage_employee_break_override",

  // Attendance v2 / A3 - missing-punch regularization and OT approval.
  //
  // Raising a request for YOURSELF and raising one for SOMEBODY ELSE are two
  // keys, because a manager filing on a team member's behalf is a different
  // act from an employee filing their own.
  //
  // `approve_attendance_regularization` is permission to reach the decision
  // endpoint; it is NOT authority over a particular stage. That is decided by
  // `utils/attendance_approval_chain.js#canApprove` from the caller's mapped
  // approval role and outlet, so holding this key without the right role
  // decides nothing. The migration grants it to nobody.
  RAISE_ATTENDANCE_REGULARIZATION: "raise_attendance_regularization",
  RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS:
    "raise_attendance_regularization_for_others",
  APPROVE_ATTENDANCE_REGULARIZATION: "approve_attendance_regularization",
  VIEW_ATTENDANCE_APPROVALS: "view_attendance_approvals",
  MANAGE_ATTENDANCE_APPROVAL_ROLES: "manage_attendance_approval_roles",

  // Attendance Approver Setup - the EMPLOYEE-LEVEL chain (First Level, Second
  // Level, Final Approver per employee), Bulk Set and Replace Approver. One
  // key for the screen and every mutation behind it; declared by the
  // approver-setup migration and granted to NOBODY, so administrators only
  // through the user_type 2 bypass until a designation is granted it
  // deliberately. It is NOT handed to HR or managers by any rule here.
  MANAGE_ATTENDANCE_APPROVERS: "manage_attendance_approvers",

  // Attendance v2 / A0 - the AUTHORIZED CORRECTION of a historical shift
  // assignment.
  //
  // The ordinary assignment route dates every change today and has no field
  // for any other date. This is the separate, audited path for a genuine
  // historical mistake: an explicit effective_from, a mandatory note and
  // `source = 'CORRECTION'` on the appended row. It changes what payroll will
  // recalculate for past dates, so the migration grants it to NOBODY -
  // administrators reach it through the user_type 2 bypass, and anybody else
  // is given it deliberately on the designation screen.
  CORRECT_EMPLOYEE_SHIFT_ASSIGNMENT: "correct_employee_shift_assignment",

  // Attendance v2 - the SINGLE-DATE shift edit on the attendance screens.
  //
  // Changes the shift ONE attendance date is calculated under, and nothing
  // else: not the employee's current shift, not the previous date, not the
  // following date. It is deliberately not the correction key above, whose
  // effective-from semantics would move every later date as well. The
  // migration grants it to NOBODY; employees never hold it, and the self-only
  // `/attendance/me` surface has no shift-editing endpoint at all.
  EDIT_ATTENDANCE_DATE_SHIFT: "edit_attendance_date_shift",
};
