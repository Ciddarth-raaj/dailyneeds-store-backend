/**
 * Stage 0C / C3 — the governed projection fields, and who may still write them.
 *
 * Six columns on `new_employee` stop being the source of truth and become
 * projections of the three histories:
 *
 *   store_id, department_id, designation_id   employee_assignment
 *   shift_id                                  employee_default_shift_history
 *   salary, payment_type                      employee_salary_history
 *
 * ===================================== WHY NORMALIZATION IS THE HARD PART ==
 *
 * Legacy callers echo the whole employee record back on every save. They are
 * not trying to change the branch; they are sending the branch they were
 * given. If that echo is treated as a change, every existing screen breaks on
 * the day history is activated - so an unchanged value MUST be recognised as
 * unchanged.
 *
 * But the projections are not typed the way the values are:
 *
 *   store_id       INT          arrives as 12 or "12"
 *   salary         VARCHAR(45)  arrives as "20000", 20000, or "20000.00",
 *                               and the history stores DECIMAL(12,2)
 *   payment_type   VARCHAR(45)  arrives as "1" or 1
 *
 * so raw `===` reports a change that did not happen, and raw `==` reports no
 * change when there was one. The order below is deliberate and is the whole
 * discipline:
 *
 *       VALIDATE  ->  CANONICALIZE  ->  COMPARE
 *
 * Validate first, because normalization must never turn invalid input into a
 * harmless no-op: `store_id: "abc"` is a bad request, not "unchanged". A
 * guard that coerced it to NaN and compared NaN to NaN would wave through a
 * write that should have been refused.
 */

const GOVERNED_FIELDS = [
  "store_id",
  "department_id",
  "designation_id",
  "shift_id",
  "salary",
  "payment_type",
];

/** Which history owns each field, for the error message that redirects a caller. */
const FIELD_OWNER = {
  store_id: "assignment",
  department_id: "assignment",
  designation_id: "assignment",
  shift_id: "shift",
  salary: "salary",
  payment_type: "salary",
};

const OWNER_ACTION = {
  assignment: "Change Assignment",
  shift: "Change Default Shift",
  salary: "Revise Salary",
};

const ID_FIELDS = ["store_id", "department_id", "designation_id", "shift_id"];

/** A value the schema legitimately reads as "not set". */
const isEmpty = (v) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * The canonical form of one governed value, or an error.
 *
 * Returns `{ ok: true, value }` where `value` is the canonical form (a string,
 * or null for "not set"), or `{ ok: false, code }`. Strings are used rather
 * than numbers for the canonical form so that decimal comparison is exact -
 * 0.1 + 0.2 problems have no place in a salary check.
 */
function canonicalize(field, raw) {
  if (isEmpty(raw)) return { ok: true, value: null };

  if (ID_FIELDS.includes(field)) {
    const s = String(raw).trim();
    // A positive integer and nothing else. "12.0", "12abc", "-3" and "0" are
    // refused rather than coerced: an id is a row that exists.
    if (!/^\d+$/.test(s)) return { ok: false, code: "NOT_AN_ID" };
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, code: "NOT_AN_ID" };
    return { ok: true, value: String(n) }; // "012" and 12 both become "12"
  }

  if (field === "salary") {
    const s = String(raw).trim().replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, code: "NOT_A_SALARY" };
    // DECIMAL(12,2): compare at the precision the column actually stores, so
    // "20000", 20000 and "20000.00" are one value, and "20000.004" does not
    // silently become a different one.
    const [whole, frac = ""] = s.split(".");
    if (whole.replace(/^0+(?=\d)/, "").length > 10) return { ok: false, code: "SALARY_TOO_LARGE" };
    if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
      return { ok: false, code: "SALARY_TOO_PRECISE" };
    }
    const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
    return { ok: true, value: `${normalizedWhole}.${(frac + "00").slice(0, 2)}` };
  }

  // payment_type is VARCHAR(45) in the schema and holds whatever the legacy
  // data holds. Trimming is the only safe canonicalization: inventing an enum
  // here would reject values nobody has audited yet.
  return { ok: true, value: String(raw).trim() };
}

/**
 * Which governed fields a request body actually tries to CHANGE.
 *
 * @param body    the incoming request body
 * @param current the employee row as stored
 * @returns { changed: [field], unchanged: [field], invalid: [{field, code}],
 *            present: [field] }
 */
function classifyGoverned(body = {}, current = {}) {
  const changed = [];
  const unchanged = [];
  const invalid = [];
  const present = [];

  for (const field of GOVERNED_FIELDS) {
    if (!(field in (body || {}))) continue;
    present.push(field);

    const incoming = canonicalize(field, body[field]);
    if (!incoming.ok) {
      // Validate BEFORE compare: bad input is a bad request, never a no-op.
      invalid.push({ field, code: incoming.code });
      continue;
    }

    // The stored value is legacy data and may itself be unparseable - a
    // salary column holding "20,000/-" for instance. If it cannot be
    // canonicalized, any incoming value is a change, which is the safe answer.
    const stored = canonicalize(field, current[field]);
    const storedValue = stored.ok ? stored.value : Symbol("unparseable");

    if (incoming.value === storedValue) unchanged.push(field);
    else changed.push(field);
  }

  return { changed, unchanged, invalid, present };
}

/** The actions a caller should be sent to, given the fields they tried to change. */
function redirectFor(fields) {
  const owners = [...new Set(fields.map((f) => FIELD_OWNER[f]).filter(Boolean))];
  return owners.map((o) => OWNER_ACTION[o]);
}

/* ---------------------------------------------------------- the three modes */

const STATE = {
  PREPARING_BASELINE: "PREPARING_BASELINE",
  BASELINE_VALIDATED: "BASELINE_VALIDATED",
  HISTORY_ACTIVE: "HISTORY_ACTIVE",
};

/**
 * What an ordinary employee-edit route should do with this body.
 *
 * Returns one of:
 *   { action: "allow" }
 *   { action: "reject", httpCode, code, msg, fields }
 *   { action: "shadow", fields }   allow, but record that it happened
 *
 * The three states differ ONLY in what happens to a genuinely changed
 * governed field:
 *
 *   PREPARING_BASELINE  allowed. This is today's behaviour, and it must not
 *                       change while HR is still preparing the baseline -
 *                       breaking legacy edits before the history is even
 *                       populated would take the employee master offline for
 *                       the exact period HR needs it most.
 *
 *   BASELINE_VALIDATED  allowed, but recorded. Shadow mode exists so the
 *                       remaining legacy callers can be FOUND and fixed
 *                       before enforcement, rather than discovered as
 *                       production errors an hour after activation.
 *
 *   HISTORY_ACTIVE      rejected, with the action to use instead. Silently
 *                       dropping the field would be worse than refusing: the
 *                       caller would believe the change was applied.
 *
 * Invalid input is rejected in EVERY state. That is not a cutover rule, it is
 * ordinary validation, and relaxing it during preparation would let bad data
 * into the very rows the baseline is about to freeze.
 */
function evaluateOrdinaryEdit({ state, body, current }) {
  const { changed, invalid } = classifyGoverned(body, current);

  if (invalid.length) {
    return {
      action: "reject",
      httpCode: 422,
      code: "INVALID_GOVERNED_VALUE",
      msg: `Not a valid value for: ${invalid.map((i) => i.field).join(", ")}`,
      fields: invalid.map((i) => i.field),
    };
  }

  if (changed.length === 0) return { action: "allow", fields: [] };

  if (state === STATE.HISTORY_ACTIVE) {
    const actions = redirectFor(changed);
    return {
      action: "reject",
      httpCode: 409,
      code: "GOVERNED_FIELD_IS_HISTORY_OWNED",
      msg:
        `${changed.join(", ")} ${changed.length === 1 ? "is" : "are"} maintained as history now. ` +
        `Use ${actions.join(" / ")} instead, so the change carries an effective date and a reason.`,
      fields: changed,
    };
  }

  if (state === STATE.BASELINE_VALIDATED) {
    return { action: "shadow", fields: changed };
  }

  return { action: "allow", fields: changed };
}

/**
 * Strip governed fields from a body before it reaches a generic update.
 *
 * MASS ASSIGNMENT IS THE REAL RISK, and it is why this exists as well as the
 * check above. A legacy path doing `employee.update(req.body)` names no
 * governed field anywhere near the code, so neither a reviewer nor a grep
 * will find it - but `req.body` still carries `salary`, and the update still
 * writes it.
 *
 * Callers that have already evaluated the body use this to hand the generic
 * updater only what it may write. Governed values reach `new_employee` from
 * exactly one place: the projection update inside a history service.
 */
function withoutGovernedFields(body = {}) {
  const clean = {};
  for (const key of Object.keys(body || {})) {
    if (!GOVERNED_FIELDS.includes(key)) clean[key] = body[key];
  }
  return clean;
}

/** The governed projection as stored, for fingerprinting and comparison. */
function projectionOf(employee = {}) {
  const out = {};
  for (const field of GOVERNED_FIELDS) {
    const c = canonicalize(field, employee[field]);
    out[field] = c.ok ? c.value : String(employee[field]);
  }
  return out;
}

module.exports = {
  GOVERNED_FIELDS,
  FIELD_OWNER,
  OWNER_ACTION,
  STATE,
  isEmpty,
  canonicalize,
  classifyGoverned,
  redirectFor,
  evaluateOrdinaryEdit,
  withoutGovernedFields,
  projectionOf,
};
