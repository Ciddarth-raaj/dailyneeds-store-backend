const P = require("../constants/hr_permissions");
const {
  isSensitiveField,
  isSensitiveCardType,
  CARD_TYPE_KEYS,
} = require("../constants/sensitive_fields");

/**
 * Stage 0B / B3 — field-level protection for sensitive employee data.
 *
 * B1 decided whether a caller has a session at all and B2 whether they may
 * reach an endpoint. Both are all-or-nothing per route, and that is not
 * enough for the employee master: the same row that carries a name and a
 * store carries a salary, a bank account and an Aadhaar number. B3 splits
 * the row rather than the route, so a designation can run the staff
 * directory without seeing anyone's pay or bank details.
 *
 * Two directions, one list of fields (constants/sensitive_fields.js):
 *
 *   READ   `filterResponse` strips sensitive keys from anything the route
 *          sends unless the caller holds `view_employee_sensitive`. Keys are
 *          REMOVED, never nulled or blanked - a null tells the reader the
 *          field exists and is empty, which is itself information, and a
 *          frontend cannot distinguish "hidden" from "not recorded".
 *
 *   WRITE  `guardWrite` refuses a request that so much as mentions a
 *          sensitive field unless the caller holds `edit_employee_sensitive`,
 *          with the same 403 body B2 uses. Silently dropping the fields
 *          instead would let a caller believe an edit was applied.
 *
 * Both resolve the permission BEFORE the handler runs, so the wrapper around
 * `res.json` stays synchronous and cannot race the response.
 *
 * `user_type = 2` needs no special case here: `permissions.has` answers true
 * for an admin, so the admin bypass is the same one B2 uses.
 */

/** Objects that are values in their own right, not bags of fields to walk. */
const isPlainContainer = (v) =>
  v !== null &&
  typeof v === "object" &&
  !(v instanceof Date) &&
  !Buffer.isBuffer(v);

/** Returned in place of a row that must not be sent at all. */
const DROP = Symbol("drop");

/**
 * A row that IS a sensitive document - an Aadhaar or PAN record - rather than
 * one that merely contains a sensitive field. Its `file` is an S3 path to a
 * scan of the document, so the whole row goes, not just some of its keys.
 */
const isSensitiveDocumentRow = (obj) => {
  for (const key of Object.keys(obj)) {
    if (CARD_TYPE_KEYS.has(key.toLowerCase()) && isSensitiveCardType(obj[key])) {
      return true;
    }
  }
  return false;
};

/**
 * Deep copy with every sensitive key removed and every sensitive document
 * row dropped. Returns DROP when the value itself must not be sent.
 */
function sanitize(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const clean = sanitize(item);
      if (clean !== DROP) out.push(clean);
    }
    return out;
  }

  if (!isPlainContainer(value)) return value;

  if (isSensitiveDocumentRow(value)) return DROP;

  const out = {};
  for (const key of Object.keys(value)) {
    if (isSensitiveField(key)) continue;

    const raw = value[key];

    // `document.getDocumentsWithoutAdhaar` aggregates its rows with
    // JSON_ARRAYAGG, so the document list arrives as a JSON string the walk
    // above would step straight past. Only this one key is re-parsed; every
    // other string is passed through untouched.
    if (key.toLowerCase() === "files" && typeof raw === "string") {
      out[key] = sanitizeJsonString(raw);
      continue;
    }

    const clean = sanitize(raw);
    out[key] = clean === DROP ? null : clean;
  }
  return out;
}

/** Sanitise a JSON string in place, leaving it a JSON string. */
function sanitizeJsonString(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return text; // not JSON after all; nothing to walk
  }
  if (!isPlainContainer(parsed)) return text;
  const clean = sanitize(parsed);
  return JSON.stringify(clean === DROP ? null : clean);
}

/**
 * True when `body` mentions any sensitive field, at any depth, or carries a
 * sensitive document.
 *
 * Presence is the test, not a changed value: the request cannot be compared
 * against the stored row without reading it, and a caller who may not touch
 * these fields has no business sending them. An empty string or an explicit
 * null counts - "clear this person's bank account" is a sensitive write.
 */
function containsSensitive(value) {
  if (Array.isArray(value)) return value.some(containsSensitive);
  if (!isPlainContainer(value)) return false;

  for (const key of Object.keys(value)) {
    if (isSensitiveField(key)) return true;
    if (CARD_TYPE_KEYS.has(key.toLowerCase()) && isSensitiveCardType(value[key])) {
      return true;
    }
    if (containsSensitive(value[key])) return true;
  }
  return false;
}

module.exports = (permissions) => {
  /**
   * Express middleware: everything this route sends is stripped of sensitive
   * employee data unless the caller may see it.
   */
  const filterResponse = async (req, res, next) => {
    try {
      if (await permissions.has(req, P.VIEW_EMPLOYEE_SENSITIVE)) return next();
    } catch (err) {
      // A permission lookup that fails must not open the field up.
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }

    const json = res.json.bind(res);
    res.json = (body) => {
      const clean = sanitize(body);
      return json(clean === DROP ? null : clean);
    };
    return next();
  };

  /**
   * Express middleware: refuse a write that touches sensitive employee data
   * unless the caller holds `edit_employee_sensitive`.
   *
   * Ordinary fields are unaffected - a body with no sensitive key passes
   * straight through and is governed by whatever B2 permission the route
   * already requires.
   */
  const guardWrite = async (req, res, next) => {
    if (!containsSensitive(req.body)) return next();

    let allowed = false;
    try {
      allowed = await permissions.has(req, P.EDIT_EMPLOYEE_SENSITIVE);
    } catch (err) {
      return res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
    if (allowed) return next();

    // The same body B2 sends, so the frontend treats it as a permission
    // refusal and keeps the session rather than logging the user out.
    return res.status(403).json({
      code: 403,
      msg: "You do not have permission to perform this action",
    });
  };

  return { filterResponse, guardWrite };
};

// Exposed for tests; the middleware above is the supported entry point.
module.exports.sanitize = (value) => {
  const clean = sanitize(value);
  return clean === DROP ? null : clean;
};
module.exports.containsSensitive = containsSensitive;
module.exports.DROP = DROP;
