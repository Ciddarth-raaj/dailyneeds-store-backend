const crypto = require("crypto");
const {
  NOTIFICATION_RESULT,
  NOTIFY_CONCURRENCY,
  NOTIFY_TIMEOUT_MS,
  notificationText,
} = require("../constants/payslip");
const { webAppKeyboard, SECTION } = require("../utils/telegram_mini_app_url");

/**
 * "YOUR PAYSLIP IS AVAILABLE" - THE TELEGRAM NOTIFICATION WORKER.
 *
 * ================================================ PUBLISH NEVER WAITS ON IT
 *
 * Publish queues attempt 1 (`payrun_payslip_notification`, QUEUED) inside
 * the publishing transaction and returns. This worker sends separately:
 *
 *   recover  SENDING rows older than any send can take belong to a process
 *            that died mid-send. Delivery is unknowable, so they are closed
 *            FAILED / INTERRUPTED - never re-sent automatically (that could
 *            notify twice) - and Retry Notification is offered.
 *   claim    an atomic UPDATE moves a batch QUEUED -> SENDING under a fresh
 *            claim token; no two passes or processes can take the same row.
 *   send     at most NOTIFY_CONCURRENCY at once, each with a timeout.
 *   record   SENT / FAILED / NO_TELEGRAM_LINK, only by the claiming pass.
 *
 * A pass runs on `kick()` (after a Publish or Retry commits), on a timer, and
 * at start-up - so QUEUED rows left by a restart are simply sent next pass.
 *
 * ====================================================== WHAT IS SENT ===
 *
 * NO DOCUMENT, NO FIGURE. The text is built from the month alone and carries
 * one button that opens My Payslips. The destination is the server's:
 * employee_id -> active employee_telegram_identity -> private_chat_id, looked
 * up at send time. No caller supplies a chat id; there is no parameter for one.
 * A payslip unpublished before its turn is not announced (FAILED /
 * PAYSLIP_NOT_PUBLISHED).
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
  const description = (err.response && err.response.data && err.response.data.description) || null;
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
 */
module.exports = ({
  payslipRepo,
  identityRepo,
  telegram,
  getMiniAppUrl = () => null,
  log = null,
  timeoutMs = NOTIFY_TIMEOUT_MS,
  concurrency = NOTIFY_CONCURRENCY,
  batchSize = 25,
  // Longer than any send can take (the send itself times out at timeoutMs).
  interruptedAfterSeconds = 120,
  intervalMs = 30000,
}) => {
  const COMPONENT = "USECASE.PAYSLIP-NOTIFICATION";
  const say = (code, ref, level = "error") => {
    if (!log || typeof log.Log !== "function") return;
    try {
      log.Log({ level, component: COMPONENT, code: `${COMPONENT}.${code}`, description: code, category: "", ref });
    } catch (err) {
      // logging never breaks a send
    }
  };

  /** One claimed attempt: decide, send, record. Never throws. */
  const deliver = async (row, token) => {
    let outcome;
    let identity = null;
    if (Number(row.deliverable) !== 1) {
      outcome = { result: NOTIFICATION_RESULT.FAILED, failure_code: "PAYSLIP_NOT_PUBLISHED", failure_reason: "The payslip is no longer published" };
    }
    if (!outcome) {
      try {
        identity = await identityRepo.getActiveIdentityByEmployee(row.employee_id);
      } catch (err) {
        outcome = { result: NOTIFICATION_RESULT.FAILED, failure_code: "IDENTITY_LOOKUP_FAILED", failure_reason: null };
      }
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
            notificationText(row.period_year, row.period_month),
            keyboard
              ? { parseMode: null, replyMarkup: keyboard, disableNotification: false }
              : { parseMode: null, disableNotification: false }
          ),
          timeoutMs
        );
        outcome = { result: NOTIFICATION_RESULT.SENT, telegram_message_id: sent && sent.message_id ? sent.message_id : null };
      } catch (err) {
        const f = failureOf(err);
        outcome = { result: NOTIFICATION_RESULT.FAILED, failure_code: f.code, failure_reason: f.reason };
      }
    }
    try {
      await payslipRepo.completeNotification({
        notification_id: row.notification_id,
        claim_token: token,
        ...outcome,
        employee_telegram_id: identity ? identity.employee_telegram_id || null : null,
        private_chat_id: identity ? identity.private_chat_id || null : null,
      });
    } catch (err) {
      say("RECORD-FAILED", { payslip_id: row.payslip_id, employee_id: row.employee_id });
    }
    if (outcome.result !== NOTIFICATION_RESULT.SENT) {
      say(outcome.failure_code || outcome.result, { payslip_id: row.payslip_id, employee_id: row.employee_id }, "info");
    }
    return { payslip_id: row.payslip_id, employee_id: row.employee_id, result: outcome.result };
  };

  let running = null;
  let again = false;
  let stopped = false;
  let timer = null;

  /** One pass: recover, then claim and send batches until the queue is empty. */
  const processQueue = () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      const done = [];
      try {
        do {
          again = false;
          // eslint-disable-next-line no-await-in-loop
          await payslipRepo.recoverInterrupted({ olderThanSeconds: interruptedAfterSeconds });
          for (;;) {
            const token = crypto.randomBytes(16).toString("hex");
            // eslint-disable-next-line no-await-in-loop
            const batch = await payslipRepo.claimQueued({ limit: batchSize, token });
            if (!batch || batch.length === 0) break;
            // eslint-disable-next-line no-await-in-loop
            done.push(...(await mapLimited(batch, concurrency, (row) => deliver(row, token))));
          }
        } while (again && !stopped);
      } catch (err) {
        say("PASS-FAILED", {});
      } finally {
        running = null;
      }
      return done;
    })();
    return running;
  };

  /** Start a pass soon, without waiting for it. Safe to call any number of times. */
  const kick = () => {
    if (stopped) return;
    setImmediate(() => {
      processQueue();
    });
  };

  /** Recover and drain now, then keep a slow timer as the safety net. */
  const start = () => {
    stopped = false;
    kick();
    if (!timer && intervalMs > 0) {
      timer = setInterval(kick, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { processQueue, kick, start, stop };
};
module.exports.failureOf = failureOf;
module.exports.mapLimited = mapLimited;
