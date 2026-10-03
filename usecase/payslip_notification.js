const {
  NOTIFICATION_RESULT,
  NOTIFICATION_TRIGGER,
  NOTIFY_CONCURRENCY,
  NOTIFY_TIMEOUT_MS,
  notificationText,
} = require("../constants/payslip");
const { webAppKeyboard, SECTION } = require("../utils/telegram_mini_app_url");

/**
 * "YOUR PAYSLIP IS AVAILABLE" - the Telegram notification, and only that.
 *
 * NO DOCUMENT IS SENT. The message says a payslip exists and carries a
 * button that opens My Payslips; every figure stays behind the Mini App's
 * signed-session gate. The text is built from the month alone
 * (`notificationText`) and there is no argument through which an amount
 * could reach it.
 *
 * THE DESTINATION IS THE SERVER'S. `employee_id -> active
 * employee_telegram_identity -> private_chat_id`, looked up here at send
 * time. No caller - and no browser - supplies a chat id; there is no
 * parameter for one.
 *
 * PUBLICATION IS NOT TOUCHED. A missing link records NO_TELEGRAM_LINK, an
 * error records FAILED, and either way the payslip stays published. Every
 * attempt is its own append-only row (attempt 1, 2, ...); a retry is a new
 * row with trigger RETRY and never a republish.
 *
 * LOGS CARRY NO FIGURES: a code, the payslip id and the employee id.
 */

/** A short, figure-free failure code from a Telegram / network error. */
function failureOf(err) {
  if (!err) return { code: "UNKNOWN", reason: null };
  if (err.code === "NOTIFY_TIMEOUT") return { code: "TIMEOUT", reason: "No answer from Telegram in time" };
  const msg = String(err.message || err);
  if (/TELEGRAM_BOT_TOKEN missing|not configured/i.test(msg)) {
    return { code: "TELEGRAM_NOT_CONFIGURED", reason: "Telegram is not configured on the server" };
  }
  const status =
    (err.response && (err.response.status || (err.response.data && err.response.data.error_code))) ||
    err.status ||
    null;
  const description =
    (err.response && err.response.data && err.response.data.description) || null;
  if (status) {
    return {
      code: `TELEGRAM_${status}`,
      reason: description ? String(description).slice(0, 200) : `Telegram answered ${status}`,
    };
  }
  return { code: "SEND_ERROR", reason: msg.slice(0, 200) };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("timeout");
        err.code = "NOTIFY_TIMEOUT";
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.payslipRepo   repository/payrun_payslip.js
 * @param {object} deps.identityRepo  repository/employee_telegram.js (getActiveIdentityByEmployee)
 * @param {object} deps.telegram      services/telegram.js (sendMessage)
 * @param {function():?string} [deps.getMiniAppUrl]
 * @param {object} [deps.log]
 * @param {function():Date} [deps.now]
 */
module.exports = ({ payslipRepo, identityRepo, telegram, getMiniAppUrl = () => null, log = null, now = () => new Date(), timeoutMs = NOTIFY_TIMEOUT_MS }) => {
  const COMPONENT = "USECASE.PAYSLIP-NOTIFICATION";
  const say = (code, ref, level = "error") => {
    if (!log || typeof log.Log !== "function") return;
    try {
      log.Log({ level, component: COMPONENT, code: `${COMPONENT}.${code}`, description: code, category: "", ref });
    } catch (err) {
      // logging never breaks a send
    }
  };

  /**
   * One payslip, one attempt. Never throws: the outcome is returned and
   * recorded. `payslip` is `{ payslip_id, employee_id, period_year, period_month }`.
   */
  const notifyOne = async (payslip, { trigger = NOTIFICATION_TRIGGER.PUBLISH, actor = {} } = {}) => {
    const attemptedAt = now();
    const base = {
      payslip_id: payslip.payslip_id,
      employee_id: payslip.employee_id,
      trigger_type: trigger,
      requested_by: actor.employeeId === undefined ? null : actor.employeeId,
      requested_by_user: actor.userId === undefined ? null : actor.userId,
      attempted_at: attemptedAt,
    };
    let outcome;
    let identity = null;
    try {
      identity = await identityRepo.getActiveIdentityByEmployee(payslip.employee_id);
    } catch (err) {
      outcome = { result: NOTIFICATION_RESULT.FAILED, failure_code: "IDENTITY_LOOKUP_FAILED", failure_reason: null };
    }
    if (!outcome && (!identity || !identity.private_chat_id)) {
      outcome = { result: NOTIFICATION_RESULT.NO_TELEGRAM_LINK, failure_code: "NO_TELEGRAM_LINK", failure_reason: null };
    }
    if (!outcome) {
      const keyboard = webAppKeyboard(typeof getMiniAppUrl === "function" ? getMiniAppUrl() : null, [
        { text: "Open My Payslips", section: SECTION.PAYSLIPS },
      ]);
      try {
        const sent = await withTimeout(
          telegram.sendMessage(
            identity.private_chat_id,
            notificationText(payslip.period_year, payslip.period_month),
            keyboard ? { parseMode: null, replyMarkup: keyboard, disableNotification: false } : { parseMode: null, disableNotification: false }
          ),
          timeoutMs
        );
        outcome = {
          result: NOTIFICATION_RESULT.SENT,
          telegram_message_id: sent && sent.message_id ? sent.message_id : null,
        };
      } catch (err) {
        const f = failureOf(err);
        outcome = { result: NOTIFICATION_RESULT.FAILED, failure_code: f.code, failure_reason: f.reason };
      }
    }
    const record = {
      ...base,
      ...outcome,
      employee_telegram_id: identity ? identity.employee_telegram_id || null : null,
      private_chat_id: identity ? identity.private_chat_id || null : null,
    };
    try {
      await payslipRepo.insertNotification(record);
    } catch (err) {
      say("RECORD-FAILED", { payslip_id: payslip.payslip_id, employee_id: payslip.employee_id });
    }
    if (outcome.result !== NOTIFICATION_RESULT.SENT) {
      say(outcome.failure_code || outcome.result, { payslip_id: payslip.payslip_id, employee_id: payslip.employee_id }, "info");
    }
    return {
      payslip_id: payslip.payslip_id,
      employee_id: payslip.employee_id,
      result: outcome.result,
      failure_code: outcome.failure_code || null,
    };
  };

  /** Many payslips, a few at a time; one failure never stops the rest. */
  const notifyMany = (payslips, opts = {}) =>
    mapLimited(payslips || [], NOTIFY_CONCURRENCY, (p) => notifyOne(p, opts));

  return { notifyOne, notifyMany };
};
module.exports.failureOf = failureOf;
module.exports.mapLimited = mapLimited;
