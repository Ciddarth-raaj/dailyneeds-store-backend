/**
 * When GRN verification starts applying.
 *
 * Verification was switched on for Daily Needs on this date, and it is NOT
 * retrospective: the several years of GRNs already synced from GoFrugal were
 * received and checked long before anybody was asked to sign one off, and
 * showing them all as "Pending Verification" would invent a backlog of work
 * that nobody owes. A GRN dated before this is simply outside the feature -
 * it carries no verification block, shows nothing in the verification
 * columns, and cannot be verified.
 *
 * COMPARED ON THE GRN's OWN DATE (MMH_MRC_DT), not on when a row was synced
 * or when somebody opened the page, so which GRNs are in scope is a fact
 * about the bills themselves and does not drift.
 *
 * The boundary is INCLUSIVE: a GRN dated exactly on the start date is in
 * scope, because the start date is the first day the feature applies.
 */
const VERIFICATION_START_DATE = "2026-09-17";

/**
 * Is this GRN inside the verification programme?
 *
 * `mmhMrcDt` is the calendar date the repository already normalises to
 * YYYY-MM-DD, so the comparison is a plain string compare - that ordering is
 * correct for ISO dates and involves no timezone at all, which is the point:
 * whether a bill is in scope must not depend on where the reader is.
 *
 * A GRN with no usable date is treated as OUT of scope. Failing closed is
 * right here: the alternative is inventing pending verification work for a
 * row we cannot even place in time.
 */
function isGrnVerifiable(mmhMrcDt) {
  if (mmhMrcDt == null) return false;
  const day = String(mmhMrcDt).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day >= VERIFICATION_START_DATE;
}

module.exports = {
  VERIFICATION_START_DATE,
  isGrnVerifiable,
};
