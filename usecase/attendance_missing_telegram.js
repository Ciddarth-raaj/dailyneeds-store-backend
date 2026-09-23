/**
 * THE 07:00 MISSING ATTENDANCE ALERT - one private message per employee per
 * attendance date, for yesterday only.
 *
 * ============================================== WHAT DECIDES WHO IS MESSAGED
 *
 * NOTHING IN THIS FILE. The population is
 * `usecase/attendance_missing.js#getTelegramCandidates`, which is the report's
 * own builder with the window pinned to yesterday. This file decides only how
 * a message is addressed, sent, recorded and retried - never who deserves one.
 * That separation is the point of the feature: the report and the alert cannot
 * disagree about the population, because only one of them computes it.
 *
 * ===================================================== THE DELIVERY RULES ==
 *
 *   PRIVATE ONLY          `employee_telegram_identity.private_chat_id` - the
 *                         verified 1:1 chat between the employee and the bot.
 *                         No group, no channel, no department chat. An
 *                         employee's attendance is their own business, and a
 *                         group message is a disclosure to everybody in it.
 *   ONE PER EMPLOYEE      per attendance date, enforced by a UNIQUE key in
 *   PER DATE              the database rather than by a check in code - see
 *                         `repository/attendance_missing.js#claim`.
 *   NO 0-PUNCH SENDS      guaranteed upstream: a zero-punch day is never in
 *                         the candidate list at all. It is asserted again
 *                         here, cheaply, because this is the last point
 *                         before a phone buzzes.
 *   ONE FAILURE IS ONE    every send is awaited in its own try/catch and
 *   FAILURE               recorded; the loop continues. A batch that aborted
 *                         on the first blocked bot would leave everybody
 *                         after that employee silently unchased.
 *   EVERY OUTCOME IS      SENT / FAILED / SKIPPED, with a short reason code,
 *   RECORDED              in `attendance_missing_notification`.
 *
 * ========================================= THE TELEGRAM ATTENDANCE MINI APP =
 *
 * `correctionButton` attaches ONE inline `web_app` button - "Regularise
 * Attendance" - IF, and only if, a Mini App base URL is configured. With no
 * URL configured the message goes out with no keyboard at all and everything
 * else is unchanged: delivery never depends on the Mini App existing.
 *
 * THE URL CARRIES NAVIGATION AND NOTHING ELSE. `?section=corrections` opens
 * the Corrections tab directly - the employee tapped a button about a missing
 * punch, so landing them on My Attendance and asking them to find the right
 * tab is a step they should not have to take - and `&date=` tells the Mini App
 * which card to highlight once there. NEITHER IS AUTHORITY: identity comes
 * from Telegram's signed `initData`, and the list of dates comes from the
 * server for the employee that signature resolves to, so a date the employee
 * is not entitled to simply is not in the list and highlights nothing.
 *
 * `employee_id` is deliberately NOT in the URL - a query-string employee id
 * would be a value a browser could change - and it is not merely left out
 * here: the URL is built by `utils/telegram_mini_app_url.js`, which has no
 * parameter for one.
 *
 * ============================== THE EMPLOYEE IS NOT TOLD THEIR PUNCH COUNT =
 *
 * `buildMessage` names the DATE and asks for a correction. It does not say
 * how many punches were recorded, because that number answers no question the
 * employee can act on and invites an argument with a machine. The count is
 * still computed, still stored on the notification ledger row, still on the
 * Missing Attendance report and still in every calculation - it is only
 * absent from what the employee reads.
 */

const missing = require("../utils/attendance_missing");
const { webAppButton, SECTION } = require("../utils/telegram_mini_app_url");

/** The outcome vocabulary. Stored as-is in the ledger's `status` column. */
const OUTCOME = Object.freeze({
  SENT: "SENT",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

/** Why a candidate was skipped or failed. Short codes, never raw error text. */
const REASON = Object.freeze({
  ALREADY_NOTIFIED: "ALREADY_NOTIFIED",
  NO_TELEGRAM_IDENTITY: "NO_TELEGRAM_IDENTITY",
  NOT_ODD_PUNCH_COUNT: "NOT_ODD_PUNCH_COUNT",
  TELEGRAM_NOT_CONFIGURED: "TELEGRAM_NOT_CONFIGURED",
  SEND_FAILED: "SEND_FAILED",
});

/** `2026-09-18` -> `18 Sep 2026`, the shape the approved message text uses. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function displayDate(dateOnly) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly || ""));
  if (!m) return String(dateOnly || "");
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * The message. PLAIN TEXT, no parse mode.
 *
 * `services/telegram.js` defaults to legacy Markdown, which REJECTS THE WHOLE
 * MESSAGE when interpolated text contains an unbalanced `_`, `*` or backtick.
 * Nothing is interpolated here today but the date - but the
 * plain path costs nothing and means a future line carrying an employee name
 * or a shift code cannot silently stop the whole batch. The existing security
 * alerts take the same path for the same reason.
 */
function buildMessage({ attendance_date }) {
  return [
    "Good morning.",
    `Your attendance for ${displayDate(attendance_date)} has a missing punch.`,
    "Please submit the required attendance correction.",
  ].join("\n");
}

/**
 * THE FUTURE ONE-TIME HISTORICAL CATCH-UP MESSAGE, written now and sent by
 * nothing.
 *
 * NO JOB CALLS THIS. It exists so that when a catch-up is approved, the
 * message it sends is this one rather than a second message format invented
 * under time pressure - and so the "no punch counts to the employee" rule is
 * already true of it. The Mini App needs no change to serve it: its list
 * already returns EVERY actionable date inside the regularisation window, so
 * one button over several dates opens exactly the right screen.
 */
function buildHistoricalMessage(attendanceDates) {
  const dates = (Array.isArray(attendanceDates) ? attendanceDates : [])
    .map((d) => displayDate(d))
    .filter((d) => d !== "");
  if (dates.length === 0) return null;
  return [
    "Good morning.",
    "You have missing attendance punches on the following dates:",
    ...dates,
    "Please submit the required attendance corrections.",
  ].join("\n");
}

/** The label on the button, in one place so the message and the tests agree. */
const CORRECTION_BUTTON_TEXT = "Regularise Attendance";

/**
 * THE INTERNAL HANDOFF RECORD, named once.
 *
 * This is what the ledger and the batch summary carry so a later reader can
 * see which employee and date a message was about, and how odd the day was.
 * IT IS NOT WHAT THE EMPLOYEE SEES and it is not what goes in the URL: the
 * punch count here is an audit fact, and `employee_id` never leaves the
 * server.
 */
function buildCorrectionTarget(candidate) {
  return {
    employee_id: Number(candidate.employee_id),
    attendance_date: candidate.attendance_date,
    punch_count: candidate.punch_count,
  };
}

/**
 * The inline keyboard, or null when no Mini App is configured.
 *
 * Null means the message is sent with no keyboard at all - alert delivery
 * does not depend on the Mini App being deployed.
 *
 * THE URL IS BUILT BY `utils/telegram_mini_app_url.js`, the one place any
 * Mini App URL is built. It opens Corrections and highlights this date; there
 * is no parameter for an employee id anywhere on that path.
 */
function correctionButton(candidate, miniAppUrl) {
  const button = webAppButton(miniAppUrl, CORRECTION_BUTTON_TEXT, {
    section: SECTION.CORRECTIONS,
    date: candidate.attendance_date,
  });
  return button === null ? null : { inlineKeyboard: [[button]] };
}

/**
 * @param {object} deps
 * @param {object} deps.attendanceMissingUsecase  the population - the ONLY source
 * @param {object} deps.attendanceMissingRepo     the ledger and the chat lookup
 * @param {object} deps.telegramService           services/telegram.js
 * @param {string} [deps.miniAppUrl]              optional; no button when absent
 * @param {object} [deps.log]                     anything with .info/.error
 */
module.exports = ({
  attendanceMissingUsecase,
  attendanceMissingRepo,
  telegramService,
  miniAppUrl = null,
  log = null,
}) => {
  const say = (level, message, extra) => {
    if (log && typeof log[level] === "function") log[level](message, extra);
    else console.log(`ATTENDANCE.MISSING.TELEGRAM ${level.toUpperCase()} ${message}`);
  };

  /**
   * Run the batch for one attendance date - yesterday, unless a date is
   * passed for a replay.
   *
   * IDEMPOTENT BY CONSTRUCTION. Re-running it on the same date claims nothing
   * new and sends nothing: every candidate is already claimed, and each is
   * reported SKIPPED/ALREADY_NOTIFIED. That holds for a scheduler retry, for
   * a second app instance firing the same cron, and for a human running it by
   * hand afterwards.
   */
  const run = async ({ today = null } = {}) => {
    const { meta, data } = await attendanceMissingUsecase.getTelegramCandidates({ today });
    const attendanceDate = meta.effective_to_date || missing.yesterdayOf(meta.today);

    const summary = {
      attendance_date: attendanceDate,
      candidates: data.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };
    if (data.length === 0) {
      say("info", `no missing attendance for ${attendanceDate}`);
      return summary;
    }

    const record = (candidate, outcome, reason = null) => {
      summary.results.push({
        employee_id: Number(candidate.employee_id),
        attendance_date: candidate.attendance_date,
        punch_count: candidate.punch_count,
        outcome,
        reason,
        // Carried so a caller - and a later Mini App - has the handoff
        // without re-deriving it from the row.
        correction_target: buildCorrectionTarget(candidate),
      });
      if (outcome === OUTCOME.SENT) summary.sent += 1;
      else if (outcome === OUTCOME.FAILED) summary.failed += 1;
      else summary.skipped += 1;
    };

    // THE BOT'S AVAILABILITY IS CHECKED ONCE, BEFORE ANYTHING IS CLAIMED.
    // Claiming rows and then discovering there is no token would burn the
    // (employee, date) keys for the day: the ledger would say a decision had
    // been made about people nobody could message, and the next run would
    // skip them as already notified. So nothing is claimed at all.
    const configured = !telegramService || typeof telegramService.isConfigured !== "function"
      ? true
      : telegramService.isConfigured();
    if (!configured) {
      data.forEach((c) => record(c, OUTCOME.SKIPPED, REASON.TELEGRAM_NOT_CONFIGURED));
      say("error", `telegram bot not configured; ${data.length} alert(s) not sent for ${attendanceDate}`);
      return summary;
    }

    const employeeIds = [...new Set(data.map((c) => Number(c.employee_id)))];
    const chats = await attendanceMissingRepo.getActiveTelegramChats(employeeIds);
    const chatByEmployee = new Map(
      (chats || []).map((row) => [Number(row.employee_id), row.private_chat_id])
    );

    for (const candidate of data) {
      const employeeId = Number(candidate.employee_id);
      const chatId = chatByEmployee.get(employeeId);

      // Belt and braces on the last line before a phone buzzes. The
      // population cannot produce an even or zero count; if it ever did, this
      // refuses to send rather than trusting the caller.
      if (!missing.isMissingPunchCount(candidate.punch_count)) {
        record(candidate, OUTCOME.SKIPPED, REASON.NOT_ODD_PUNCH_COUNT);
        continue;
      }

      // NO MAPPING IS NOT AN ERROR AND IS NOT INVENTED AROUND. The employee
      // has not linked Telegram; the row records that, the batch carries on,
      // and the gap is visible in the ledger rather than guessed at with a
      // username or redirected to a group.
      if (chatId === undefined || chatId === null) {
        try {
          const claim = await attendanceMissingRepo.claim({
            employee_id: employeeId,
            attendance_date: candidate.attendance_date,
            punch_count: candidate.punch_count,
            telegram_chat_id: null,
          });
          if (!claim.claimed) {
            record(candidate, OUTCOME.SKIPPED, REASON.ALREADY_NOTIFIED);
            continue;
          }
          await attendanceMissingRepo.settle({
            employee_id: employeeId,
            attendance_date: candidate.attendance_date,
            status: OUTCOME.SKIPPED,
            failure_reason: REASON.NO_TELEGRAM_IDENTITY,
          });
        } catch (err) {
          say("error", `ledger write failed for employee ${employeeId}: ${err.message}`);
        }
        record(candidate, OUTCOME.SKIPPED, REASON.NO_TELEGRAM_IDENTITY);
        continue;
      }

      // THE CLAIM IS THE DUPLICATE GUARD, and it happens BEFORE the send.
      // Claim-then-send can at worst lose a message (the process dies between
      // the two, leaving a PENDING row that says so); send-then-record can
      // send the same message twice, which is the failure this feature must
      // not have.
      let claimed = false;
      try {
        const claim = await attendanceMissingRepo.claim({
          employee_id: employeeId,
          attendance_date: candidate.attendance_date,
          punch_count: candidate.punch_count,
          telegram_chat_id: chatId,
        });
        claimed = claim.claimed;
      } catch (err) {
        say("error", `could not claim employee ${employeeId}: ${err.message}`);
        record(candidate, OUTCOME.FAILED, REASON.SEND_FAILED);
        continue;
      }

      if (!claimed) {
        record(candidate, OUTCOME.SKIPPED, REASON.ALREADY_NOTIFIED);
        continue;
      }

      try {
        const keyboard = correctionButton(candidate, miniAppUrl);
        await telegramService.sendMessage(
          chatId,
          buildMessage(candidate),
          // Plain text - see `buildMessage`. `replyMarkup` is omitted
          // entirely when there is no Mini App, rather than sent as null.
          keyboard ? { parseMode: null, replyMarkup: keyboard } : { parseMode: null }
        );
        await attendanceMissingRepo.settle({
          employee_id: employeeId,
          attendance_date: candidate.attendance_date,
          status: OUTCOME.SENT,
          telegram_chat_id: chatId,
        });
        record(candidate, OUTCOME.SENT);
      } catch (err) {
        // ONE FAILED MESSAGE IS ONE FAILED MESSAGE. It is recorded FAILED -
        // not released - because the send may well have arrived; the loop
        // moves on to the next employee.
        try {
          await attendanceMissingRepo.settle({
            employee_id: employeeId,
            attendance_date: candidate.attendance_date,
            status: OUTCOME.FAILED,
            failure_reason: REASON.SEND_FAILED,
            telegram_chat_id: chatId,
          });
        } catch (ledgerErr) {
          say("error", `ledger write failed for employee ${employeeId}: ${ledgerErr.message}`);
        }
        // The error TEXT is not recorded: a Telegram error body can carry a
        // chat id or a token fragment. The code is, and the log has the rest.
        say("error", `send failed for employee ${employeeId} on ${candidate.attendance_date}: ${err.message}`);
        record(candidate, OUTCOME.FAILED, REASON.SEND_FAILED);
      }
    }

    say(
      "info",
      `${attendanceDate}: ${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} skipped of ${summary.candidates}`
    );
    return summary;
  };

  return {
    OUTCOME,
    REASON,
    CORRECTION_BUTTON_TEXT,
    buildMessage,
    buildHistoricalMessage,
    buildCorrectionTarget,
    correctionButton,
    run,
  };
};

module.exports.OUTCOME = OUTCOME;
module.exports.REASON = REASON;
module.exports.CORRECTION_BUTTON_TEXT = CORRECTION_BUTTON_TEXT;
module.exports.buildMessage = buildMessage;
module.exports.buildHistoricalMessage = buildHistoricalMessage;
module.exports.buildCorrectionTarget = buildCorrectionTarget;
module.exports.correctionButton = correctionButton;
module.exports.displayDate = displayDate;
