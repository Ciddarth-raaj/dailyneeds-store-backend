const logger = require("../utils/logger");

/**
 * OT APPROVAL ON TELEGRAM - the same OT record DnDS decides, from a chat.
 *
 * ================================================ NOBODY REQUESTS OT ======
 *
 * Employees do not ask for overtime any more. The attendance engine finds
 * eligible OT on a closed day and `attendance_regularization#syncAutoOt`
 * raises the date's PENDING OT request on its own. This module only puts
 * that request in front of an approver and carries their decision back.
 *
 * ================================= THE SAME RECORD, FROM EITHER SURFACE ====
 *
 * There is no Telegram OT table and no Telegram OT status. Both buttons call
 * `attendance_regularization#decide` with `source: "TELEGRAM"`, so the
 * authority check (`canApprove`: the employee's chain, the Store Manager's
 * outlet), the payroll lock, the open-day rule and the one-stage-at-a-time
 * transaction are DnDS's own. A decision taken here is on the record DnDS
 * reads the moment it commits, and the reverse.
 *
 * ================================================== THE STALE BUTTON ======
 *
 *   already decided (DnDS, another tap, the payroll lock, the system
 *   withdrawing its own OT)       -> "already processed", buttons removed.
 *   the minutes moved since this message was sent (an attendance
 *   correction)                   -> nothing is decided; the approver is
 *                                    told the new figure and sent a fresh
 *                                    message. The Approve button CARRIES the
 *                                    minutes it showed, and `decide` refuses
 *                                    a different figure.
 *   two taps racing               -> `decideStage`'s guarded UPDATEs let one
 *                                    win; the other is answered as already
 *                                    processed.
 *
 * ============================================== WHO IS MESSAGED, WHEN ====
 *
 * The rule the shift request already follows: when the system raises an OT
 * request, ONLY ITS FIRST APPROVER is messaged, and only when the employee's
 * chain names a person (Attendance Approver Setup). A role chain names a
 * stage, not a person, so nobody is messaged - and any approver, on any
 * chain and at any stage, can send `/ot` to the bot to list the pending OT
 * they may decide now, each with the same buttons.
 *
 * REJECTION ASKS FOR A REASON, as every rejection does, with a force-reply
 * matched back by the `#id` in the prompt - no state held in this process.
 */

const CALLBACK_PREFIX = "ot";
const CALLBACK_PATTERN = /^ot:(\d+):(A|R)(?::(\d+))?$/;
const COMMAND_PATTERN = /^\/(ot|pendingot)(@\w+)?\s*$/i;

const REJECT_PROMPT = (requestId) =>
  `Reject OT request #${requestId}\n\nReply to this message with the reason. It is recorded on the request and shown to the employee.`;
const REJECT_PROMPT_PATTERN = /Reject OT request #(\d+)/;

const LIST_LIMIT = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-06" -> "06 Oct 2026". */
const displayDate = (date) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(date || "-");
};
const minutesAsHours = (minutes) => {
  const m = Math.max(0, Math.trunc(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

module.exports = ({ regularizationUsecase, employeeTelegramRepo, telegram, webBaseUrl = null } = {}) => {
  const configured = () =>
    Boolean(telegram && typeof telegram.isConfigured === "function" && telegram.isConfigured());

  const log = (code, err, ref = {}) =>
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.OT_TELEGRAM",
      code: `USECASE.OT_TELEGRAM.${code}`,
      description: err && err.toString ? err.toString() : String(err),
      category: "",
      ref,
    });

  /** PLAIN TEXT, no parse mode: names and outlets may contain `_` or `*`. */
  const composeMessage = (ctx) => {
    const shift =
      ctx.shift_in_time && ctx.shift_out_time ? `${ctx.shift_in_time} - ${ctx.shift_out_time}` : ctx.shift_code || "-";
    const lines = [
      "OT Approval Pending",
      "",
      `Employee: ${ctx.employee_id} - ${ctx.employee_name || "-"}`,
    ];
    if (ctx.outlet_name) lines.push(`Outlet: ${ctx.outlet_name}`);
    lines.push(`Date: ${displayDate(ctx.attendance_date)}`, `Shift: ${shift}`);
    if (ctx.punch_in) lines.push(`Punch In: ${ctx.punch_in}`);
    lines.push(`Punch Out: ${ctx.punch_out || "-"}`);
    if (ctx.worked_minutes !== null && ctx.worked_minutes !== undefined) {
      lines.push(`Worked: ${minutesAsHours(ctx.worked_minutes)}`);
    }
    lines.push(`Eligible OT: ${Math.max(0, Math.trunc(Number(ctx.eligible_ot_minutes) || 0))} min`, "", `Request #${ctx.attendance_approval_request_id}`);
    return lines.join("\n");
  };

  const keyboardFor = (requestId, minutes) => {
    const buttons = [
      [
        { text: "Approve", callback_data: `${CALLBACK_PREFIX}:${requestId}:A:${Math.max(0, Math.trunc(Number(minutes) || 0))}` },
        { text: "Reject", callback_data: `${CALLBACK_PREFIX}:${requestId}:R` },
      ],
    ];
    if (webBaseUrl) {
      buttons.push([
        { text: "View", url: `${String(webBaseUrl).replace(/\/$/, "")}/attendance/approval?type=OT&request=${requestId}` },
      ]);
    }
    return { inline_keyboard: buttons };
  };

  const sendCard = (chatId, ctx) =>
    telegram.sendMessage(chatId, composeMessage(ctx), {
      parseMode: null,
      replyMarkup: keyboardFor(ctx.attendance_approval_request_id, ctx.eligible_ot_minutes),
    });

  /**
   * Message the FIRST approver of a newly raised OT, when the chain names one.
   * Never throws: the OT request exists either way, and is in the DnDS queue.
   */
  const notifyFirstApprover = async (ctx) => {
    if (!configured()) return { sent: false, reason: "TELEGRAM_NOT_CONFIGURED" };
    const chain = Array.isArray(ctx.chain) ? ctx.chain : [];
    const first = chain.find((step) => Number(step.stage_no) === 1) || null;
    const approverId = first && first.approver_employee_id ? Number(first.approver_employee_id) : null;
    if (!approverId) return { sent: false, reason: "FIRST_APPROVER_IS_A_ROLE" };
    try {
      const identity = await employeeTelegramRepo.getActiveIdentityByEmployee(approverId);
      const chatId = identity && identity.private_chat_id ? identity.private_chat_id : null;
      if (!chatId) return { sent: false, reason: "APPROVER_HAS_NO_TELEGRAM", approver_employee_id: approverId };
      const sent = await sendCard(chatId, ctx);
      return { sent: true, approver_employee_id: approverId, chat_id: chatId, message_id: sent && sent.message_id ? sent.message_id : null };
    } catch (err) {
      log("NOTIFY-FIRST-APPROVER", err, { request_id: ctx.attendance_approval_request_id });
      return { sent: false, reason: "SEND_FAILED" };
    }
  };

  /**
   * THE BACKLOG SUMMARY - one message per approver for the deploy backfill,
   * instead of one card per employee and date. The OT records stay
   * individual; this only tells the approver they exist and how to reach
   * them (`/ot` here, or DnDS). Never throws.
   */
  const notifyBacklogSummary = async ({ approver_employee_id, count, from_date = null, to_date = null }) => {
    if (!configured()) return { sent: false, reason: "TELEGRAM_NOT_CONFIGURED" };
    const approverId = Number(approver_employee_id);
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    if (!approverId || n === 0) return { sent: false, reason: "NOTHING_TO_SAY" };
    try {
      const identity = await employeeTelegramRepo.getActiveIdentityByEmployee(approverId);
      const chatId = identity && identity.private_chat_id ? identity.private_chat_id : null;
      if (!chatId) return { sent: false, reason: "APPROVER_HAS_NO_TELEGRAM", approver_employee_id: approverId };
      const span = from_date && to_date ? ` (${displayDate(from_date)} - ${displayDate(to_date)})` : "";
      const text = [
        `${n} OT approval${n === 1 ? "" : "s"} pending from previous days${span}.`,
        "",
        "Send /ot to review them here, or open the OT approvals in DnDS.",
      ].join("\n");
      const options = { parseMode: null };
      if (webBaseUrl) {
        options.replyMarkup = {
          inline_keyboard: [[{ text: "Open in DnDS", url: `${String(webBaseUrl).replace(/\/$/, "")}/attendance/approval?type=OT` }]],
        };
      }
      const sent = await telegram.sendMessage(chatId, text, options);
      return { sent: true, approver_employee_id: approverId, chat_id: chatId, count: n, message_id: sent && sent.message_id ? sent.message_id : null };
    } catch (err) {
      log("NOTIFY-BACKLOG-SUMMARY", err, { approver_employee_id: approverId });
      return { sent: false, reason: "SEND_FAILED" };
    }
  };

  /** The Telegram user behind a tap, as an employee - the existing link, nothing new. */
  const actorFor = async (telegramUserId) => {
    if (!telegramUserId) return null;
    const identity = await employeeTelegramRepo.getActiveIdentityByTelegramUser(telegramUserId);
    if (!identity || !identity.employee_id) return null;
    // No `user_type`: a Telegram tap is never an administrator override.
    return { employee_id: Number(identity.employee_id), user_type: null };
  };

  const retireButtons = async (chatId, messageId) => {
    if (!chatId || !messageId) return;
    try {
      await telegram.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    } catch (err) {
      log("RETIRE-BUTTONS", err, { chat_id: chatId, message_id: messageId });
    }
  };

  const say = async (chatId, text) => {
    if (!chatId) return;
    try {
      await telegram.sendMessage(chatId, text, { parseMode: null });
    } catch (err) {
      log("SAY", err, { chat_id: chatId });
    }
  };

  const alreadyText = (result) =>
    result && result.status === "APPROVED"
      ? `Already processed: this OT was approved${
          result.approved_ot_minutes !== null && result.approved_ot_minutes !== undefined
            ? ` (${result.approved_ot_minutes} min)`
            : ""
        }.`
      : result && result.status === "REJECTED"
      ? "Already processed: this OT was rejected."
      : result && result.status === "CANCELLED"
      ? "Already processed: this OT was withdrawn - the date no longer has eligible overtime."
      : "Already processed: this OT has already been actioned.";

  /** The one decision path for both buttons and the reject reply. */
  const decide = async ({ actor, requestId, decision, remarks, expectedMinutes, chatId, messageId, answer }) => {
    try {
      const result = await regularizationUsecase.decide({
        actor,
        request_id: requestId,
        decision,
        remarks,
        source: "TELEGRAM",
        expected_ot_minutes: expectedMinutes === undefined ? null : expectedMinutes,
        // These buttons decide OT and nothing else.
        require_request_type: "OT",
      });

      if (result && result.code === 409 && result.wrong_type) {
        await answer("This button is not for an OT request.");
        return { handled: true, outcome: "WRONG_TYPE", wrong_type: true };
      }

      // ATTENDANCE CORRECTION FIRST: nothing is decided while the date's
      // attendance is being corrected. The buttons stay - once the OT is
      // re-synced they decide the current figure (a moved one is refused and
      // re-presented by the minutes check above).
      if (result && result.code === 409 && result.waiting_for_correction) {
        await answer(result.msg || "Attendance is being corrected. OT will be recalculated before approval.");
        return { handled: true, outcome: "WAITING_FOR_CORRECTION", waiting_for_correction: true };
      }

      if (result && result.code === 409 && result.ot_minutes_changed) {
        await answer(`OT changed to ${result.candidate_ot_minutes} min - nothing was approved.`);
        await retireButtons(chatId, messageId);
        try {
          const ctx = await regularizationUsecase.otApprovalContext(requestId);
          if (ctx) await sendCard(chatId, ctx);
        } catch (err) {
          log("RESEND-CARD", err, { request_id: requestId });
        }
        return { handled: true, outcome: "OT_MINUTES_CHANGED" };
      }
      if (result && result.code === 409) {
        await answer(result.already_decided ? alreadyText(result) : "Already processed: this OT has already been actioned.");
        await retireButtons(chatId, messageId);
        return { handled: true, outcome: "ALREADY_DECIDED" };
      }

      const final = result.status === "APPROVED" || result.status === "REJECTED";
      const date = displayDate(result.attendance_date);
      // THE PAYROLL MONTH WAS ALREADY LOCKED: say where the money goes, and
      // never imply it was added to the locked month's salary.
      const late = result.late_settlement || null;
      const text =
        decision === "APPROVED"
          ? final && late
            ? `Approved — will be settled in the next eligible payroll as Prior-Month OT: ${late.approved_ot_minutes} min for ${date}, Rs ${late.amount}. The ${displayDate(`${late.source_year}-${String(late.source_month).padStart(2, "0")}-01`).slice(3)} payroll is locked and is not changed.`
            : final
            ? `Approved: ${result.approved_ot_minutes || 0} min OT for ${date}. It will be paid with that month's payroll.`
            : "Approved, and passed to the next approver in DnDS."
          : `Rejected: no OT will be paid for ${date}.`;
      await answer(decision === "APPROVED" ? "Approved" : "Rejected");
      await retireButtons(chatId, messageId);
      await say(chatId, text);
      return { handled: true, outcome: result.status };
    } catch (err) {
      // A refusal the approver should read (not theirs to decide, a locked
      // payroll month, a day still open) versus something actually broken.
      const speakable = err && (err.name === "ForbiddenError" || err.name === "ValidationError");
      if (speakable) {
        await answer(err.message);
      } else {
        log("DECIDE", err, { request_id: requestId });
        await answer("That could not be recorded. Please use DnDS.");
      }
      return { handled: true, outcome: speakable ? "REFUSED" : "ERROR" };
    }
  };

  const handleCallback = async (update) => {
    const query = update.callback_query;
    const match = CALLBACK_PATTERN.exec(String(query.data || ""));
    if (!match) return { handled: false };
    const requestId = Number(match[1]);
    const decision = match[2] === "A" ? "APPROVED" : "REJECTED";
    const expectedMinutes = match[3] === undefined ? null : Number(match[3]);
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

    if (decision === "REJECTED") {
      // Not asked for a reason on a request that is already over.
      const request = await regularizationUsecase.getRequest(requestId);
      if (request && request.status !== "PENDING") {
        await answer(alreadyText({ status: request.status, approved_ot_minutes: request.approved_ot_minutes }));
        await retireButtons(chatId, messageId);
        return { handled: true, outcome: "ALREADY_DECIDED" };
      }
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

    return decide({ actor, requestId, decision, remarks: null, expectedMinutes, chatId, messageId, answer });
  };

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
    const reply = (text) => say(chatId, text);

    if (reason.length < 5) {
      await reply("A rejection reason of at least 5 characters is required. Tap Reject again to retry.");
      return { handled: true, outcome: "REASON_TOO_SHORT" };
    }
    const actor = await actorFor(message.from ? message.from.id : null);
    if (!actor) {
      await reply("This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }
    return decide({ actor, requestId, decision: "REJECTED", remarks: reason, chatId, messageId: null, answer: reply });
  };

  /** A private `/ot`: the pending OT this approver may decide now, as cards. */
  const claimsCommand = (update) => {
    const message = update && update.message;
    return Boolean(
      message &&
        message.chat &&
        message.chat.type === "private" &&
        typeof message.text === "string" &&
        COMMAND_PATTERN.test(message.text.trim())
    );
  };

  const handleCommand = async (update) => {
    const message = update.message;
    const chatId = message.chat.id;
    const actor = await actorFor(message.from ? message.from.id : null);
    if (!actor) {
      await say(chatId, "This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }
    try {
      const { rows, total } = await regularizationUsecase.listApprovals({
        actor,
        request_type: "OT",
        status: "PENDING",
        limit: LIST_LIMIT,
      });
      const mine = (rows || []).filter((row) => row.actionable);
      if (mine.length === 0) {
        await say(chatId, "No OT is waiting for your approval.");
        return { handled: true, outcome: "NONE_PENDING" };
      }
      await say(
        chatId,
        total > mine.length
          ? `${total} OT approvals are pending; here are ${mine.length}. Decide these, then send /ot again for the next.`
          : `${mine.length} OT approval(s) pending.`
      );
      for (const row of mine) {
        /* eslint-disable no-await-in-loop */
        const punches = Array.isArray(row.effective_punches) ? row.effective_punches : [];
        const clock = (p) => (p && p.io_time ? String(p.io_time).slice(11, 16) : null);
        await sendCard(chatId, {
          attendance_approval_request_id: row.attendance_approval_request_id,
          employee_id: row.employee_id,
          employee_name: row.employee_name,
          outlet_name: row.outlet_name,
          attendance_date: row.attendance_date,
          shift_code: row.shift_code,
          shift_in_time: row.shift_in_time ? String(row.shift_in_time).slice(0, 5) : null,
          shift_out_time: row.shift_out_time ? String(row.shift_out_time).slice(0, 5) : null,
          punch_in: punches.length > 0 ? clock(punches[0]) : null,
          punch_out: punches.length > 1 ? clock(punches[punches.length - 1]) : null,
          worked_minutes: row.worked_minutes,
          // The figure an approval would be clamped to, and the one the
          // button carries - `decide` refuses it if the record has moved.
          eligible_ot_minutes: row.claimed_ot_minutes,
        });
        /* eslint-enable no-await-in-loop */
      }
      return { handled: true, outcome: "LISTED", count: mine.length };
    } catch (err) {
      log("LIST", err, { employee_id: actor.employee_id });
      await say(chatId, "The pending OT list could not be loaded. Please use DnDS.");
      return { handled: true, outcome: "ERROR" };
    }
  };

  return {
    CALLBACK_PREFIX,
    REJECT_PROMPT,
    updateTypes: ["callback_query", "message"],
    /** Claims its own callbacks, its own reject prompt's replies, and `/ot`. Nothing else. */
    claims: (update) =>
      Boolean(
        (update && update.callback_query && CALLBACK_PATTERN.test(String(update.callback_query.data || ""))) ||
          claimsRejectReply(update) ||
          claimsCommand(update)
      ),
    handle: async (update) => {
      if (update && update.callback_query) return handleCallback(update);
      if (claimsRejectReply(update)) return handleRejectReply(update);
      if (claimsCommand(update)) return handleCommand(update);
      return { handled: false };
    },
    notifyFirstApprover,
    notifyBacklogSummary,
    composeMessage,
    keyboardFor,
    displayDate,
  };
};
