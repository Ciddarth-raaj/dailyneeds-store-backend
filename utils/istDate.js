/**
 * Today's date in IST, as `YYYY-MM-DD`.
 *
 * IST and not the process zone: the business day anything in this system
 * belongs to is the Indian one, and a server running in UTC would otherwise
 * date every evening action to the day before. The offset is applied to the
 * epoch and the date read back in UTC, so no local `Date` is constructed and
 * the answer does not depend on where the process runs.
 *
 * `override` exists so tests and callers that already hold a business date can
 * pin the day; it is never a caller-supplied field on a route.
 */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * The IST business date of a GIVEN instant, as `YYYY-MM-DD`.
 *
 * Split out of `istToday` so a caller that carries an INJECTED CLOCK - which
 * is how the usecases are made testable - can get the same answer without
 * reaching for `Date.now()`. The arithmetic is identical and lives here once:
 * the offset is applied to the epoch and the date read back in UTC, so no
 * local `Date` is constructed and the answer does not depend on the process
 * zone, `TZ`, or what pm2 was started with.
 *
 * Accepts a `Date` or an epoch in milliseconds. An unreadable value answers
 * null rather than silently dating something to 1970.
 */
function istDateOf(instant) {
  // STRICT ABOUT WHAT AN INSTANT IS. `Number(null)` and `Number("")` are both
  // 0, so a loose conversion would date a missing value to 1 January 1970 -
  // a real date, silently wrong, and one that would make an employee who
  // resigned in the 1970s look ineligible for the right answer by accident.
  let ms;
  if (instant instanceof Date) ms = instant.getTime();
  else if (typeof instant === "number") ms = instant;
  else return null;
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + IST_OFFSET_MINUTES * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(
    ist.getUTCDate()
  ).padStart(2, "0")}`;
}

function istToday(override = null) {
  if (typeof override === "string" && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return istDateOf(Date.now());
}

module.exports = { IST_OFFSET_MINUTES, istToday, istDateOf };
