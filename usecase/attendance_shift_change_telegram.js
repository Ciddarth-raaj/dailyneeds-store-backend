const logger = require("../utils/logger");

/**
 * THE ONE-DAY SHIFT REQUEST ON TELEGRAM.
 *
 * ============================================== WHAT IS AND IS NOT SENT ====
 *
 * ONLY THE FIRST APPROVER IS MESSAGED. Not the second, not the final, not the
 * employee's manager for information, not a group. That is the approved rule
 * and it is implemented as a rule rather than as a default: `notifyFirstApprover`
 * is called exactly once, from the moment a request is created, and nothing in
 * this module is reachable from `decide`. When a first approver passes a
 * request on, the next stage appears in the web queue and no message is sent -
 * there is no code here that could send one.
 *
 * A ROLE CHAIN NAMES NOBODY, so nobody is messaged. An employee whose
 * designation falls back to the role chain has a first STAGE (say, Store
 * Manager) but not a first PERSON, and messaging "whoever holds the role"
 * would mean messaging several people about a request only one of them will
 * action - which is precisely the fan-out the rule forbids. Their request goes
 * to the web queue, exactly as it does today. The response says which happened
 * rather than leaving the caller to guess.
 *
 * ================================= THE SAME RECORD, FROM EITHER SURFACE ====
 *
 * Telegram does not have a decision path of its own. Both buttons call the
 * ordinary `usecase/attendance_regularization.js#decide`, with `source:
 * "TELEGRAM"`, so the authority check (`canApprove`), the payroll lock, the
 * one-stage-at-a-time transaction and the recalculated day are all the web
 * app's, unchanged. The only difference that reaches the database is the word
 * TELEGRAM in `attendance_approval_step.decision_source`.
 *
 * DOUBLE DECISION AND THE STALE BUTTON ARE THE SAME PROBLEM, and the database
 * already answers it: `decideStage` updates the step `AND decision = 'PENDING'`
 * and the request `AND status = 'PENDING' AND current_stage_no = ?`, so the
 * second of two taps affects no rows and comes back 409. This module's job is
 * only to say so kindly and to take the buttons away, which it does on EVERY
 * outcome - approved, rejected, already decided, or not yours to decide.
 *
 * ======================================== WHY REJECTION ASKS A QUESTION ====
 *
 * A rejection reason is mandatory, and a button cannot carry one. So Reject
 * does not decide: it asks, with a force-reply, and the approver's reply is
 * the reason. The reply is matched back to the request by the `#id` in the
 * message being replied to - NOT by state held in this process, which would
 * not survive a restart and would be a second place the truth lives.
 *
 * Approve needs no question and is a single tap.
 */

/** `callback_data` is limited to 64 bytes, so the verbs are one letter. */
const CALLBACK_PREFIX = "sc";

/** The reply prompt's text carries the request id, and is parsed back from it. */
const REJECT_PROMPT = (requestId) =>
  `Reject shift request #${requestId}\n\nReply to this message with the reason. It is recorded on the request and shown to the employee.`;

const REJECT_PROMPT_PATTERN = /Reject shift request #(\d+)/;

const minutesAsHours = (minutes) => {
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

module.exports = ({
  regularizationUsecase,
  employeeTelegramRepo,
  telegram,
  webBaseUrl = null,
} = {}) => {
  const configured = () =>
    Boolean(telegram && typeof telegram.isConfigured === "function" && telegram.isConfigured());

  const log = (code, err, ref = {}) =>
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.SHIFT_CHANGE_TELEGRAM",
      code: `USECASE.SHIFT_CHANGE_TELEGRAM.${code}`,
      description: err && err.toString ? err.toString() : String(err),
      category: "",
      ref,
    });

  /**
   * The message body. PLAIN TEXT, no parse mode - it interpolates an employee
   * name, an outlet name and a free-text reason, any of which can contain an
   * unbalanced `_` or `*` that would make Telegram reject the whole message
   * (see `services/telegram.js#sendMessage`).
   */
  const composeMessage = (request) =>
    [
      "Shift change request",
      "",
      `Employee: ${request.employee_name || "-"} (ID ${request.employee_id})`,
      `Outlet: ${request.outlet_name || "-"}`,
      `Date: ${request.attendance_date}`,
      `Normal shift: ${request.base_shift_label || "-"}`,
      `Requested shift: ${request.requested_shift_label || "-"}`,
      `Reason: ${request.reason || "-"}`,
      "",
      `Request #${request.attendance_approval_request_id}`,
    ].join("\n");

  const keyboardFor = (requestId) => {
    const row = [
      { text: "Approve", callback_data: `${CALLBACK_PREFIX}:${requestId}:A` },
      { text: "Reject", callback_data: `${CALLBACK_PREFIX}:${requestId}:R` },
    ];
    const buttons = [row];
    if (webBaseUrl) {
      buttons.push([
        { text: "View", url: `${String(webBaseUrl).replace(/\/$/, "")}/attendance/approval?type=SHIFT&request=${requestId}` },
      ]);
    }
    return { inline_keyboard: buttons };
  };

  /**
   * Message the FIRST approver, and only them.
   *
   * Never throws into the caller: a request that has been created is created,
   * and a Telegram outage must not roll it back or fail the employee's
   * submission. The outcome is returned so the response can say whether a
   * message went out.
   */
  const notifyFirstApprover = async (request) => {
    if (!configured()) return { sent: false, reason: "TELEGRAM_NOT_CONFIGURED" };

    const chain = Array.isArray(request.chain) ? request.chain : [];
    const firstStage = chain.find((step) => Number(step.stage_no) === 1) || null;
    const approverId =
      firstStage && firstStage.approver_employee_id ? Number(firstStage.approver_employee_id) : null;

    // A role chain names a STAGE, not a PERSON. Nobody is messaged; the
    // request is in the web queue for whoever holds the role.
    if (!approverId) return { sent: false, reason: "FIRST_APPROVER_IS_A_ROLE" };

    try {
      const identity = await employeeTelegramRepo.getActiveIdentityByEmployee(approverId);
      const chatId = identity && identity.private_chat_id ? identity.private_chat_id : null;
      if (!chatId) return { sent: false, reason: "APPROVER_HAS_NO_TELEGRAM", approver_employee_id: approverId };

      const sent = await telegram.sendMessage(chatId, composeMessage(request), {
        parseMode: null,
        replyMarkup: keyboardFor(request.attendance_approval_request_id),
      });

      return {
        sent: true,
        approver_employee_id: approverId,
        chat_id: chatId,
        message_id: sent && sent.message_id ? sent.message_id : null,
      };
    } catch (err) {
      log("NOTIFY-FIRST-APPROVER", err, { request_id: request.attendance_approval_request_id });
      return { sent: false, reason: "SEND_FAILED" };
    }
  };

  /** The Telegram user behind a tap, as an employee this backend knows. */
  const actorFor = async (telegramUserId) => {
    const identity = await employeeTelegramRepo.getActiveIdentityByTelegramUser(telegramUserId);
    if (!identity || !identity.employee_id) return null;
    return { employee_id: Number(identity.employee_id), user_type: null };
  };

  /** Take the buttons away, whatever happened. A decided request has no actions. */
  const retireButtons = async (chatId, messageId, footer) => {
    if (!chatId || !messageId) return;
    try {
      await telegram.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    } catch (err) {
      // An "message is not modified" or a message too old to edit is not a
      // failure of the decision, which has already been recorded.
      log("RETIRE-BUTTONS", err, { chat_id: chatId, message_id: messageId });
    }
    if (footer) {
      try {
        await telegram.sendMessage(chatId, footer, { parseMode: null });
      } catch (err) {
        log("SEND-FOOTER", err, { chat_id: chatId });
      }
    }
  };

  /**
   * A tap on Approve or Reject.
   *
   * Returns a small object describing what happened; the dispatcher uses it
   * for nothing but logging, because everything the approver needs to see has
   * already been sent to them by the time this returns.
   */
  const handleCallback = async (update) => {
    const query = update && update.callback_query;
    if (!query || !query.data) return { handled: false };

    const match = /^sc:(\d+):([AR])$/.exec(String(query.data));
    if (!match) return { handled: false };

    const requestId = Number(match[1]);
    const decision = match[2] === "A" ? "APPROVED" : "REJECTED";
    const chatId = query.message && query.message.chat ? query.message.chat.id : null;
    const messageId = query.message ? query.message.message_id : null;

    const answer = async (text) => {
      try {
        await telegram.answerCallbackQuery(query.id, text);
      } catch (err) {
        log("ANSWER-CALLBACK", err, { request_id: requestId });
      }
    };

    const actor = await actorFor(query.from ? query.from.id : null);
    if (!actor) {
      await answer("This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }

    // REJECTION ASKS FIRST. Nothing is decided by this tap.
    if (decision === "REJECTED") {
      await answer("Please reply with the reason.");
      try {
        await telegram.sendMessage(chatId, REJECT_PROMPT(requestId), {
          parseMode: null,
          replyMarkup: { force_reply: true },
        });
      } catch (err) {
        log("REJECT-PROMPT", err, { request_id: requestId });
      }
      return { handled: true, outcome: "REJECT_REASON_REQUESTED" };
    }

    return decide({ actor, requestId, decision, remarks: null, chatId, messageId, answer });
  };

  /**
   * The reply that carries a rejection reason.
   *
   * Claimed ONLY when it is a reply to this bot's own reject prompt, which is
   * how it cannot swallow a `/start` deep link, a shared contact or any other
   * message the dispatcher's other handlers are waiting for.
   */
  const claimsRejectReply = (update) => {
    const message = update && update.message;
    const repliedTo = message && message.reply_to_message;
    return Boolean(
      message &&
        typeof message.text === "string" &&
        repliedTo &&
        typeof repliedTo.text === "string" &&
        REJECT_PROMPT_PATTERN.test(repliedTo.text)
    );
  };

  const handleRejectReply = async (update) => {
    const message = update.message;
    const requestId = Number(REJECT_PROMPT_PATTERN.exec(message.reply_to_message.text)[1]);
    const chatId = message.chat ? message.chat.id : null;
    const reason = String(message.text || "").trim();

    const say = async (text) => {
      try {
        await telegram.sendMessage(chatId, text, { parseMode: null });
      } catch (err) {
        log("SAY", err, { request_id: requestId });
      }
    };

    if (reason.length < 5) {
      await say("A rejection reason of at least 5 characters is required. Tap Reject again to retry.");
      return { handled: true, outcome: "REASON_TOO_SHORT" };
    }

    const actor = await actorFor(message.from ? message.from.id : null);
    if (!actor) {
      await say("This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }

    return decide({
      actor,
      requestId,
      decision: "REJECTED",
      remarks: reason,
      chatId,
      messageId: null,
      answer: say,
    });
  };

  /** The one decision path, shared by both surfaces of this module. */
  const decide = async ({ actor, requestId, decision, remarks, chatId, messageId, answer }) => {
    try {
      const result = await regularizationUsecase.decide({
        actor,
        request_id: requestId,
        decision,
        remarks,
        source: "TELEGRAM",
      });

      // 409 is the STALE BUTTON: somebody - possibly this same approver, in
      // the web app - has already decided this stage.
      if (result && result.code === 409) {
        await answer("This request has already been actioned.");
        await retireButtons(chatId, messageId, null);
        return { handled: true, outcome: "ALREADY_DECIDED" };
      }

      const settled = result.status === "APPROVED" || result.status === "REJECTED";
      const text =
        decision === "APPROVED"
          ? settled
            ? `Approved. The shift now applies to ${result.attendance_date} and that date has been recalculated.`
            : "Approved, and passed to the next approver in the web app."
          : "Rejected. The employee's normal shift stands for that date.";

      await answer(decision === "APPROVED" ? "Approved" : "Rejected");
      await retireButtons(chatId, messageId, text);
      return { handled: true, outcome: result.status };
    } catch (err) {
      // A refusal the approver should read - not their request to decide, a
      // locked payroll month - versus something actually broken.
      const speakable = err && (err.name === "ForbiddenError" || err.name === "ValidationError");
      if (speakable) {
        await answer(err.message);
      } else {
        log("DECIDE", err, { request_id: requestId });
        await answer("That could not be recorded. Please use the web app.");
      }
      return { handled: true, outcome: speakable ? "REFUSED" : "ERROR" };
    }
  };

  return {
    CALLBACK_PREFIX,
    REJECT_PROMPT,
    updateTypes: ["callback_query", "message"],
    /**
     * The dispatcher's claim predicate. It claims a `callback_query` of its
     * own shape and a reply to its own prompt, and nothing else - so the
     * password-reset branch and the employee link handler go on seeing every
     * message this one is not about.
     */
    claims: (update) =>
      Boolean(
        (update && update.callback_query && /^sc:\d+:[AR]$/.test(String(update.callback_query.data || ""))) ||
          claimsRejectReply(update)
      ),
    handle: async (update) => {
      if (update && update.callback_query) return handleCallback(update);
      if (claimsRejectReply(update)) return handleRejectReply(update);
      return { handled: false };
    },
    notifyFirstApprover,
    composeMessage,
    keyboardFor,
    minutesAsHours,
  };
};
