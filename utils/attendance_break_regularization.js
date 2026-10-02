/**
 * Attendance Regularisation - a MISSED BREAK (lunch OUT + IN), as a pair.
 *
 * An employee who punched 10:09 and 22:04 but took lunch without punching
 * has a complete, even day, so the missing-punch path cannot touch it. The
 * same regularization request may instead carry a PAIR of manual punches -
 * the break's OUT and its IN - which, once approved, join the effective
 * punch list exactly as a missing punch does:
 *
 *   10:09 IN -> 14:00 OUT -> 15:00 IN -> 22:04 OUT
 *
 * and the day is calculated by the ordinary engine as a four-punch day. No
 * other calculation path exists for it.
 *
 * This file decides only whether a proposed pair is a valid break on the
 * day's EFFECTIVE punches (raw punches after voids and duplicate suppression,
 * plus any punch an earlier regularization already made effective). Nothing
 * here reads a database or a clock.
 *
 * THE RULE: the pair must sit strictly inside ONE worked segment - an IN and
 * the OUT that follows it - with OUT before IN. That single condition refuses
 * every invalid sequence:
 *
 *   before the first punch / after the last    outside every segment
 *   overlapping an existing break              spans an OUT -> IN gap
 *   OUT at or before the segment's IN          not strictly inside
 *   the same instant as an existing punch      not strictly inside
 *   IN before OUT, or the same minute          refused first
 */

const { absoluteMinutes } = require("./attendance_effective_punches");

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

/** `HH:MM` of a `YYYY-MM-DD HH:MM[:SS]` value, for messages. */
const hhmm = (value) => String(value || "").slice(11, 16);

/**
 * @param {object} input
 * @param {Array<{io_time: string}>} input.effective_punches  the day's
 *   effective punches (any order); their count must be even and non-zero
 * @param {string} input.out_time  the break's OUT, `YYYY-MM-DD HH:MM[:SS]`
 * @param {string} input.in_time   the break's IN, same format
 * @returns {{ok: true, segment: {in_time: string, out_time: string}} | {ok: false, reason: string}}
 */
function validateBreakPair({ effective_punches, out_time, in_time }) {
  const outTime = String(out_time || "").trim();
  const inTime = String(in_time || "").trim();
  if (!TIME_PATTERN.test(outTime) || !TIME_PATTERN.test(inTime)) {
    return { ok: false, reason: "break_out_time and break_in_time must be YYYY-MM-DD HH:MM:SS" };
  }
  const outMinute = absoluteMinutes(outTime);
  const inMinute = absoluteMinutes(inTime);
  if (outMinute === null || inMinute === null) {
    return { ok: false, reason: "break_out_time and break_in_time must be real times" };
  }
  if (inMinute <= outMinute) {
    return { ok: false, reason: `The break IN (${hhmm(inTime)}) must be after the break OUT (${hhmm(outTime)})` };
  }

  const punches = (effective_punches || [])
    .map((p) => ({ io_time: p.io_time, minute: absoluteMinutes(p.io_time) }))
    .filter((p) => p.minute !== null)
    .sort((a, b) => a.minute - b.minute);
  if (punches.length === 0) {
    return { ok: false, reason: "This date has no punches, so there is no working span to place a break in" };
  }
  if (punches.length % 2 === 1) {
    return {
      ok: false,
      reason: `This date has ${punches.length} punches - regularize the missing punch first, then the break`,
    };
  }

  const first = punches[0];
  const last = punches[punches.length - 1];
  if (outMinute <= first.minute || inMinute >= last.minute) {
    return {
      ok: false,
      reason:
        `A break must fall inside the day's punches (${hhmm(first.io_time)} – ${hhmm(last.io_time)}); ` +
        `${hhmm(outTime)} – ${hhmm(inTime)} does not`,
    };
  }

  // Positional pairing, as the engine pairs: 1st IN, 2nd OUT, 3rd IN, ...
  for (let i = 0; i + 1 < punches.length; i += 2) {
    const segIn = punches[i];
    const segOut = punches[i + 1];
    if (outMinute > segIn.minute && inMinute < segOut.minute) {
      return { ok: true, segment: { in_time: segIn.io_time, out_time: segOut.io_time } };
    }
  }
  return {
    ok: false,
    reason:
      `${hhmm(outTime)} – ${hhmm(inTime)} overlaps a punch or a break already recorded on this date; ` +
      "a break must sit inside one worked span (between an IN and the OUT after it)",
  };
}

module.exports = { validateBreakPair };
