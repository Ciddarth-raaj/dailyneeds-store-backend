const P = require("./hr_permissions");
const { PAYMENT_TYPE } = require("./employee_master_sections");
const {
  EMPLOYMENT_TYPES,
  GRADES,
} = require("../utils/employment_classification");

/**
 * Reports — the Employee Master field catalogue.
 *
 * THIS FILE IS THE ONLY PLACE SQL STRUCTURE COMES FROM. A caller sends
 * semantic field keys - `employee_name`, `designation` - and nothing else.
 * Every column name, table name, expression and join in a report query is
 * looked up here by key. No caller string ever becomes SQL: an unknown key is
 * rejected, it is not interpolated. That is the whole safety model, and it is
 * why the catalogue lives in the backend rather than being described by the
 * frontend.
 *
 * ============================================ THE CLASSIFICATION SWEEP ====
 *
 * All 59 columns of `new_employee` were enumerated and classified. The list
 * held against is `EMPLOYEE_MASTER_COLUMNS` in `repository/employee.js` -
 * the Employee Master's own result contract, which
 * `employee_detail_columns.test.js` already holds against the migrations. So
 * a column added to the employee master fails that test until it is listed
 * there, and `employee_report_catalogue.test.js` then fails until it is
 * classified HERE. Every column is accounted for below; none is silently
 * ignored.
 *
 * INCLUDED (42 columns, via the entries in this file):
 *   employee_id, employee_name, father_name, dob, gender, marital_status,
 *   marriage_date, spouse_name, permanent_address, residential_address,
 *   primary_contact_number, alternate_contact_number, email_id, blood_group,
 *   qualification, bank_name, ifsc, account_no, esi_number, pf_number, uan,
 *   store_id, department_id, designation_id, shift_id, previous_experience,
 *   additional_course, date_of_joining, pan_no, payment_type, status,
 *   resignation_date, default_work_shift_id, pf_applicable, esi_applicable,
 *   previous_pf_member, previous_eps_member, attendance_required,
 *   employment_type, grade, extra_break_hours, works_all_locations
 *
 * DELIBERATELY_EXCLUDED (18), each with its reason:
 *   employee_image        operational/internal - a base64 LONGTEXT blob; not
 *                         meaningful in a spreadsheet cell
 *   introducer_name       operational/internal - recruitment referral notes
 *   introducer_details    operational/internal, LONGTEXT free text
 *   salary                LEGACY/UNOWNED - a free-text VARCHAR(45) holding one
 *                         undated number. M2 neither reads it nor copies from
 *                         it, and the Employee Master's Payroll section does
 *                         not show it. What IS reported is the current
 *                         APPROVED `employee_salary` structure, in the Payroll
 *                         group below, behind `view_salary`. Exporting this
 *                         column beside those figures would put two different
 *                         answers to "what is this person paid" in one row
 *   esi                   deprecated/legacy - superseded by esi_number and by
 *                         esi_applicable; free text with no agreed meaning
 *   pf                    deprecated/legacy - superseded by pf_number,
 *                         pf_applicable and previous_pf_member, same
 *   uniform_qty           operational/internal issue tracking
 *   online_portal         auth/internal - portal access flag
 *   telegram_username     operational/internal messaging handle
 *   aadhaar_card_no       ENCRYPTED/SECURITY - the legacy plaintext Aadhaar
 *                         column. B3 treats it as sensitive and C2 replaced
 *                         it; a full Aadhaar must never be exportable, so it
 *                         has no catalogue entry AT ALL rather than a gated
 *                         one (§30)
 *   aadhaar_card_name     security - part of the same legacy Aadhaar record.
 *                         The C2 VERIFIED name is reported instead, as
 *                         `aadhaar_name`, behind `view_employee_aadhaar`
 *   aadhaar_card_image    security - document storage internals
 *   shift_code            sync artefact - a Digisme-era code duplicating
 *                         shift_id; the resolved shift name is exported
 *                         instead
 *   special_break_override_minutes
 *                         ATTENDANCE ENGINE CONFIGURATION, not an employee
 *                         master field. It is set on the attendance screens
 *                         behind `manage_employee_break_override`, appears
 *                         nowhere on the Employee Master, and means nothing
 *                         without the NRM rules that read it
 *   source_system         sync provenance - which system delivered this row
 *   source_employee_code  sync provenance - that system's own identifier
 *   created_at            operational/internal row metadata
 *   updated_at            operational/internal row metadata
 *
 * NOT `new_employee` COLUMNS, and reported from their own tables:
 *   employee_aadhaar_identity  aadhaar_status, aadhaar_last4, aadhaar_name
 *   employee_bank_verification bank_status
 *   employee_salary            the twelve Payroll fields - the CURRENT
 *                              APPROVED structure as at today, resolved by the
 *                              same rule `repository/employee_salary.js`
 *                              #getCurrentSalary uses
 *   outlets / department / designation / shift_master / work_shift
 *                              the resolved LABEL for a foreign key, which is
 *                              what the Employee Master displays
 *
 * ------------------------------------------------------------- join scope
 * `join_footprint` records what a field costs to resolve, so the resolver can
 * add only the joins the selected fields actually need:
 *
 *   base         a column on new_employee
 *   lookup       one LEFT JOIN to a master (outlets / department /
 *                designation / shift_master / work_shift)
 *   c2_identity  the C2 Aadhaar identity table
 *   c2_bank      the C2 bank verification, resolved through C2's own status
 *                logic rather than read raw
 *   m2_salary    the CURRENT APPROVED `employee_salary` row, pinned by a
 *                correlated subquery so the join can never multiply a row
 *   derived      computed from a base column, no extra table
 *
 * ------------------------------------------------------- history_backed
 * Forward-compatibility metadata only. Nothing consumes it yet. It marks the
 * four fields that a future as-at resolver could answer historically, if the
 * frozen effective-dated redesign is ever adopted. It changes no behaviour
 * now, and this report reads CURRENT values only.
 */

/** Masking is applied by the transform, never by trusting the caller. */
const maskAccount = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/[\s-]/g, "");
  if (raw === "") return null;
  if (raw.length <= 4) return "****";
  return "*".repeat(raw.length - 4) + raw.slice(-4);
};

/**
 * A date column, exported as `YYYY-MM-DD`.
 *
 * `date_of_joining` is a real DATE since
 * `20261012120000-employee-joining-date-to-date` and is SELECTed through
 * DATE_FORMAT, so what arrives here is already ISO text. The tolerant branches
 * remain because this transform is shared with values that may still carry a
 * time, and because a report is not the place to start throwing on old data -
 * an unrecognised value is exported verbatim rather than guessed at.
 */
const asDate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // LOCAL getters: the driver builds a DATE at local midnight, so the UTC
    // ones would report the previous day everywhere east of Greenwich.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const head = String(value).trim().split("T")[0].split(" ")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : String(value).trim();
};

const EMPLOYMENT_STATUS_LABEL = (value) => (Number(value) === 1 ? "Active" : "Inactive");

/**
 * A TINYINT(1) that is allowed to be NULL, in words.
 *
 * THREE ANSWERS AND NOT TWO, exactly as the Statutory section of the Employee
 * Master draws them: 1 yes, 0 no, and NULL "Not recorded" - which is a real,
 * permanent state for every employee who predates the column. Exporting NULL
 * as "No" would assert a statutory fact nobody has stated, which is the very
 * inference `20260915120000-m2-salary-engine` refuses to make.
 */
const TRISTATE_LABEL = (value) => {
  if (value === null || value === undefined || value === "") return "Not recorded";
  return Number(value) === 1 ? "Yes" : "No";
};

/**
 * DUTY LOCATION - which outlet's staffing this employee is counted into.
 *
 * REPORTED IN THE WORDS THE SCREENS USE, never as the column name and never
 * as 1/0. `works_all_locations` is a database identifier; nobody reading a
 * staffing report should have to know it, and a bare 1 in a column called
 * "Duty Location" says nothing at all. The two strings below are the same two
 * the employee profile card and the Attendance & Staffing dashboard show, so a
 * report, a profile and a dashboard cannot describe the same person in three
 * different vocabularies.
 *
 * NOT NULL DEFAULT 0, so like `attendance_required` it has exactly two answers
 * and gets its own transform rather than the tri-state one: a "Not recorded"
 * that can never occur is a column nobody can trust. Only a 1 is roaming;
 * anything else - including an absent value the column cannot produce - reads
 * as the fixed outlet, which is the conservative answer and the same one
 * `utils/employee_location.js#worksAllLocations` gives.
 */
const DUTY_LOCATION_LABEL = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return "Fixed outlet";
  return Number(value) === 1 ? "All Locations / Roaming" : "Fixed outlet";
};

const DUTY_LOCATION_OPTIONS = [
  { value: "0", label: "Fixed outlet" },
  { value: "1", label: "All Locations / Roaming" },
];

/**
 * `attendance_required` is NOT NULL DEFAULT 1, so it has only two answers and
 * gets its own transform rather than borrowing the tri-state one above: a
 * "Not recorded" that can never occur is a column nobody can trust.
 */
const ATTENDANCE_REQUIRED_LABEL = (value) => {
  // Only 0 is No. Anything else - including an absent value, which the column
  // cannot produce - is Yes, which is what `AttendanceRequiredSection.jsx`
  // already does with `value !== false`. A report and the profile must not
  // disagree about somebody's attendance expectation.
  if (value === null || value === undefined || String(value).trim() === "") return "Yes";
  return Number(value) === 0 ? "No" : "Yes";
};

/**
 * Bank or Cash, from `constants/employee_master_sections.js` - the same 1/2
 * the Employee Master's Payment Details section reads and writes. The column
 * is a VARCHAR, so an unrecognised value is reported as "Not recorded" rather
 * than guessed at in either direction.
 */
/**
 * A money column, as it is stored.
 *
 * DECIMAL arrives from the driver as a string, and it leaves as that string:
 * no rounding, no currency symbol, no thousands separator. A spreadsheet cell
 * holding `45000.00` is a number the reader can sum; one holding `Rs 45,000.00`
 * is text. Formatting is the screen's job and `util/salaryView.js` does it.
 *
 * NULL IS BLANK AND NEVER ZERO. An unresolved statutory figure - the PENDING
 * that `employee_salary` records when a contribution cannot be worked out -
 * is not a contribution of nothing, and printing 0 for it understates what
 * the employee is owed and what the employer will pay.
 */
const asAmount = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value);
};

const PAYMENT_TYPE_LABEL = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return "Not recorded";
  const n = Number(value);
  if (n === PAYMENT_TYPE.BANK) return "Bank";
  if (n === PAYMENT_TYPE.CASH) return "Cash";
  return "Not recorded";
};

/**
 * ============================================== FILTERING THE SELECTED FIELD
 *
 * A selected column that can sensibly be narrowed carries a `filter` here, so
 * that the SAME entry decides what a field is called, how it is selected, who
 * may see it, and how it may be filtered. One catalogue, one authorization
 * check, one place to look. The frontend renders a control from this metadata
 * and never keeps a field list of its own.
 *
 *   ID      an exact match on an identifier
 *   TEXT    contains
 *   ENUM    one of a fixed set this file names
 *   MASTER  one or more ids from an existing master
 *   DATE    from / to, inclusive
 *
 * The client sends a field key and a VALUE. It never sends an operator: the
 * type here decides the comparison, which is what keeps this a filter rather
 * than the query builder §12 rules out.
 *
 * `maps_to` marks the four fields whose filter is one the report API ALREADY
 * had - employment status, outlet, department, designation. Those route onto
 * the existing filter keys rather than growing a second way to say the same
 * thing, so the caller's outlet scope keeps being applied in exactly one
 * place.
 *
 * ------------------------------------------- WHAT DELIBERATELY HAS NO FILTER
 *
 * `account_no` and `aadhaar_last4` are exported MASKED and PARTIAL. A filter
 * on either would compare the stored value, so a permitted user could ask
 * "does anybody's account end 4321" - or worse, walk the full number a
 * character at a time by counting results. A masked column that can be
 * filtered is not masked. They stay selectable and stay masked; they are not
 * filterable, and `filterableFields` is what enforces that.
 */
const FILTER = {
  ID: "id",
  TEXT: "text",
  ENUM: "enum",
  MASTER: "master",
  DATE: "date",
};

/** Fixed option lists, named here so no other layer invents its own. */
const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "active", label: "Currently employed" },
  { value: "inactive", label: "No longer employed" },
  { value: "all", label: "All" },
];

const BANK_STATUS_OPTIONS = [
  { value: "NOT_PROVIDED", label: "Not provided" },
  { value: "PENDING", label: "Pending" },
  { value: "VERIFIED", label: "Verified" },
  { value: "NAME_MISMATCH", label: "Name mismatch" },
  { value: "DUPLICATE_ACCOUNT", label: "Duplicate account" },
  { value: "FAILED", label: "Failed" },
];

const AADHAAR_STATUS_OPTIONS = [
  { value: "VERIFIED", label: "Verified" },
  { value: "PENDING", label: "Pending" },
];

const GENDER_OPTIONS = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
  { value: "Other", label: "Other" },
];

/**
 * The two classification sets, built from `utils/employment_classification.js`
 * rather than spelled again here. That module is what the ENUM columns mirror
 * and what the API validates against, so a value offered here is a value the
 * column can hold - and adding a grade in one place cannot leave the report
 * offering a filter that matches nothing.
 */
const EMPLOYMENT_TYPE_OPTIONS = EMPLOYMENT_TYPES.map((v) => ({ value: v, label: v }));
const GRADE_OPTIONS = GRADES.map((v) => ({ value: v, label: `Grade ${v}` }));

/**
 * YES / NO FOR A NULLABLE FLAG, AND WHY "NOT RECORDED" IS NOT ON THE LIST.
 *
 * An ENUM filter is compiled to `expr = ?`, and nothing equals NULL in SQL -
 * `pf_applicable = 'NULL'` matches no row and would look like a working filter
 * returning an honest empty answer. Rather than grow a second comparison for
 * one option, the filter offers the two values a caller can actually ask for.
 * The COLUMN still exports "Not recorded" through `TRISTATE_LABEL`, so the
 * unrecorded employees are visible - they are simply not filterable to.
 */
const YES_NO_OPTIONS = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];

/** Bank / Cash, by the ids `employee_master_sections.js` defines. */
const PAYMENT_TYPE_OPTIONS = [
  { value: String(PAYMENT_TYPE.BANK), label: "Bank" },
  { value: String(PAYMENT_TYPE.CASH), label: "Cash" },
];

/**
 * Every exportable field. `select` is a fixed SQL expression owned by this
 * file; `alias` is what the row comes back as.
 */
const FIELDS = [
  /* ------------------------------------------------------------ Identity */
  { key: "employee_id", label: "Employee ID", group: "Identity",
    select: "new_employee.employee_id", join_footprint: "base",
    filter: { type: FILTER.ID },
    history_backed: false, default_selected: true, enabled: true },

  { key: "employee_name", label: "Employee Name", group: "Identity",
    select: "new_employee.employee_name", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, default_selected: true, enabled: true },

  { key: "father_name", label: "Father's Name", group: "Identity",
    select: "new_employee.father_name", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "gender", label: "Gender", group: "Identity",
    select: "new_employee.gender", join_footprint: "base",
    filter: { type: FILTER.ENUM, options: GENDER_OPTIONS },
    history_backed: false, enabled: true },

  { key: "date_of_birth", label: "Date of Birth", group: "Identity",
    select: "new_employee.dob", join_footprint: "base", transform: asDate,
    filter: { type: FILTER.DATE },
    history_backed: false, enabled: true },

  { key: "marital_status", label: "Marital Status", group: "Identity",
    select: "new_employee.marital_status", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "spouse_name", label: "Spouse Name", group: "Identity",
    select: "new_employee.spouse_name", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  // ON THE EMPLOYEE MASTER AND THEREFORE HERE. Excluded by the first sweep as
  // "not meaningful to HR reporting"; Personal Details displays it, which
  // settles that question the other way.
  //
  // NO FILTER, DELIBERATELY. The column is VARCHAR(45) with no validated
  // format - unlike `dob` and `date_of_joining`, which are real DATEs - so a
  // from/to range would be a LEXICAL comparison over whatever text is in
  // there, and would quietly omit rows whose value is spelled differently. It
  // is exported, tolerantly, and not filtered on.
  { key: "marriage_date", label: "Marriage Date", group: "Identity",
    select: "new_employee.marriage_date", join_footprint: "base", transform: asDate,
    history_backed: false, enabled: true },

  { key: "blood_group", label: "Blood Group", group: "Identity",
    select: "new_employee.blood_group", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "employment_status", label: "Employment Status", group: "Identity",
    select: "new_employee.status", join_footprint: "derived",
    transform: EMPLOYMENT_STATUS_LABEL,
    // Rides the existing `status` filter rather than adding a second way to
    // say the same thing - see `maps_to` above.
    filter: { type: FILTER.ENUM, options: EMPLOYMENT_STATUS_OPTIONS, maps_to: "status" },
    history_backed: false, default_selected: true, enabled: true },

  /* ---------------------------------------------------------- Employment */
  { key: "date_of_joining", label: "Joining Date", group: "Employment",
    select: "DATE_FORMAT(new_employee.date_of_joining, '%Y-%m-%d')",
    // FILTERED AS A DATE, READ AS TEXT. The predicate addresses the bare
    // column so the range is a DATE comparison MySQL can use the column's own
    // type for; the projection formats it so the value does not leave as a JS
    // Date built at local midnight. Same column, two jobs.
    filter_select: "new_employee.date_of_joining",
    join_footprint: "base", transform: asDate,
    // A real DATE column now, so a range filter is a DATE comparison rather
    // than the lexical one a VARCHAR forced. The column leaves as ISO text
    // because the API pool sets no `dateStrings` and a bare DATE would arrive
    // as a JS Date built at local midnight.
    filter: { type: FILTER.DATE },
    history_backed: false, enabled: true },

  { key: "outlet", label: "Outlet / Branch", group: "Employment",
    select: "outlets.outlet_name", join: "outlets", join_footprint: "lookup",
    filter: { type: FILTER.MASTER, master: "outlets", maps_to: "outlet_ids" },
    history_backed: true, default_selected: true, enabled: true },

  { key: "department", label: "Department", group: "Employment",
    select: "department.department_name", join: "department", join_footprint: "lookup",
    filter: { type: FILTER.MASTER, master: "departments", maps_to: "department_ids" },
    history_backed: true, default_selected: true, enabled: true },

  { key: "designation", label: "Designation", group: "Employment",
    select: "designation.designation_name", join: "designation", join_footprint: "lookup",
    filter: { type: FILTER.MASTER, master: "designations", maps_to: "designation_ids" },
    history_backed: true, default_selected: true, enabled: true },

  // THE LEGACY `shift_master` ROSTER, kept under the key a seeded template
  // already names. It is NOT the work shift the Employment Details section
  // shows today - that is `work_shift` below - and the two are different
  // columns on `new_employee`, so neither can stand in for the other.
  { key: "shift", label: "Shift (legacy)", group: "Employment",
    select: "shift_master.shift_name", join: "shift_master", join_footprint: "lookup",
    filter: { type: FILTER.TEXT },
    history_backed: true, enabled: true },

  // THE WORK SHIFT THE EMPLOYEE MASTER ACTUALLY DISPLAYS, resolved to its name
  // from `new_employee.default_work_shift_id` - the column
  // `repository/employee_work_shift.js` reads and writes. Unassigned is NULL
  // and exports blank, which is a real state and not an error.
  { key: "work_shift", label: "Work Shift", group: "Employment",
    select: "work_shift.shift_name", join: "work_shift", join_footprint: "lookup",
    filter: { type: FILTER.TEXT },
    history_backed: true, enabled: true },

  // CLASSIFICATION ONLY, and no permission of its own. Neither column decides
  // anything in this codebase - not pay, not attendance, not a right - and
  // neither is in `constants/sensitive_fields.js`, so gating them would invent
  // a restriction the Employee Master does not apply.
  { key: "employment_type", label: "Employment Type", group: "Employment",
    select: "new_employee.employment_type", join_footprint: "base",
    filter: { type: FILTER.ENUM, options: EMPLOYMENT_TYPE_OPTIONS },
    history_backed: false, enabled: true },

  { key: "grade", label: "Grade", group: "Employment",
    select: "new_employee.grade", join_footprint: "base",
    filter: { type: FILTER.ENUM, options: GRADE_OPTIONS },
    history_backed: false, enabled: true },

  // WHETHER BIOMETRIC ATTENDANCE IS EXPECTED. Read-only everywhere except an
  // administrator's own toggle, shown to everybody who may see the profile,
  // and not a sensitive field - so it is reportable as it is displayed. It is
  // NOT employment status: an employee with No is active, paid and simply not
  // expected to punch.
  // THE EMPLOYEE'S EXTRA BREAK HOURS. An Employment Details field, edited
  // under the same `employee_edit` key as branch, department and designation
  // and shown to everybody who may see the profile, so it is reported as it
  // is displayed: no permission of its own and not in
  // `constants/sensitive_fields.js`.
  //
  // WHY IT IS HERE AND `special_break_override_minutes` IS NOT. The override
  // is attendance-screen configuration that appears nowhere on the Employee
  // Master; this IS an Employee Master field, recorded on the master and
  // read from it, so the catalogue is where it belongs rather than one
  // report screen's own column list.
  //
  // EXPORTED IN HOURS, AS STORED - the unit the field is labelled in, and a
  // number a spreadsheet can sum. NULL is blank and never 0: "no extra break
  // recorded" and "an extra break of nothing" arrive at the same attendance
  // answer, but a report should not print a figure nobody entered.
  { key: "extra_break_hours", label: "Extra Break Hours", group: "Employment",
    select: "new_employee.extra_break_hours", join_footprint: "base",
    transform: asAmount,
    // EXACT, and deliberately not a range. The question anybody actually asks
    // of this column is "who is set to 0.5" - a small set of agreed values,
    // not a spread - and an exact comparison on a DECIMAL is one MySQL makes
    // numerically, so 0.5 finds the row stored as 0.50.
    filter: { type: FILTER.ID },
    history_backed: false, enabled: true },

  { key: "attendance_required", label: "Attendance Required", group: "Employment",
    select: "new_employee.attendance_required", join_footprint: "base",
    transform: ATTENDANCE_REQUIRED_LABEL,
    filter: { type: FILTER.ENUM, options: YES_NO_OPTIONS },
    history_backed: false, enabled: true },

  /**
   * DUTY LOCATION sits beside Attendance Required and is a DIFFERENT fact.
   * Attendance Required says whether the person is expected to punch at all;
   * this says whether their shift belongs to one outlet's staffing or to none
   * of them individually. The Outlet column keeps its ordinary meaning either
   * way - it is the branch that owns the record, which is why a roaming
   * employee still appears under their branch in an outlet-filtered report.
   */
  { key: "works_all_locations", label: "Duty Location", group: "Employment",
    select: "new_employee.works_all_locations", join_footprint: "base",
    transform: DUTY_LOCATION_LABEL,
    filter: { type: FILTER.ENUM, options: DUTY_LOCATION_OPTIONS },
    history_backed: false, enabled: true },

  // THE DATE RECORDED BY THE RESIGN ACTION. The first sweep excluded it on the
  // grounds that the population never contains anyone who has left - which is
  // true of the HR DIRECTORY and deliberately NOT true here: Reports does not
  // inherit that population rule, and its status filter is what decides who is
  // in the report. So an Inactive report can now say WHEN, which was the one
  // thing it could not.
  { key: "resignation_date", label: "Resignation Date", group: "Employment",
    select: "DATE_FORMAT(new_employee.resignation_date, '%Y-%m-%d')",
    // Filtered on the bare DATE column, projected as ISO text - the same
    // split `date_of_joining` above makes, and for the same reason.
    filter_select: "new_employee.resignation_date",
    join_footprint: "base", transform: asDate,
    filter: { type: FILTER.DATE },
    history_backed: false, enabled: true },

  /* ------------------------------------------------------------- Contact */
  { key: "mobile", label: "Mobile", group: "Contact",
    select: "new_employee.primary_contact_number", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "emergency_contact", label: "Alternate / Emergency Contact", group: "Contact",
    select: "new_employee.alternate_contact_number", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "email", label: "Email", group: "Contact",
    select: "new_employee.email_id", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "permanent_address", label: "Permanent Address", group: "Contact",
    select: "new_employee.permanent_address", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "residential_address", label: "Residential Address", group: "Contact",
    select: "new_employee.residential_address", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  /* ----------------------------------------------------------- Education */
  { key: "qualification", label: "Qualification", group: "Education",
    select: "new_employee.qualification", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "additional_course", label: "Additional Course", group: "Education",
    select: "new_employee.additional_course", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "previous_experience", label: "Previous Experience", group: "Education",
    select: "new_employee.previous_experience", join_footprint: "base",
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  /* ------------------------------------------------------------- Aadhaar */
  // ALL THREE ARE `view_employee_aadhaar`, AND THE NUMBER IS NOWHERE.
  //
  // `hr_permissions.VIEW_EMPLOYEE_AADHAAR` is one narrow decision covering one
  // question - does this employee have a verified Aadhaar, and for a caller
  // entitled to the profile, the last four digits and the verified name. The
  // profile applies it to all three together. Reports applies exactly the same
  // key to the same three, because a report that showed status and last four
  // to anybody holding `view_reports` + `view_employees` would be a way around
  // that narrow right - which is precisely what §A of this catalogue exists to
  // prevent. An earlier revision of this block gated only `aadhaar_name` and
  // called status and last four open; that was wrong, and this is the fix.
  //
  // It is NOT `view_employee_sensitive`: that key is far broader - salary,
  // bank, PAN - and a store manager does not hold it, which is the whole
  // reason `view_employee_aadhaar` exists as its own key.
  //
  // There is deliberately NO full-Aadhaar entry - not a permission-gated one,
  // not a disabled one. A field that does not exist cannot be exported by a
  // bug in a permission check.
  { key: "aadhaar_status", label: "Aadhaar Status", group: "Aadhaar",
    select: "IF(employee_aadhaar_identity.employee_id IS NULL, 'PENDING', 'VERIFIED')",
    join: "aadhaar_identity", join_footprint: "c2_identity",
    permission: P.VIEW_EMPLOYEE_AADHAAR, sensitive: true,
    filter: { type: FILTER.ENUM, options: AADHAAR_STATUS_OPTIONS },
    history_backed: false, enabled: true },

  // The last four digits, and no filter on them - see the masked-column note
  // in the filter section above.
  { key: "aadhaar_last4", label: "Aadhaar Last 4", group: "Aadhaar",
    select: "employee_aadhaar_identity.aadhaar_last4",
    join: "aadhaar_identity", join_footprint: "c2_identity",
    permission: P.VIEW_EMPLOYEE_AADHAAR, sensitive: true,
    history_backed: false, enabled: true },

  // THE VERIFIED LEGAL NAME. It is a name, not an identifier: no digit of the
  // Aadhaar is reachable through it, and the number itself still has no
  // catalogue entry at all.
  { key: "aadhaar_name", label: "Name as per Aadhaar", group: "Aadhaar",
    select: "employee_aadhaar_identity.name_as_per_aadhaar",
    join: "aadhaar_identity", join_footprint: "c2_identity",
    permission: P.VIEW_EMPLOYEE_AADHAAR, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  /* ----------------------------------------------------------- Statutory */
  // B3 removes these from any response for a caller without the key, so the
  // catalogue gates them the same way rather than relying on the filter to
  // blank a column that was already selected.
  { key: "pan_no", label: "PAN", group: "Statutory",
    select: "new_employee.pan_no", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "uan", label: "UAN", group: "Statutory",
    select: "new_employee.uan", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "pf_number", label: "PF Number", group: "Statutory",
    select: "new_employee.pf_number", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "esi_number", label: "ESI Number", group: "Statutory",
    select: "new_employee.esi_number", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  // THE FOUR STATUTORY FACTS THE NUMBERS ABOVE QUALIFY, and every one of them
  // is in `constants/sensitive_fields.js` - so they carry exactly the key the
  // numbers do, and no less. B3's own comment is the rule being followed here:
  // a caller who may not see somebody's PF number has no business learning
  // whether they have one. Gating them any more weakly would make Reports the
  // way around B3 that this catalogue exists to refuse.
  //
  // They are four separate questions and stay four separate columns, for the
  // reason M2 gives: EPF membership and EPS membership have two answers, and
  // the pension split turns on the second one only.
  { key: "pf_applicable", label: "PF Applicable", group: "Statutory",
    select: "new_employee.pf_applicable", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    transform: TRISTATE_LABEL,
    filter: { type: FILTER.ENUM, options: YES_NO_OPTIONS },
    history_backed: false, enabled: true },

  { key: "previous_pf_member", label: "Existing / Previous PF Member", group: "Statutory",
    select: "new_employee.previous_pf_member", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    transform: TRISTATE_LABEL,
    filter: { type: FILTER.ENUM, options: YES_NO_OPTIONS },
    history_backed: false, enabled: true },

  { key: "previous_eps_member", label: "Existing / Previous EPS Member", group: "Statutory",
    select: "new_employee.previous_eps_member", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    transform: TRISTATE_LABEL,
    filter: { type: FILTER.ENUM, options: YES_NO_OPTIONS },
    history_backed: false, enabled: true },

  { key: "esi_applicable", label: "ESI Applicable", group: "Statutory",
    select: "new_employee.esi_applicable", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    transform: TRISTATE_LABEL,
    filter: { type: FILTER.ENUM, options: YES_NO_OPTIONS },
    history_backed: false, enabled: true },

  /* ---------------------------------------------------------------- Bank */
  // The verification STATUS is not sensitive under B3 - knowing an account is
  // unverified is what lets HR chase it, and it discloses nothing about the
  // account. The account itself is, and is exported masked even then.
  // HOW THIS EMPLOYEE IS PAID - the Employee Master's Payment Details section
  // opens with it, and the bank columns below it only matter when it says
  // Bank. It was excluded by the first sweep as "Payroll's", which conflated
  // two different things: what somebody is PAID is Payroll's and stays out of
  // this group, but the payment ROUTE is an employee master field that HR
  // records and maintains.
  //
  // IT KEEPS ITS EXISTING FIELD-LEVEL PERMISSION AND IS NOT WEAKENED. B3 lists
  // `payment_type` in `constants/sensitive_fields.js` and strips it from any
  // response to a caller without `view_employee_sensitive`, so the catalogue
  // demands the same key - the identical treatment `bank_name`, `ifsc` and
  // `account_no` already get.
  { key: "payment_type", label: "Payment Type", group: "Bank",
    select: "new_employee.payment_type", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    transform: PAYMENT_TYPE_LABEL,
    filter: { type: FILTER.ENUM, options: PAYMENT_TYPE_OPTIONS },
    history_backed: false, enabled: true },

  { key: "bank_status", label: "Bank Verification Status", group: "Bank",
    select: "COALESCE(employee_bank_verification.status, 'NOT_PROVIDED')",
    join: "bank_verification", join_footprint: "c2_bank",
    filter: { type: FILTER.ENUM, options: BANK_STATUS_OPTIONS },
    history_backed: false, enabled: true },

  { key: "bank_name", label: "Bank Name", group: "Bank",
    select: "new_employee.bank_name", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  { key: "account_no", label: "Account Number", group: "Bank",
    select: "new_employee.account_no", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true, transform: maskAccount,
    history_backed: false, enabled: true },

  { key: "ifsc", label: "IFSC", group: "Bank",
    select: "new_employee.ifsc", join_footprint: "base",
    permission: P.VIEW_EMPLOYEE_SENSITIVE, sensitive: true,
    filter: { type: FILTER.TEXT },
    history_backed: false, enabled: true },

  /* ------------------------------------------------------------- Payroll */
  //
  // THE CURRENT APPROVED SALARY STRUCTURE - the same figures the Employee
  // Master's Payroll section shows, read from the same table by the same rule.
  //
  // NOT `new_employee.salary`. That column is an undated free-text VARCHAR
  // that M2 neither reads nor copies from, and it has no catalogue entry and
  // is still in `FORBIDDEN_KEYS`. Everything below comes from `employee_salary`
  // through the `current_salary` join, which pins ONE row - the latest APPROVED
  // revision effective on or before today - exactly as
  // `repository/employee_salary.js#getCurrentSalary` resolves it. An employee
  // with no approved salary joins to nothing and every column exports blank,
  // which is the honest answer and not a zero.
  //
  // `view_salary`, AND NOT A NEW RIGHT. M2 declared that key for reading a
  // salary structure and its history, and the Employee Master's Payroll
  // section and the Payroll screens are already gated on it. Reports uses the
  // SAME key, so somebody who cannot see a salary on the profile cannot export
  // one either, and granting the reporting keys confers no pay access
  // whatsoever. Inventing a `report_salary` right would have been a second
  // answer to one question.
  //
  // NOTHING HERE IS CALCULATED. Every figure was computed by the M2 engine
  // when the revision was written, against the statutory snapshot of that
  // moment, and is exported as stored. A report that recomputed a 2026 record
  // against today's rates is how a payslip and a filing quietly stop agreeing.
  //
  // NO AMOUNT IS FILTERABLE. The catalogue has no numeric filter type, and
  // adding one for this would be a query-builder feature rather than a form
  // control - see §12. The effective date is a real DATE and is filterable.
  { key: "salary_effective_from", label: "Salary Effective From", group: "Payroll",
    select: "DATE_FORMAT(employee_salary.effective_from, '%Y-%m-%d')",
    filter_select: "employee_salary.effective_from",
    join: "current_salary", join_footprint: "m2_salary", transform: asDate,
    permission: P.VIEW_SALARY, sensitive: true,
    filter: { type: FILTER.DATE },
    history_backed: false, enabled: true },

  { key: "monthly_gross", label: "Monthly Gross", group: "Payroll",
    select: "employee_salary.monthly_gross",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "daily_salary", label: "Daily Salary (Gross / 26)", group: "Payroll",
    select: "employee_salary.daily_salary",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "basic", label: "Basic", group: "Payroll",
    select: "employee_salary.basic",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "hra", label: "HRA", group: "Payroll",
    select: "employee_salary.hra",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "conveyance", label: "Conveyance", group: "Payroll",
    select: "employee_salary.conveyance",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "special_allowance", label: "Special Allowance", group: "Payroll",
    select: "employee_salary.special_allowance",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "employee_pf", label: "Employee PF", group: "Payroll",
    select: "employee_salary.employee_pf",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "employer_pf_total", label: "Employer PF (total)", group: "Payroll",
    select: "employee_salary.employer_pf_total",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "employee_esi", label: "Employee ESI", group: "Payroll",
    select: "employee_salary.employee_esi",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "employer_esi", label: "Employer ESI", group: "Payroll",
    select: "employee_salary.employer_esi",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },

  { key: "monthly_ctc", label: "Monthly CTC", group: "Payroll",
    select: "employee_salary.monthly_ctc",
    join: "current_salary", join_footprint: "m2_salary", transform: asAmount,
    permission: P.VIEW_SALARY, sensitive: true,
    history_backed: false, enabled: true },
];

/** The joins each `join` name expands to. Fixed text, never caller-derived. */
const JOINS = {
  outlets: "LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id",
  department:
    "LEFT JOIN department ON department.department_id = new_employee.department_id",
  designation:
    "LEFT JOIN designation ON designation.designation_id = new_employee.designation_id",
  shift_master:
    "LEFT JOIN shift_master ON shift_master.shift_id = new_employee.shift_id",
  work_shift:
    "LEFT JOIN work_shift ON work_shift.work_shift_id = new_employee.default_work_shift_id",
  aadhaar_identity:
    "LEFT JOIN employee_aadhaar_identity ON employee_aadhaar_identity.employee_id = new_employee.employee_id",
  bank_verification:
    "LEFT JOIN employee_bank_verification ON employee_bank_verification.employee_id = new_employee.employee_id",
  // THE CURRENT APPROVED SALARY, PINNED TO ONE ROW.
  //
  // `employee_salary` holds one row per revision, so a plain
  // `ON employee_salary.employee_id = new_employee.employee_id` would turn one
  // employee into one row PER REVISION - an export whose row count silently
  // disagrees with the preview's, which is the one invariant
  // `usecase/employee_report_service.js` exists to protect. Joining on the
  // primary key chosen by a correlated subquery keeps it at most one row.
  //
  // The subquery is the same rule, statement for statement, as
  // `repository/employee_salary.js#getCurrentSalary`: the latest APPROVED
  // revision effective on or before today, ordered by effective date and then
  // by id so two rows sharing a date still resolve to the later one. PENDING
  // is not current because it has not been agreed, REJECTED because it was
  // refused, and an approved future revision not until its date arrives.
  //
  // Fixed text like every other join here - `CURDATE()` and 'APPROVED' are
  // this file's, and no part of it comes from a caller.
  current_salary: [
    "LEFT JOIN employee_salary ON employee_salary.salary_id = (",
    "         SELECT s.salary_id",
    "           FROM employee_salary s",
    "          WHERE s.employee_id = new_employee.employee_id",
    "            AND s.status = 'APPROVED'",
    "            AND s.effective_from <= CURDATE()",
    "          ORDER BY s.effective_from DESC, s.salary_id DESC",
    "          LIMIT 1)",
  ].join("\n"),
};

const GROUP_ORDER = [
  "Identity",
  "Employment",
  "Contact",
  "Education",
  "Aadhaar",
  "Statutory",
  "Bank",
  // Last, and behind `view_salary` to a field. The order mirrors the Employee
  // Master's own sections, where Payroll is the last one before Documents.
  "Payroll",
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const getField = (key) => (typeof key === "string" ? BY_KEY.get(key) || null : null);

/** Keys that must never appear, whatever a caller asks for. */
const FORBIDDEN_KEYS = [
  "aadhaar_number",
  "aadhaar_card_no",
  "aadhaar_card_image",
  "aadhaar_ciphertext",
  "aadhaar_fingerprint",
  "account_fingerprint",
  // The LEGACY free-text column, and only that. `new_employee.salary` is an
  // undated VARCHAR nothing owns; the current approved structure is reported
  // through the Payroll group above, under `view_salary`, and under its own
  // keys - `monthly_gross` and the rest. This entry stops the old column from
  // ever becoming a field again by the name it is known by.
  "salary",
  // `payment_type` WAS HERE AND IS NOT ANY MORE. It is an employee master
  // field the Payment Details section records and displays, so it is now a
  // catalogue entry - gated on `view_employee_sensitive`, exactly as B3
  // already gates the column in every other response. Listing it here as well
  // would mean a forbidden key that exists, which is a contradiction rather
  // than a second defence.
];

/** Every field that carries filter metadata. Never a second hand-kept list. */
const filterableFields = () => FIELDS.filter((f) => f.enabled && f.filter);

module.exports = {
  FILTER,
  EMPLOYMENT_STATUS_OPTIONS,
  BANK_STATUS_OPTIONS,
  AADHAAR_STATUS_OPTIONS,
  GENDER_OPTIONS,
  filterableFields,
  FIELDS,
  JOINS,
  GROUP_ORDER,
  BY_KEY,
  getField,
  FORBIDDEN_KEYS,
  maskAccount,
  asDate,
  EMPLOYMENT_STATUS_LABEL,
};
