/**
 * Attendance - the EFFECTIVE raw punch stream.
 *
 * Two exclusions sit between the immutable raw punch tables and the
 * calculation engine, and this is the only place either is decided:
 *
 *   1. MANUAL VOID. An authorized person recorded, with a reason, that a raw
 *      BIOMAX or IMPORT punch must not count (`attendance_punch_void`). The
 *      raw row is untouched; the void is an additive record beside it.
 *
 *   2. AUTOMATIC DUPLICATE SUPPRESSION. Over the employee's remaining raw
 *      punches, in chronological order, the first punch is kept and every
 *      later punch that falls TEN MINUTES OR LESS after the LAST KEPT punch
 *      is ignored. The comparison is always against the last KEPT punch, not
 *      the previous raw record: 09:00 / 09:04 / 09:09 / 09:11 keeps 09:00 and
 *      09:11, because 09:04 and 09:09 are both within ten minutes of 09:00
 *      and 09:11 is not. Exactly ten minutes is a duplicate (`<= 10`).
 *
 * Both apply to RAW punches only - BIOMAX and IMPORT, as ONE chronological
 * stream per employee whichever source recorded each punch. A REGULARIZED
 * punch is never passed through here: it was deliberately submitted and
 * approved, and the caller adds it to the effective list afterwards.
 *
 * Nothing here reads a database or a clock, and nothing here knows about
 * attendance dates: the stream is ordered by the ABSOLUTE punch instant, so
 * 23:58 and 00:04 are six minutes apart whatever date each is attributed to.
 * The caller feeds the whole neighbourhood of the range it is calculating
 * and groups by attendance date afterwards.
 *
 * Every punch comes back, kept or not, with an `effective_status`, so the
 * audit views can show an ignored or voided punch beside the ones that
 * counted. Suppression is derived, deterministic and never stored: the same
 * raw rows and the same void rows always produce the same answer.
 */

/** A later punch this many minutes or fewer after the last kept one is ignored. */
const DUPLICATE_WINDOW_MINUTES = 10;

const EFFECTIVE_PUNCH_STATUS = Object.freeze({
  USED: "USED",
  IGNORED_DUPLICATE: "IGNORED_DUPLICATE",
  VOIDED: "VOIDED",
});

const IGNORED_DUPLICATE_REASON = `Duplicate punch within ${DUPLICATE_WINDOW_MINUTES} minutes`;

/**
 * `YYYY-MM-DD HH:MM[:SS]` (or ISO with a T) -> whole minutes since the epoch,
 * by UTC arithmetic on the wall-clock fields. No timezone is applied: the
 * value is only ever compared with another produced the same way. Seconds
 * are truncated, as the engine truncates them.
 */
function absoluteMinutes(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (h > 23 || mi > 59) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 60000) + h * 60 + mi;
}

/** Chronological, ties on punch id, so every run orders identical input identically. */
function orderByInstant(punches) {
  return [...punches].sort((a, b) => {
    if (a.minute !== b.minute) return a.minute - b.minute;
    const ai = a.punch_id === null || a.punch_id === undefined ? Number.MAX_SAFE_INTEGER : Number(a.punch_id);
    const bi = b.punch_id === null || b.punch_id === undefined ? Number.MAX_SAFE_INTEGER : Number(b.punch_id);
    return ai - bi;
  });
}

/**
 * Apply both exclusions to ONE employee's raw punches.
 *
 * @param {Array<object>} rawPunches  `{punch_id, io_time, source, ...}`; a
 *   punch carrying a truthy `void` (or `attendance_punch_void_id`) is voided.
 * @param {object} [options]
 * @param {number} [options.window_minutes]  defaults to ten
 * @returns {{used: object[], excluded: object[], all: object[]}} every input
 *   punch, with `effective_status` and - for an exclusion - `exclusion_reason`
 *   plus, for a duplicate, `duplicate_of_punch_id` / `duplicate_of_io_time`.
 *   `all` is the whole stream in chronological order; `used` and `excluded`
 *   partition it.
 */
function resolveEffectiveRawPunches(rawPunches, options = {}) {
  const window = Number.isFinite(options.window_minutes)
    ? Number(options.window_minutes)
    : DUPLICATE_WINDOW_MINUTES;

  const ordered = orderByInstant(
    (rawPunches || [])
      .map((p) => ({ ...p, minute: absoluteMinutes(p.io_time) }))
      .filter((p) => p.minute !== null)
  );

  const all = [];
  const used = [];
  const excluded = [];
  let lastKept = null;

  for (const punch of ordered) {
    const { minute, ...rest } = punch;
    const isVoided = !!(punch.void || punch.attendance_punch_void_id);

    if (isVoided) {
      // A voided punch is out before the duplicate rule looks at anything,
      // so it can neither be kept nor cause a genuine punch to be ignored.
      const voidRecord = punch.void || {
        attendance_punch_void_id: punch.attendance_punch_void_id,
        reason: punch.void_reason === undefined ? null : punch.void_reason,
        voided_by_employee_id:
          punch.voided_by_employee_id === undefined ? null : punch.voided_by_employee_id,
        voided_by_name: punch.voided_by_name === undefined ? null : punch.voided_by_name,
        voided_at: punch.voided_at === undefined ? null : punch.voided_at,
      };
      const row = {
        ...rest,
        effective_status: EFFECTIVE_PUNCH_STATUS.VOIDED,
        exclusion_reason: voidRecord.reason || null,
        void: voidRecord,
      };
      all.push(row);
      excluded.push(row);
      continue;
    }

    if (lastKept !== null && minute - lastKept.minute <= window) {
      const row = {
        ...rest,
        effective_status: EFFECTIVE_PUNCH_STATUS.IGNORED_DUPLICATE,
        exclusion_reason: IGNORED_DUPLICATE_REASON,
        duplicate_of_punch_id: lastKept.punch_id === undefined ? null : lastKept.punch_id,
        duplicate_of_io_time: lastKept.io_time,
        duplicate_gap_minutes: minute - lastKept.minute,
      };
      all.push(row);
      excluded.push(row);
      continue;
    }

    const row = { ...rest, effective_status: EFFECTIVE_PUNCH_STATUS.USED };
    all.push(row);
    used.push(row);
    lastKept = { minute, punch_id: punch.punch_id, io_time: punch.io_time };
  }

  return { used, excluded, all };
}

/**
 * The same rule over MANY employees' punches at once, for the Punch Audit.
 * Each employee's stream is resolved independently; punches with no
 * employee are returned untouched with a null status, because a punch that
 * belongs to nobody is in nobody's stream.
 *
 * @param {Array<object>} punches  each with `employee_id`
 * @returns {Map<number|string, object>} punch_id -> the resolved punch
 */
function resolveEffectiveRawPunchesByEmployee(punches, options = {}) {
  const byEmployee = new Map();
  const resolved = new Map();
  (punches || []).forEach((p) => {
    if (p.employee_id === null || p.employee_id === undefined) {
      resolved.set(String(p.punch_id), { ...p, effective_status: null });
      return;
    }
    const key = Number(p.employee_id);
    if (!byEmployee.has(key)) byEmployee.set(key, []);
    byEmployee.get(key).push(p);
  });
  byEmployee.forEach((list) => {
    resolveEffectiveRawPunches(list, options).all.forEach((p) => {
      resolved.set(String(p.punch_id), p);
    });
  });
  return resolved;
}

module.exports = {
  DUPLICATE_WINDOW_MINUTES,
  EFFECTIVE_PUNCH_STATUS,
  IGNORED_DUPLICATE_REASON,
  absoluteMinutes,
  resolveEffectiveRawPunches,
  resolveEffectiveRawPunchesByEmployee,
};
