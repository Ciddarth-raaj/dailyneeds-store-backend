const P = require("./hr_permissions");

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
 * All 47 columns of `new_employee` were enumerated from the migration history
 * and classified. Every one is accounted for below; none is silently ignored.
 *
 * INCLUDED (23 columns, via the entries in this file):
 *   employee_id, employee_name, father_name, dob, gender, marital_status,
 *   spouse_name, blood_group, permanent_address, residential_address,
 *   primary_contact_number, alternate_contact_number, email_id,
 *   qualification, additional_course, previous_experience, date_of_joining,
 *   store_id, department_id, designation_id, shift_id, status, pan_no,
 *   uan, pf_number, esi_number, bank_name, ifsc, account_no
 *
 * PAYROLL_DEFERRED (2):
 *   salary          Payroll owns pay. HR stores an engaged figure; earnings,
 *   payment_type    deductions and net pay are Payroll's, and exporting the
 *                   master figure from an HR report invites it being read as
 *                   pay. Excluded deliberately, not by oversight.
 *
 * DELIBERATELY_EXCLUDED (16), each with its reason:
 *   employee_image        operational/internal - a base64 LONGTEXT blob; not
 *                         meaningful in a spreadsheet cell
 *   marriage_date         not meaningful to HR reporting today, and stored as
 *                         VARCHAR with no validated format
 *   introducer_name       operational/internal - recruitment referral notes
 *   introducer_details    operational/internal, LONGTEXT free text
 *   uniform_qty           operational/internal issue tracking
 *   esi                   deprecated/legacy - superseded by esi_number; a
 *                         yes/no-ish free-text column with no agreed meaning
 *   pf                    deprecated/legacy - superseded by pf_number, same
 *   shift_code            sync artefact - a Digisme-era code duplicating
 *                         shift_id; the resolved shift name is exported
 *                         instead
 *   online_portal         auth/internal - portal access flag
 *   telegram_username     operational/internal messaging handle
 *   aadhaar_card_no       ENCRYPTED/SECURITY - the legacy plaintext Aadhaar
 *                         column. B3 treats it as sensitive and C2 replaced
 *                         it; a full Aadhaar must never be exportable, so it
 *                         has no catalogue entry AT ALL rather than a gated
 *                         one (§30)
 *   aadhaar_card_name     security - part of the same legacy Aadhaar record
 *   aadhaar_card_image    security - document storage internals
 *   resignation_date      not exported here: the population already excludes
 *                         anyone with a resignation record (see
 *                         repository/employee_scope.js), so the column is
 *                         effectively always empty in this report
 *   created_at            operational/internal row metadata
 *   updated_at            operational/internal row metadata
 *
 * ------------------------------------------------------------- join scope
 * `join_footprint` records what a field costs to resolve, so the resolver can
 * add only the joins the selected fields actually need:
 *
 *   base         a column on new_employee
 *   lookup       one LEFT JOIN to a master (outlets / department /
 *                designation / shift_master)
 *   c2_identity  the C2 Aadhaar identity table
 *   c2_bank      the C2 bank verification, resolved through C2's own status
 *                logic rather than read raw
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

/** `date_of_joining` is a VARCHAR of mixed formats; export what parses. */
const asDate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const head = String(value).trim().split("T")[0].split(" ")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : String(value).trim();
};

const EMPLOYMENT_STATUS_LABEL = (value) => (Number(value) === 1 ? "Active" : "Inactive");

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
    select: "new_employee.date_of_joining", join_footprint: "base", transform: asDate,
    // Stored as VARCHAR, so a range compares lexically. ISO dates sort
    // correctly that way; anything else in the column will not, which is why
    // this is a range and never an arithmetic comparison.
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

  { key: "shift", label: "Shift", group: "Employment",
    select: "shift_master.shift_name", join: "shift_master", join_footprint: "lookup",
    filter: { type: FILTER.TEXT },
    history_backed: true, enabled: true },

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
  // Status and last four only. There is deliberately NO full-Aadhaar entry -
  // not a permission-gated one, not a disabled one. A field that does not
  // exist cannot be exported by a bug in a permission check.
  { key: "aadhaar_status", label: "Aadhaar Status", group: "Aadhaar",
    select: "IF(employee_aadhaar_identity.employee_id IS NULL, 'PENDING', 'VERIFIED')",
    join: "aadhaar_identity", join_footprint: "c2_identity",
    filter: { type: FILTER.ENUM, options: AADHAAR_STATUS_OPTIONS },
    history_backed: false, enabled: true },

  { key: "aadhaar_last4", label: "Aadhaar Last 4", group: "Aadhaar",
    select: "employee_aadhaar_identity.aadhaar_last4",
    join: "aadhaar_identity", join_footprint: "c2_identity",
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

  /* ---------------------------------------------------------------- Bank */
  // The verification STATUS is not sensitive under B3 - knowing an account is
  // unverified is what lets HR chase it, and it discloses nothing about the
  // account. The account itself is, and is exported masked even then.
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
  aadhaar_identity:
    "LEFT JOIN employee_aadhaar_identity ON employee_aadhaar_identity.employee_id = new_employee.employee_id",
  bank_verification:
    "LEFT JOIN employee_bank_verification ON employee_bank_verification.employee_id = new_employee.employee_id",
};

const GROUP_ORDER = [
  "Identity",
  "Employment",
  "Contact",
  "Education",
  "Aadhaar",
  "Statutory",
  "Bank",
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
  "salary",
  "payment_type",
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
