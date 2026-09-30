/**
 * IS THE MONTHLY ATTENDANCE SUMMARY CURRENT WITH ITS DAYS?
 *
 * Payroll prices `attendance_monthly_payroll` - the roll-up the month persist
 * (`calculateMonth(persist=true)`) writes. Every other attendance write
 * rewrites DAYS only: an approval, a permission grant or revoke, a punch void,
 * the daily recalculation. Until the month is persisted again, the summary
 * payroll reads still carries the old shortage and OT.
 *
 * So the month persist records a FINGERPRINT of the stored day rows it was
 * written against - read back on its own connection, inside its own
 * transaction, after the days are written - and Approve & Lock recomputes the
 * same fingerprint from the day rows as they stand, under its row lock. Any
 * difference means a day moved since the summary was made, and the month is
 * not locked on it.
 *
 * WHY CONTENT AND NOT TIMESTAMPS. `calculated_at` on both tables is
 * `ON UPDATE CURRENT_TIMESTAMP`, which moves only when a value changes: a
 * re-persist that produces identical totals leaves the summary's timestamp
 * where it was while a day's moves, and a timestamp rule would call the month
 * stale for ever. A rewrite that changes nothing leaves the fingerprint
 * exactly as it was, so it is never mistaken for a change.
 *
 * The fields are those that decide pay or its provenance: what is priced
 * (shortage, approved OT, their rate basis), whether the day is settled, and
 * the permission applied. The day's calculation version is included, so a
 * recalculation under a new engine rule is a change.
 */
const crypto = require("crypto");

const FINGERPRINT_FIELDS = [
  "attendance_date",
  "status",
  "is_final",
  "attendance_day_count",
  "nrm_minutes",
  "base_nrm_minutes",
  "worked_minutes",
  "shortage_minutes",
  "approved_ot_minutes",
  "ot_rate",
  "permission_minutes",
  "calculation_version",
];

/**
 * The day rows the fingerprint is taken over: every stored day of the
 * employee's month, in date order. The same statement at persist and at lock,
 * so the two cannot read different things. `lockClause` is appended by the
 * lock-time reader (`LOCK IN SHARE MODE`) so it reads the latest committed
 * rows rather than an older transaction snapshot.
 */
function dayRowsSql(lockClause = "") {
  return `SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
                 status, is_final, attendance_day_count, nrm_minutes, base_nrm_minutes,
                 worked_minutes, shortage_minutes, approved_ot_minutes, ot_rate,
                 permission_minutes, calculation_version
            FROM attendance_day_calculation
           WHERE employee_id = ?
             AND attendance_date BETWEEN ? AND ?
           ORDER BY attendance_date ASC
           ${lockClause}`;
}

function monthWindow(year, month) {
  const y = Number(year);
  const m = Number(month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

/** One value, normalised so a DECIMAL "1.50" and a number 1.5 agree. */
function norm(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const s = String(value);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** SHA-256 over the rows' fingerprint fields, in date order. */
function dayRowsFingerprint(rows = []) {
  const canonical = (Array.isArray(rows) ? rows : [])
    .map((row) => FINGERPRINT_FIELDS.map((f) => norm(row && row[f])))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The verdict Approve & Lock acts on.
 *
 *   no summary          nothing to compare; payroll's own readiness decides
 *   no fingerprint      the summary predates this check - STALE, so it is
 *                       persisted once more before anything locks on it
 *   fingerprint differs STALE
 *   equal               CURRENT
 */
function monthFreshness({ monthly = null, dayRows = [] } = {}) {
  if (!monthly) return { state: "NO_SUMMARY" };
  const recorded = monthly.day_rows_fingerprint || null;
  if (!recorded) return { state: "STALE", reason: "UNTRACKED" };
  const current = dayRowsFingerprint(dayRows);
  return current === recorded ? { state: "CURRENT" } : { state: "STALE", reason: "DAYS_CHANGED" };
}

module.exports = {
  FINGERPRINT_FIELDS,
  dayRowsSql,
  monthWindow,
  dayRowsFingerprint,
  monthFreshness,
};
