/**
 * EMPLOYMENT TYPE AND GRADE — the two classification fields on the employee
 * master, and the ONE place their allowed values are stated.
 *
 * WHAT THEY ARE. `employment_type` says how somebody is engaged - Permanent
 * or Contract. `grade` is the internal band, A to E. Both are recorded on the
 * Employment Details section of the Employee Master and shown back there.
 *
 * WHAT THEY ARE NOT. They are classification only. Nothing in this codebase
 * reads either of them to decide anything: not salary, not payroll, not
 * attendance, not PF or ESI, not the shift engine, not a permission and not a
 * branch scope. A Contract employee on grade E is paid, marked present and
 * authorised by exactly the same rules as anybody else. If that ever changes
 * it will be a deliberate decision made somewhere else; it is not implied by
 * these columns existing.
 *
 * FIXED, CONTROLLED LISTS. There is no employment-type master and no grade
 * master - no table, no screen, no CRUD. The sets below are the definition,
 * the ENUM columns in `20261017120000-employee-employment-type-and-grade`
 * mirror them, and the frontend dropdowns are built from the same two lists.
 * Free text is not accepted anywhere.
 *
 * NOT RECORDED IS A REAL STATE. Every employee created before these columns
 * existed has NULL in both, and that is valid and permanent until a human
 * chooses a value. Nothing here defaults, backfills or infers one - contrast
 * `utils/payment_type.js`, which does default on create because the business
 * has an honest answer for day one. Here it does not.
 */

/** The only two ways somebody is engaged. Stored exactly as written. */
const EMPLOYMENT_TYPES = ["Permanent", "Contract"];

/** The only five grades. Stored exactly as written. */
const GRADES = ["A", "B", "C", "D", "E"];

/**
 * The refusal shape both employee routes already map to `{ code: 422, msg }`
 * through `err.name === "ValidationError"`, exactly as `utils/payment_type.js`
 * does. Nothing new had to be wired to carry it.
 */
class ValidationError extends Error {
  constructor(message, code = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = code;
  }
}

/**
 * Did the caller SAY anything? `undefined`, `null` and a blank string are all
 * "no" - the shapes an untouched dropdown, a stripped Joi key and a direct
 * caller that left the field out arrive in.
 */
function isSupplied(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

const isAllowed = (allowed, value) =>
  typeof value === "string" && allowed.includes(value.trim());

/**
 * The value to store for one classification field, given whatever it was
 * handed.
 *
 *   not supplied    `null` - "not recorded", which is a legitimate answer for
 *                   both a new employee nobody has classified yet and an
 *                   existing one whose field is being cleared.
 *   an exact member REFUSED unless it matches a member EXACTLY, case and all.
 *                   `Permanent` is stored; `permanent`, `PERMANENT`, `Perm`,
 *                   `F` and `3` are all 422. Accepting a near miss would put a
 *                   value in the column that no dropdown can render back and
 *                   that the ENUM would truncate to the empty string.
 */
function classificationValue(field, allowed, value) {
  if (!isSupplied(value)) return null;
  if (!isAllowed(allowed, value)) {
    throw new ValidationError(
      `${field} must be one of ${allowed.join(", ")}; received ` +
        `${JSON.stringify(value === undefined ? null : value)}`
    );
  }
  return String(value).trim();
}

const employmentTypeValue = (value) =>
  classificationValue("employment_type", EMPLOYMENT_TYPES, value);

const gradeValue = (value) => classificationValue("grade", GRADES, value);

/** The two column names, so callers never spell them a second time. */
const CLASSIFICATION_FIELDS = ["employment_type", "grade"];

/**
 * Normalises whichever of the two fields a body MENTIONS, in place on a copy,
 * and refuses an unsupported value. A field the body does not mention is left
 * untouched - that is what keeps a partial edit partial, and what keeps an
 * existing employee's NULL from being rewritten by a save of some other
 * section.
 */
function normaliseClassificationFields(fields = {}) {
  const out = { ...fields };
  if ("employment_type" in out) out.employment_type = employmentTypeValue(out.employment_type);
  if ("grade" in out) out.grade = gradeValue(out.grade);
  return out;
}

module.exports = {
  EMPLOYMENT_TYPES,
  GRADES,
  CLASSIFICATION_FIELDS,
  ValidationError,
  employmentTypeValue,
  gradeValue,
  normaliseClassificationFields,
};
