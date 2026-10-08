/**
 * Transporter Master - the name and contact rules, free of SQL so they can
 * be tested on their own.
 *
 * One list of transporters serves every LR Follow-up, from an Advance
 * Request or created by hand; a follow-up points at a transporter by its
 * primary key and never carries its name as text.
 */
const { normalizeIndianMobile } = require("./mobile_number");

const PERMISSION = Object.freeze({
  VIEW: "view_transporter_master",
  CREATE: "create_transporter_master",
  EDIT: "edit_transporter_master",
});

/** Characters people put in phone numbers that carry no information. */
const PRESENTATION_RE = /[\s\-().]/g;

/**
 * The duplicate-protection key for a transporter name: trimmed, inner runs
 * of whitespace collapsed, lower-cased. "VRL  Logistics" and "vrl logistics"
 * are one transporter.
 */
function nameKey(name) {
  if (name === undefined || name === null) return "";
  return String(name).trim().replace(/\s+/g, " ").toLowerCase();
}

/** The name as it is stored and shown: trimmed, whitespace collapsed. */
function cleanName(name) {
  if (name === undefined || name === null) return "";
  return String(name).trim().replace(/\s+/g, " ");
}

/**
 * A contact number in the form it is stored, or null when it is not one.
 *
 * Accepted, because transporters' booking desks are often landlines:
 *
 *   an Indian mobile in any common spelling      -> the ten digits
 *     (9876543210, +91 98765 43210, 098765-43210)
 *   a landline with its STD code, leading 0      -> the digits, 11 or 12
 *     (044-2345 6789 -> 04423456789)
 *   a 1800 / 1860 service number                 -> the digits, 11 to 13
 *
 * Anything else - letters, too short, too long, a bare local number without
 * its STD code - is refused, so the master never holds a number nobody can
 * dial.
 */
function normalizeContact(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw === "") return null;

  const mobile = normalizeIndianMobile(raw);
  if (mobile) return mobile;

  const compact = raw.replace(PRESENTATION_RE, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  const digits = compact.replace(/^\+/, "");

  if (/^0[1-9]\d{9,10}$/.test(digits)) return digits; // STD code + number
  if (/^18[06]0\d{6,9}$/.test(digits)) return digits; // toll-free / shared-cost
  return null;
}

/**
 * Validates and normalises a create/edit payload. Returns
 * `{ value, errors }`; `errors` maps a field to its message.
 *
 * `partial` is for an edit: fields that are absent are left alone, but a
 * field that is present is held to the same rule as on create.
 */
function validateTransporter(input, { partial = false } = {}) {
  const errors = {};
  const value = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k) && input[k] !== undefined;

  if (!partial || has("transporter_name")) {
    const name = cleanName(input.transporter_name);
    if (!name) errors.transporter_name = "Transporter Name is required";
    else if (name.length > 150) errors.transporter_name = "Transporter Name cannot exceed 150 characters";
    else value.transporter_name = name;
  }

  if (!partial || has("contact_no")) {
    const contact = normalizeContact(input.contact_no);
    if (!contact) errors.contact_no = "Enter a valid contact number (10-digit mobile, or landline with STD code)";
    else value.contact_no = contact;
  }

  if (has("alternate_contact_no")) {
    const raw = input.alternate_contact_no;
    if (raw === null || String(raw).trim() === "") {
      value.alternate_contact_no = null;
    } else {
      const alt = normalizeContact(raw);
      if (!alt) errors.alternate_contact_no = "Enter a valid alternate contact number";
      else value.alternate_contact_no = alt;
    }
  }

  const optionalText = (key, max, label) => {
    if (!has(key)) return;
    const raw = input[key];
    const text = raw === null ? "" : String(raw).trim();
    if (text.length > max) errors[key] = `${label} cannot exceed ${max} characters`;
    else value[key] = text === "" ? null : text;
  };
  optionalText("contact_person", 100, "Contact Person");
  optionalText("remarks", 500, "Remarks");

  if (has("is_active")) {
    value.is_active = input.is_active === true || input.is_active === 1 || input.is_active === "1" ||
      input.is_active === "true";
  }

  if (value.contact_no && value.alternate_contact_no && value.contact_no === value.alternate_contact_no) {
    errors.alternate_contact_no = "Alternate Contact No. is the same as Contact No.";
  }

  return { value, errors };
}

/** How the screens name a transporter: "VRL Logistics (9876543210)". */
function transporterLabel(row) {
  if (!row || !row.transporter_name) return null;
  return row.contact_no ? `${row.transporter_name} (${row.contact_no})` : row.transporter_name;
}

module.exports = {
  PERMISSION,
  nameKey,
  cleanName,
  normalizeContact,
  validateTransporter,
  transporterLabel,
};
