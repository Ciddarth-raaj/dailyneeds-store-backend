/**
 * M1 - Employee Master restructure: which section a sensitive column belongs
 * to, and therefore which section key a write to it demands.
 *
 * The employee master is one ordered set of sections for Add and Edit alike:
 *
 *   1 Aadhaar  2 Personal  3 Employment  4 Education
 *   5 Payment Details  6 Statutory Details  7 Payroll  8 Documents
 *
 * A store manager's `employee_create` covers 1-4. Sections 5 and 6 are each
 * behind their own key on top of B3 (`edit_employee_sensitive`) and the route
 * (`add_employees`): `sectionKeysRequired` is the pure decision, and
 * `routes/employee.js` applies it to /employee/updatedata, the only route that
 * writes these columns.
 *
 * Keys are matched case-insensitively because the route's Joi schema spells
 * `UAN` in capitals while the column is lower case.
 */
const P = require("./hr_permissions");

const PAYMENT_DETAIL_FIELDS = ["payment_type", "bank_name", "ifsc", "account_no"];

const STATUTORY_DETAIL_FIELDS = [
  "pan_no",
  "uan",
  "pf",
  "pf_number",
  "pf_applicable",
  // M2. Controlled by the EXISTING Statutory designation right - the approved
  // rule is that it is governed by `edit_statutory_details`, not by a new key
  // of its own. It is a separate FACT from PF Applicable, the UAN and the PF
  // Number, but it is not a separate DECISION about who may record it.
  "previous_pf_member",
  "esi",
  "esi_number",
  "esi_applicable",
];

const PAYMENT_SET = new Set(PAYMENT_DETAIL_FIELDS);
const STATUTORY_SET = new Set(STATUTORY_DETAIL_FIELDS);

/** Everything the two post-onboarding sections own, as one lookup. */
const SECTION_FIELD_SET = new Set([...PAYMENT_DETAIL_FIELDS, ...STATUTORY_DETAIL_FIELDS]);

/** Bank / cash: 1 Bank, 2 Cash - the values the legacy screens always stored. */
const PAYMENT_TYPE = { BANK: 1, CASH: 2 };

/**
 * The section keys a body demands, as a list (possibly empty). A body that
 * mentions a payment column needs `edit_payment_details`; a statutory column,
 * `edit_statutory_details`; both, both. Anything else is somebody else's
 * check - this never returns a key for an ordinary field.
 */
function sectionKeysRequired(details) {
  const keys = new Set();
  if (!details || typeof details !== "object") return [];
  for (const raw of Object.keys(details)) {
    const key = String(raw).toLowerCase();
    if (PAYMENT_SET.has(key)) keys.add(P.EDIT_PAYMENT_DETAILS);
    if (STATUTORY_SET.has(key)) keys.add(P.EDIT_STATUTORY_DETAILS);
  }
  return [...keys];
}

/**
 * True when a body writes NOTHING BUT Payment Details and / or Statutory
 * Details columns.
 *
 * M1 review fix. `add_employees` used to gate the whole of
 * /employee/updatedata, so a designation holding the sensitive pair and
 * `edit_payment_details` still could not save Payment Details on an existing
 * employee without also being able to CREATE one. The final rule is that Add
 * Employee covers onboarding screens 1-4 and nothing after Education; the
 * sections past it are controlled by their own designation rights. This is
 * the pure decision `routes/employee.js` uses to tell the two cases apart.
 *
 * IT NEVER ALLOWS A WRITE. `sectionKeysRequired` still demands
 * `edit_payment_details` / `edit_statutory_details` (AND, not OR), and B3's
 * `guardWrite` still demands `edit_employee_sensitive`, because every column
 * named here is in `constants/sensitive_fields.js`. All this decides is
 * whether `add_employees` is demanded ON TOP of those.
 *
 * FALSE IS THE SAFE ANSWER, and is what anything unrecognised gets: a
 * missing body, an empty one, a non-object, an array, or one that names a
 * single ordinary column beside the section fields. The failure mode of an
 * odd body is "still needs add_employees", never "waved through".
 */
function isSectionOnlyWrite(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const keys = Object.keys(details);
  if (keys.length === 0) return false;
  return keys.every((raw) => SECTION_FIELD_SET.has(String(raw).toLowerCase()));
}

module.exports = {
  PAYMENT_DETAIL_FIELDS,
  STATUTORY_DETAIL_FIELDS,
  PAYMENT_TYPE,
  sectionKeysRequired,
  isSectionOnlyWrite,
};
