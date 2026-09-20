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
  // ============================================ EMPLOYEE BRANCH SCOPE ======
  //
  // WHICH BRANCHES' EMPLOYEES A CALLER MAY SEE AND EDIT - and nothing about
  // WHAT they may do to them, which is what every other key below says.
  //
  // Holding it means company-wide employee access: this is how HR is expressed
  // in a rights system whose only shape of right is a boolean key per
  // designation. There is no `is_hr` column on `designation` to read, and
  // inventing one would be a second authorization scheme for one question.
  // An administrator (`user_type` 2) is company-wide by user type and needs no
  // key, exactly as everywhere else.
  //
  // WITHOUT IT, A CALLER IS SCOPED TO THEIR OWN ASSIGNED BRANCH. That is the
  // default and it FAILS CLOSED: a caller whose branch cannot be resolved gets
  // no employees rather than all of them. `view_employees` and `employee_edit`
  // still say WHETHER they may read or write; this says WHERE.
  //
  // The migration grants it to HR EXECUTIVE and to nobody else, so no other
  // designation's effective reach widens on deploy - every one of them
  // narrows, which is the point of the change.
  EMPLOYEE_SCOPE_ALL_BRANCHES: "employee_scope_all_branches",

  // MAY THIS USER OPEN THE ONBOARDING / PENDING HR WORK QUEUE?
  //
  // A SEPARATE DECISION FROM THE KEY ABOVE, AND THAT SEPARATION IS THE WHOLE
  // REASON IT EXISTS. `employee_scope_all_branches` answers "which employees
  // may this caller be shown"; this answers "may this caller open HR's
  // follow-up screen". They travel together for HR today, but they are not
  // the same question, and reusing the scope key for the screen would mean
  // that granting company-wide employee access to any future designation -
  // an Operations lead, a second HR role, an auditor - silently handed them
  // HR's work queue as well. Nobody would have decided that.
  //
  // SO A DESIGNATION CAN HOLD EITHER WITHOUT THE OTHER, deliberately:
  //   this key alone         opens the screen; the employees it shows are
  //                          still whatever the caller's branch scope allows
  //   the scope key alone    company-wide employee reads, no work queue
  //
  // AN ADMINISTRATOR NEEDS NEITHER. `user_type = 2` bypasses the permission
  // table entirely, exactly as it does for every other key here.
  //
  // IT IS NOT `view_employee_sensitive` EITHER. Opening the queue and being
  // told how somebody is paid stay separate keys, so HR without the sensitive
  // key gets the dashboard with the Cash -> Bank card and the Paid by column
  // withheld.
  VIEW_HR_ONBOARDING_DASHBOARD: "view_hr_onboarding_dashboard",

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

  // ============================ THE AADHAAR STATUS READ =====================
  //
  // WHETHER THIS EMPLOYEE HAS A VERIFIED AADHAAR - and, for a caller entitled
  // to the profile, the last four digits and the verified name. Never the
  // number: that is `VIEW_AADHAAR_FULL` above, and it is granted to nobody.
  //
  // WHY THIS KEY HAD TO EXIST. The status endpoint was gated on
  // `view_employee_lifecycle`, which is the EMPLOYMENT HISTORY key - periods,
  // resignations, rejoins. A store manager does not hold it, so the profile
  // told them Aadhaar status was unavailable for employees they had onboarded
  // themselves. Aadhaar identity and employment history are different
  // questions and one must not gate the other.
  //
  // AND WHY NOT AN EXISTING KEY. `view_employees` is the staff list, and
  // putting a verified legal name and last four digits behind it would widen
  // that list for everyone who holds it. `view_employee_sensitive` is the
  // right SHAPE but far too broad - it also opens salary, bank and PAN, which
  // is precisely what a store manager must not gain in order to see an
  // Aadhaar badge. Neither is a fit, so this is its own narrow decision.
  //
  // THERE IS DELIBERATELY NO MATCHING EDIT KEY. Attaching a verified Aadhaar
  // is already `employee_edit` + branch scope, which is correct and already
  // works; a second key for the same act would duplicate a working rule and
  // lock HR out until it was granted.
  //
  // IT GRANTS NO BRANCH. Like every other key here it says WHAT may be done,
  // never WHERE - `employee_scope_all_branches` and the branch resolver decide
  // that, and the route applies both.
  //
  // THE MIGRATION GRANTS IT ONLY FOR CONTINUITY - to designations that already
  // hold `view_employee_lifecycle`, which is exactly who can read this status
  // today - and to HR EXECUTIVE by name. STORE MANAGERS ARE NOT GRANTED IT BY
  // MIGRATION: an administrator ticks it for their designation on the rights
  // screen. Inferring it from `employee_create` / `employee_edit` was tried
  // and rejected - those keys reach well beyond Store Manager - and guessing
  // a designation by name is what `20260919120000-attendance-v2-approvals`
  // already records this codebase as refusing to do.
  VIEW_EMPLOYEE_AADHAAR: "view_employee_aadhaar",

  // ====================== THE EXISTING-EMPLOYEE AADHAAR VERIFICATION =======
  //
  // START AND COMPLETE AADHAAR OTP VERIFICATION FOR AN EMPLOYEE WHO ALREADY
  // EXISTS AND WHOSE AADHAAR IS STILL PENDING. Nothing else.
  //
  // WHY IT EXISTS. Roughly six hundred employees predate the Aadhaar flow and
  // carry no identity at all. Completing that backlog is branch work - the
  // store manager knows the person standing in front of them - but the only
  // way to run the OTP flow was `POST /hr/aadhaar/initiate`, which is the
  // ONBOARDING path: gated on `employee_create` and, because its body carries
  // `aadhaar_number`, on `edit_employee_sensitive` through B3's write guard.
  // A store manager holds neither, so the modal on the employee profile
  // ended in "You do not have permission to perform this action". The
  // alternative - granting `edit_employee_sensitive` - would have handed them
  // salary, bank, PAN, PF and ESI writes to fix an Aadhaar badge, which is
  // the opposite of what B3 is for.
  //
  // SO IT IS ITS OWN KEY, AND A DELIBERATELY TEMPORARY ONE. It is the whole
  // reason the key exists as a separate decision: when the old-employee
  // backlog is finished, an administrator unticks ONE box and the ability is
  // gone, with no other capability moving.
  //
  // WHAT IT IS NOT.
  //   not `view_employee_aadhaar`  reading the badge is not running the check
  //   not `employee_edit`          which is still what ATTACHING requires,
  //                                unchanged - the pair is the whole rule
  //   not `edit_employee_sensitive` it grants no bank, PAN, PF or ESI write
  //   not `view_aadhaar_full`      it reads no digit beyond the last four
  //   not `employee_create`        it hires nobody, and creating an employee
  //                                does not require it
  //
  // IT ONLY EVER APPLIES TO A PENDING AADHAAR. The existing-employee routes
  // refuse an employee who is already VERIFIED, so this key can never be used
  // to swap or overwrite a verified identity; that stays an HR/Admin matter.
  //
  // AND IT GRANTS NO BRANCH. Like every key here it says WHAT, never WHERE:
  // the routes apply this key AND the employee branch scope.
  //
  // The migration declares it and grants it to HR EXECUTIVE only, by the one
  // designation name this codebase already relies on. It is NOT inferred from
  // `employee_create`, `employee_edit`, `view_employees` or
  // `view_employee_aadhaar`, and no Store Manager designation is guessed at:
  // an administrator ticks it.
  VERIFY_EMPLOYEE_AADHAAR: "verify_employee_aadhaar",

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

  // The Attendance Dashboard - the management overview of ONE attendance date
  // across the company: headcount, checked in, absence, the four attendance
  // issues and pending OT.
  //
  // ITS OWN KEY, AND A READ-ONLY ONE. It is not `view_calculated_attendance`
  // because that key answers "may this person open one employee's month",
  // and a screen that aggregates everybody is a wider read even though every
  // individual figure behind it is one that key already permits. Giving it a
  // name means a designation can be granted the overview without the
  // per-employee screen, or the other way round.
  //
  // IT GRANTS NO WRITE OF ANY KIND. Holding it does not let anybody approve a
  // request, regularize a punch, edit a time or recalculate a date: every
  // action the dashboard links out to keeps its own existing key and is
  // re-checked by the route that performs it.
  //
  // GRANTED TO NOBODY BY MIGRATION. An aggregate over every employee is a
  // capability rather than a convenience, so it is assigned deliberately, per
  // designation, on the rights screen - not handed out at deploy time to
  // whoever already holds the per-employee read.
  //
  // AND IT DOES NOT SETTLE WHICH BRANCHES. Holding it permits the dashboard;
  // the caller's LOCATION scope is resolved separately and fails closed. See
  // `resolveLocationScope` in `routes/attendance_dashboard.js`.
  VIEW_ATTENDANCE_DASHBOARD: "view_attendance_dashboard",

  // ======================================= MISSING ATTENDANCE REPORT =======
  //
  // The Missing Attendance Report: every COMPLETED past attendance date on
  // which an eligible employee recorded a POSITIVE, ODD number of punches -
  // one punch of a pair never arrived. Zero punches is absence and is not
  // this report; today is never on it, because today is still being punched.
  //
  // TWO KEYS, READ AND EXPORT, exactly as the raw Attendance List has
  // `view_raw_attendance` and `export_raw_attendance`. Taking a spreadsheet
  // of every branch's gaps off the premises is a different decision from
  // looking at the screen, and the split is what lets a manager be given the
  // second without the first, or the first without the second.
  //
  // ITS OWN KEY, NOT `view_attendance_dashboard` AND NOT
  // `view_calculated_attendance`. The dashboard key answers "how is the
  // company doing on ONE date"; the calculated key answers "may this person
  // open ONE employee's month". This is a third question - a cross-employee,
  // cross-date list of one specific defect - and a designation can now be
  // given the chasing list without either of the others.
  //
  // IT GRANTS NO WRITE OF ANY KIND. Holding it regularizes nothing, approves
  // nothing, edits no punch and recalculates no date. The router is GET-only.
  //
  // AND IT DOES NOT SETTLE WHICH BRANCHES. Like every dashboard key, the
  // caller's LOCATION scope is resolved separately by
  // `middlewares/dashboard_scope.js` and fails closed - so a branch manager
  // granted this key sees their own branch and gains no visibility into
  // anybody else's merely because a new report exists.
  //
  // GRANTED TO NOBODY BY MIGRATION. A list of every employee's attendance
  // gaps across every branch is a capability rather than a convenience, so it
  // is assigned deliberately, per designation, on the rights screen.
  VIEW_MISSING_ATTENDANCE_REPORT: "view_missing_attendance_report",
  EXPORT_MISSING_ATTENDANCE_REPORT: "export_missing_attendance_report",

  // ================================================ GLOBAL DASHBOARD ACCESS =
  //
  // ONE FEATURE KEY PER DASHBOARD, and ONE STORE SCOPE shared by all of them.
  // Keeping the two apart is the point: a feature key says which SCREEN may be
  // opened and never which BRANCHES may be seen. `utils/dashboard_scope.js`
  // holds the rule and `middlewares/dashboard_scope.js` applies it.
  //
  // Only Attendance is wired to a route today. The other three are declared so
  // the resolver has a complete vocabulary and a future module can be gated
  // without inventing an authorization scheme of its own - they build no
  // screen, add no route and put nothing in the navigation.
  VIEW_HR_DASHBOARD: "view_hr_dashboard",
  VIEW_SALES_DASHBOARD: "view_sales_dashboard",
  VIEW_MY_DASHBOARD: "view_my_dashboard",

  // THE STORE SCOPE. Exactly one of these applies, enforced on the server:
  // holding both is a configuration fault and is refused rather than resolved
  // to either. An administrator (`user_type` 2) is All Stores by user type and
  // needs neither key. These are deliberately NOT the application-wide
  // `all_stores` permission, which has its own established meaning outside
  // dashboards and is left untouched.
  DASHBOARD_SCOPE_OWN_STORE: "dashboard_scope_own_store",
  DASHBOARD_SCOPE_ALL_STORES: "dashboard_scope_all_stores",

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

  // The EFFECTIVE-DATED permanent shift change ("Edit Shift Assignment").
  //
  // One employee, one new shift, one stated date it applies from, and a
  // mandatory reason. It is neither of the two keys above: `assign` is always
  // dated today and has no date field at all, and the correction key means
  // "the record of the past was wrong". This one means "the roster changes
  // from this date", which may be a past date (if payroll for it is unlocked)
  // or a future one, and it appends a further history row rather than editing
  // or deleting any that exist.
  EDIT_SHIFT_ASSIGNMENT_EFFECTIVE_DATED: "edit_shift_assignment_effective_dated",

  // The employee's ONE-DAY shift change REQUEST - for THEMSELVES only.
  //
  // An employee never changes the effective shift of a date; they ask, and an
  // approver decides. The route derives the employee from the session token
  // and the body has no field to name anybody else, so this key can only ever
  // act on its holder's own attendance.
  RAISE_SHIFT_CHANGE_REQUEST: "raise_shift_change_request",

  // Reaching the shift-request decision endpoint. NOT the authority to decide
  // a particular stage of a particular request - that is `canApprove`, from
  // the actor's mapped approval role, their outlet and whose request it is.
  APPROVE_SHIFT_CHANGE_REQUEST: "approve_shift_change_request",

  // Seeing the Shift tab of the unified Attendance Approval Centre.
  VIEW_SHIFT_CHANGE_REQUESTS: "view_shift_change_requests",

  // Attendance - VOID a raw BIOMAX / IMPORT punch.
  //
  // Excludes ONE raw punch from attendance calculation, with a mandatory
  // reason, by an additive `attendance_punch_void` record; the raw punch row
  // is never deleted or altered. A REGULARIZED punch cannot be voided here -
  // it belongs to the approval workflow. Declared by the punch-void migration
  // and granted to NOBODY: administrators reach it through the user_type 2
  // bypass, anybody else is given it deliberately on the designation screen.
  // Seeing a void in the Punch Audit needs only `view_attendance_punch_audit`.
  VOID_ATTENDANCE_PUNCH: "void_attendance_punch",

  // ======================================== PAYRUN INITIALIZATION ==========
  //
  // CHANGING THE PAY TYPE ON ONE PAYRUN ROW - the monthly Bank <-> Cash
  // decision, for that month and that employee only.
  //
  // THE ONLY NEW KEY THE PAYRUN NEEDED, and the other two decisions reuse what
  // M2 already declared for exactly this purpose:
  //
  //   view_payroll     opening the Payrun screen and reading a month
  //   process_payroll  INITIALIZING a month. M2 declared this key as "run a
  //                    payroll period (not built in M2)" and this is that act;
  //                    a new `initialize_payrun` beside it would leave
  //                    `process_payroll` gating nothing forever.
  //
  // SO WHY IS THIS ONE SEPARATE. Initializing a month freezes what somebody is
  // OWED. Changing a pay type decides HOW the money reaches them, which is the
  // payment desk's decision rather than the payroll processor's - somebody may
  // reasonably hold either without the other. One key covering both would mean
  // whoever runs the month can also redirect where every payment goes, and
  // nobody would have decided that.
  //
  // IT CHANGES NOTHING IN THE EMPLOYEE MASTER. The key permits a write to ONE
  // payrun row for ONE month; `new_employee.payment_type` is untouched by every
  // path behind it, and editing THAT stays `edit_payment_details` as before.
  //
  // Declared by the payrun migration and granted to NOBODY, so administrators
  // only through the user_type 2 bypass until a designation is given it
  // deliberately on the rights screen.
  CHANGE_PAYRUN_PAY_TYPE: "change_payrun_pay_type",

  // ================================= PAYRUN CALCULATION & APPROVAL =========
  //
  // APPROVING AND LOCKING ONE EMPLOYEE'S CALCULATED MONTH.
  //
  // THE ONLY NEW KEY THE CALCULATION STAGE NEEDED, and everything else in it
  // reuses what already exists:
  //
  //   view_payroll / view_salary / view_employees   reading a calculated
  //                    month, which shows per-employee net pay across the
  //                    company - the same disclosure the earlier stages are
  //                    governed by
  //   process_payroll  CALCULATING and RECALCULATING. Initialization claimed
  //                    this key for Initialize and Adjustments for entering
  //                    figures; computing the month from them is the same
  //                    person doing the same job one stage later.
  //
  // SO WHY IS THIS ONE SEPARATE. This repository already separates proposing
  // from approving wherever money is concerned - `add_salary` and
  // `approve_salary_revision` are two keys for exactly this reason - and this
  // approval is stronger than a salary approval: it LOCKS the employee's
  // month, after which the figures cannot be recalculated, the adjustments
  // cannot be edited and the pay type cannot be changed. Letting
  // `process_payroll` do it would mean the person who enters an incentive also
  // signs it off, which is the separation of duties payroll exists to keep.
  //
  // IT IS NOT A SECOND WAY TO DO SOMETHING THAT ALREADY HAS A KEY - the test
  // the Adjustments stage applied when it declined to add one. Nothing in the
  // system today can approve or lock a payroll month, so this gates an act
  // rather than duplicating one.
  //
  // Declared by the calculation migration and granted to NOBODY, so
  // administrators only through the user_type 2 bypass until a designation is
  // given it deliberately on the rights screen.
  APPROVE_PAYRUN: "approve_payrun",

  // ================================= CLOSE ATTENDANCE FOR PAYROLL ==========
  //
  // ACCEPTING THE ATTENDANCE AS IT STANDS, for one employee and one month, so
  // that payroll can close a month rather than wait indefinitely for a missing
  // punch nobody is going to regularize.
  //
  // WHY IT IS ITS OWN KEY AND NOT ONE OF THE THREE THAT EXIST.
  //
  //   NOT `process_payroll`. That key enters incentives and calculates, and it
  //            is held by whoever works the month. Folding this into it would
  //            silently hand every existing holder the power to waive a gate
  //            that decides what somebody is paid - a widening nobody granted.
  //
  //   NOT `approve_payrun`. This repository separates proposing from approving
  //            wherever money is concerned; `add_salary` and
  //            `approve_salary_revision` are two keys for exactly that reason.
  //            One person who could both waive the attendance gate and then
  //            sign the month off is that separation undone.
  //
  // SO THE MONTH TAKES THREE HANDS where it matters: the processor prepares
  // it, somebody holding THIS key accepts the attendance basis, and the
  // approver signs it. Any two of them may be the same person where an
  // organization chooses that - but it has to be chosen, on the rights screen,
  // rather than inherited.
  //
  // WHAT IT DOES NOT GRANT. It decides no attendance request. A holder cannot
  // approve a regularization, grant OT or alter a punch through it; those
  // remain the attendance screens' own keys. It records a PAYROLL decision
  // about attendance that is already unresolved.
  //
  // Declared by the attendance-close migration and granted to NOBODY, so it
  // reaches a designation only by a deliberate grant; administrators keep the
  // existing user_type 2 bypass.
  CLOSE_PAYRUN_ATTENDANCE: "close_payrun_attendance",
};
