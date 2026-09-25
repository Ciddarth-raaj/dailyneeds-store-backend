/**
 * The DigiSME attendance kill switch.
 *
 * Attendance now comes from the direct Biomax receiver, and production no
 * longer holds DigiSME attendance credentials: left running, the two DigiSME
 * attendance jobs fail every minute and end up sending DigiSME failure
 * alerts on Telegram.
 *
 * `DIGISME_ATTENDANCE_CRON_ENABLED=false` stops those two jobs -
 * `digisme_attendance_live` (every minute) and `digisme_attendance_recovery`
 * (45 6,12,18,23) - from being REGISTERED at all. With neither registered,
 * nothing calls the sync usecase's `runLive` / `runHistorical`, so no DigiSME
 * API request is made and none of its failure alerts can be raised by a
 * cron. Nothing else is touched: every other cron, `CRON_DISABLED`, the
 * DigiSME client and import code, and the direct Biomax receiver.
 *
 * NOT REGISTERED, NOT A NO-OP TICK. A registered job that wakes up every
 * minute to return early still shows in the `[CRON]` startup listing and in
 * the operator's picture of what is running; the point of the switch is that
 * the bridge is OFF, so the jobs do not exist.
 *
 * DEFAULT ON. An absent variable, an empty one, or anything that is not the
 * word "false" leaves the jobs registered exactly as before, so a deploy that
 * has never heard of this flag behaves as it did yesterday. Only an explicit,
 * case-insensitive "false" (surrounding whitespace ignored) disables them.
 */
function isDigismeAttendanceCronEnabled(env = process.env) {
  return String((env && env.DIGISME_ATTENDANCE_CRON_ENABLED) || "").trim().toLowerCase() !== "false";
}

/** Logged once at startup when the switch is off. */
const DIGISME_ATTENDANCE_CRON_DISABLED_LOG =
  "[CRON] DigiSME attendance sync disabled by DIGISME_ATTENDANCE_CRON_ENABLED=false";

module.exports = { isDigismeAttendanceCronEnabled, DIGISME_ATTENDANCE_CRON_DISABLED_LOG };
