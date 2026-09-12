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

function istToday(override = null) {
  if (typeof override === "string" && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const ist = new Date(Date.now() + IST_OFFSET_MINUTES * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(
    ist.getUTCDate()
  ).padStart(2, "0")}`;
}

module.exports = { IST_OFFSET_MINUTES, istToday };
