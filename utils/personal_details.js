/**
 * Employee Master - Personal Details, and what must be filled in.
 *
 * PURE FUNCTIONS ONLY. No database, no Express. The caller hands over the
 * row as it will be AFTER the write and gets back the list of what is
 * missing, which is what lets the identical rule run on the server (where it
 * is the boundary) and in the browser (where it is the courtesy) without
 * either being a re-implementation of the other.
 *
 * WHEN IT APPLIES, AND WHY THAT MATTERS MORE THAN THE LIST ITSELF.
 *
 * These rules apply when the Personal Details section is being CREATED or
 * SAVED. They do NOT apply to reading an employee, to editing some other
 * section of the same employee, or to any of the historical rows that
 * predate the rule - and there are a great many of those. An employee who
 * joined in 2013 with no date of birth on file stays viewable, stays
 * payable, and their Employment or Statutory sections stay editable; what
 * they cannot do is have their Personal Details re-saved while still
 * incomplete. Enforcing it on read, or on every edit whatever it touched,
 * would lock HR out of records they need precisely because those records
 * are incomplete.
 *
 * `isPersonalDetailsWrite` is how that distinction is made: a patch that
 * names none of these fields is not a Personal Details save and is not
 * judged as one.
 *
 * THE CONDITIONAL PAIR. Spouse Name and Marriage Date are mandatory when and
 * only when Marital Status is Married. For Single, Widowed or Divorced they
 * must not block a save - a widow has a marriage date and a divorcee may
 * not, and demanding either would be both wrong and intrusive.
 *
 * DELIBERATELY OPTIONAL: Blood Group and Email. Neither is known for a large
 * part of the workforce and neither is needed to pay or to identify anybody.
 */

/** Every field the Personal Details section owns. Touching any is a save. */
const PERSONAL_DETAIL_FIELDS = Object.freeze([
  "employee_name",
  "father_name",
  "dob",
  "gender",
  "blood_group",
  "marital_status",
  "marriage_date",
  "spouse_name",
  "primary_contact_number",
  "alternate_contact_number",
  "email_id",
  "permanent_address",
  "residential_address",
]);

/** Always mandatory, with the wording the screen uses. */
const ALWAYS_REQUIRED = Object.freeze([
  ["employee_name", "Employee Name"],
  ["father_name", "Father's Name"],
  ["dob", "Date of Birth"],
  ["gender", "Gender"],
  ["marital_status", "Marital Status"],
  ["primary_contact_number", "Mobile"],
  ["alternate_contact_number", "Alternate / Emergency Contact"],
  ["permanent_address", "Permanent Address"],
  ["residential_address", "Residential Address"],
]);

/** Mandatory only when Marital Status is Married. */
const MARRIED_REQUIRED = Object.freeze([
  ["spouse_name", "Spouse Name"],
  ["marriage_date", "Marriage Date"],
]);

/** Never mandatory. Named so the rule is readable rather than inferred. */
const NEVER_REQUIRED = Object.freeze(["blood_group", "email_id"]);

/** Blank, whitespace, null and undefined are all "not filled in". */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Is this patch a Personal Details save?
 *
 * True when it names at least one field the section owns. An Education-only
 * or Employment-only patch is not, and is judged by its own rules.
 */
function isPersonalDetailsWrite(patch) {
  if (!patch || typeof patch !== "object") return false;
  return PERSONAL_DETAIL_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(patch, f));
}

/** Married, however the column happens to be cased or spaced. */
function isMarried(maritalStatus) {
  return String(maritalStatus || "").trim().toLowerCase() === "married";
}

/**
 * What is still missing from the row as it will be after the write.
 *
 * @param {object} row  the MERGED row - existing values with the patch
 *        applied - because the rule is about the record that will exist, not
 *        about which half of it arrived in this request.
 * @returns {Array<{field: string, label: string}>} empty when complete
 */
function missingPersonalDetails(row = {}) {
  const missing = [];
  ALWAYS_REQUIRED.forEach(([field, label]) => {
    if (isBlank(row[field])) missing.push({ field, label });
  });
  if (isMarried(row.marital_status)) {
    MARRIED_REQUIRED.forEach(([field, label]) => {
      if (isBlank(row[field])) missing.push({ field, label });
    });
  }
  return missing;
}

/**
 * The row a Personal Details save will produce: what is stored now, with the
 * patch applied. A key present in the patch wins even when it is blank -
 * clearing a mandatory field is a save that must be refused, not one that
 * silently keeps the old value.
 */
function mergeForValidation(before = {}, patch = {}) {
  const merged = { ...(before || {}) };
  PERSONAL_DETAIL_FIELDS.forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(patch, f)) merged[f] = patch[f];
  });
  return merged;
}

/** One sentence naming everything that is missing, for the 422. */
function missingMessage(missing) {
  const labels = (missing || []).map((m) => m.label);
  if (labels.length === 0) return null;
  return `Personal Details is incomplete: ${labels.join(", ")} ${
    labels.length === 1 ? "is" : "are"
  } required`;
}

module.exports = {
  PERSONAL_DETAIL_FIELDS,
  ALWAYS_REQUIRED,
  MARRIED_REQUIRED,
  NEVER_REQUIRED,
  isBlank,
  isMarried,
  isPersonalDetailsWrite,
  missingPersonalDetails,
  mergeForValidation,
  missingMessage,
};
