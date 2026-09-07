/**
 * Stage 0B / B3 — what counts as sensitive employee data.
 *
 * One list, used by both directions of the guard in middlewares/sensitive.js:
 * a response never carries these keys to a caller without
 * `view_employee_sensitive`, and a request that mentions any of them is
 * refused unless the caller holds `edit_employee_sensitive`.
 *
 * Field names are matched case-insensitively because the same column comes
 * back under different spellings depending on the query: `new_employee.uan`
 * is selected as `uan` by the list queries and as `UAN` by `SELECT *`.
 */

/**
 * Employee columns that must not reach an unauthorised caller.
 *
 * Grouped by what they are, not by which table they live in - the same names
 * appear in the employee master, in joined document rows and in request
 * bodies, and all three have to be treated the same way.
 */
const SENSITIVE_EMPLOYEE_FIELDS = [
  // pay
  "salary",
  "payment_type",
  // bank
  "bank_name",
  "ifsc",
  "account_no",
  // government identifiers
  "pan_no",
  "aadhaar_card_no",
  "aadhaar_card_name",
  "aadhaar_card_image",
  "uan",
  // statutory
  "pf",
  "pf_number",
  "esi",
  "esi_number",
];

/** The same list as a lower-cased Set, for lookups. */
const SENSITIVE_FIELD_SET = new Set(
  SENSITIVE_EMPLOYEE_FIELDS.map((f) => f.toLowerCase())
);

/**
 * Document types whose file, number and name are sensitive.
 *
 * `new_employee_documents.card_type` is the frontend's IdCardType id:
 * 1 Aadhaar, 2 Driving Licence, 3 Voter Id, 4 PAN. Only 1 is offered by the
 * UI today (2-4 are commented out there), but historical rows may carry any
 * of them, so the mapping is pinned here rather than assumed. Aadhaar and
 * PAN are the two named as sensitive; adding another is one entry in this
 * list and nothing else.
 */
const SENSITIVE_CARD_TYPES = new Set([1, 4]);

/** Keys that carry a document type in a row or a request body. */
const CARD_TYPE_KEYS = new Set(["card_type", "id_card"]);

/** True when `value` names a document type whose contents are sensitive. */
const isSensitiveCardType = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && SENSITIVE_CARD_TYPES.has(n);
};

/** True when `key` names a sensitive employee field, in any spelling. */
const isSensitiveField = (key) =>
  typeof key === "string" && SENSITIVE_FIELD_SET.has(key.toLowerCase());

module.exports = {
  SENSITIVE_EMPLOYEE_FIELDS,
  SENSITIVE_FIELD_SET,
  SENSITIVE_CARD_TYPES,
  CARD_TYPE_KEYS,
  isSensitiveField,
  isSensitiveCardType,
};
