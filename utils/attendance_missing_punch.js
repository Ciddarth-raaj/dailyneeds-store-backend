/**
 * MISSING PUNCH: ONE ANSWER TO "MAY THIS DATE BE REGULARIZED?".
 *
 * ================================================================ WHY ======
 *
 * The employee's screen and the request guard used to answer the question
 * from two different punch sets. A screen reads a closed date through
 * `utils/attendance_stored_read.js`, which returns the STORED row and its
 * stored `effective_punches`; `raiseRequest` recalculated the same date LIVE
 * and counted the engine's punches. While the two agree that is invisible.
 * When they disagree - a Biomax punch imported after the date was calculated,
 * a date never recalculated since - the modal listed one punch and offered
 * Regularize, and the submission came back "2026-09-17 has 2 punches - a
 * punch cannot be added to a complete day", naming punches the employee was
 * never shown.
 *
 * So the decision is taken ONCE, here, from ONE day object - the canonical
 * day, which is whatever the read path returns for that date and therefore
 * exactly what the employee is looking at. The frontend mirrors these rules
 * in `util/attendanceV2.js` so a button is never offered for a day the
 * backend will refuse.
 *
 * ============================================================== THE RULES ===
 *
 *   no day / no shift            nothing to regularize yet
 *   stale punch evidence         the stored row was calculated from a
 *                                different set of punches than the device now
 *                                shows. Neither count may be used: the stored
 *                                one is out of date and the live one is not
 *                                what the employee sees. The date has to be
 *                                RECALCULATED first, deliberately, by the same
 *                                path that owns stored history.
 *   even effective punch count   a complete day. Refused - this feature adds
 *                                a MISSING punch and can never name, replace
 *                                or edit an existing one.
 *   odd effective punch count    regularizable.
 *
 * The complete-day guard is unchanged and stays exactly as strict; what
 * changed is only that it now counts the same punches the employee counted.
 */

const REASON = Object.freeze({
  NO_DAY: "NO_DAY",
  STALE_PUNCH_EVIDENCE: "STALE_PUNCH_EVIDENCE",
  COMPLETE_DAY: "COMPLETE_DAY",
});

/**
 * The punches of a day, as an order-sensitive signature. Two days have the
 * same effective punch set when their punch instants match, one for one, in
 * order - the only comparison that survives a stored row (JSON, no punch ids
 * on a regularized punch) being compared with a freshly calculated one.
 */
function punchSignature(punches) {
  return (Array.isArray(punches) ? punches : [])
    .map((p) => String((p && p.io_time) || ""))
    .join("|");
}

/** Whether a stored day's punch evidence still matches the live calculation. */
function punchEvidenceStale(stored, live) {
  if (!stored || !live) return false;
  return punchSignature(stored.effective_punches) !== punchSignature(live.effective_punches);
}

/**
 * May a missing-punch regularization be raised for this day?
 *
 * @param {object|null} day  the CANONICAL day - what the read path returns
 * @returns {{allowed:boolean, reason:string|null, message:string|null}}
 */
function missingPunchEligibility(day) {
  if (!day) {
    return { allowed: false, reason: REASON.NO_DAY, message: "There is no calculated day for this date yet" };
  }
  const date = String(day.attendance_date || "this date");
  if (day.punch_evidence_stale === true) {
    const shown = Number(day.punch_count) || 0;
    const now = day.live_punch_count === null || day.live_punch_count === undefined
      ? null
      : Number(day.live_punch_count);
    return {
      allowed: false,
      reason: REASON.STALE_PUNCH_EVIDENCE,
      message:
        `${date} was calculated from a different set of punches than the device now shows` +
        (now === null ? "" : ` (${shown} calculated, ${now} on the device)`) +
        ". It has to be recalculated before a missing punch can be regularized.",
    };
  }
  const count = Number(day.punch_count) || 0;
  if (count % 2 !== 1) {
    return {
      allowed: false,
      reason: REASON.COMPLETE_DAY,
      message: `${date} has ${count} punches - a punch cannot be added to a complete day`,
    };
  }
  return { allowed: true, reason: null, message: null };
}

module.exports = { REASON, punchSignature, punchEvidenceStale, missingPunchEligibility };
