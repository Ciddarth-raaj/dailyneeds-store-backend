const logger = require("../utils/logger");
const { callbackQueryOf, replyToOf, messageIdOf } = require("../utils/telegram_update");

/**
 * ADVANCE REQUEST APPROVAL (A2) ON TELEGRAM.
 *
 * ============================================== WHO IS MESSAGED, WHEN ====
 *
 * When a request reaches "Awaiting Approval" - accounts found no balance, or
 * purchase decided what to do about one - ONE card is posted to the group(s)
 * registered in Master -> Telegram Groups whose "Used For" contains
 * "Urgent payments" or "Advance Request" (the same way the Pick Pack Daily Report finds its
 * groups). Nobody is messaged privately.
 *
 * Anyone in the group can see the card; ONLY AN ADMIN can act on it - a
 * member whose Telegram is linked to an employee with an active Admin login
 * (user_type 2). A designation holding `approve_advance_request` is enough
 * in the web app but not here. Everyone else's tap or reply is refused and
 * changes nothing.
 *
 * ================================= THE SAME RECORD, FROM EITHER SURFACE ====
 *
 * There is no Telegram decision path. Every button calls the web app's own
 * `advance_request#approval`, so the status guard and the compare-and-set
 * update are unchanged: a second tap, or a tap after someone decided in the
 * web app, comes back as a ConflictError and is answered kindly.
 *
 * The tapper's authority is checked AT THE TAP, not when the card was sent,
 * so a permission removed in between is honoured.
 *
 * ========================================= HOLD AND REJECT ASK A QUESTION ==
 *
 * Approve is one tap. Hold and Reject ask for a note with a force-reply,
 * matched back by the `#id` in the prompt - no state is held in this process.
 * A held request keeps its card's buttons, so the admin can approve or reject
 * it from the same card later.
 */

const CALLBACK_PREFIX = "ar";

/**
 * The "Used For" words that mark a registered group as the approval group.
 * "Dn Urgent payments" is the group advance approvals go to today; "Advance
 * Request" lets another group be added without a code change.
 */
const GROUP_USED_FOR = ["urgent payment", "advance request"];
const CALLBACK_PATTERN = /^ar:(\d+):([AHR])$/;

const VERB = { A: "approve", H: "hold", R: "reject" };

const PROMPT = (verb, requestId) =>
  `${verb === "hold" ? "Hold" : "Reject"} advance request #${requestId}\n\nReply to this message with the reason. It is recorded on the request.`;
const PROMPT_PATTERN = /^(Hold|Reject) advance request #(\d+)/;

const MIN_NOTE = 3;

/** At most this many cards per status in one "send pending". */
const PENDING_LIMIT = 50;

const BALANCE_ACTION_LABEL = {
  less_and_pay: "Less and pay",
  defer: "Deduct next time",
};

const money = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

module.exports = ({
  advanceRequestUsecase,
  advanceRequestRepo,
  employeeTelegramRepo,
  registryRepo,
  telegram,
  webBaseUrl = null,
} = {}) => {
  const configured = () =>
    Boolean(telegram && typeof telegram.isConfigured === "function" && telegram.isConfigured());

  const log = (code, err, ref = {}) =>
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.ADVANCE_REQUEST_TELEGRAM",
      code: `USECASE.ADVANCE_REQUEST_TELEGRAM.${code}`,
      description: err && err.toString ? err.toString() : String(err),
      category: "",
      ref,
    });

  /** PLAIN TEXT, no parse mode: supplier names and reasons may contain `_` or `*`. */
  const composeMessage = (request) => {
    const lines = [
      request.status === "on_hold" ? "Advance request - ON HOLD, awaiting decision" : "Advance request - approval needed",
      "",
      `Supplier: ${request.supplier_name || "-"}`,
      `Invoice No.: ${request.invoice_number || "-"}`,
      `Amount: ${money(request.amount)}`,
    ];
    if (request.outlet_name) lines.push(`Outlet: ${request.outlet_name}`);
    lines.push(`Requested by: ${request.created_by_name || "-"}`);
    if (request.reason) lines.push(`Reason: ${request.reason}`);

    const balance = Number(request.previous_advance_balance) || 0;
    lines.push("", `Previous balance: ${balance > 0 ? money(balance) : "None"}`);
    if (request.balance_remarks) lines.push(`Accounts remarks: ${request.balance_remarks}`);
    if (request.balance_action) {
      lines.push(`Balance decision: ${BALANCE_ACTION_LABEL[request.balance_action] || request.balance_action}`);
      if (request.balance_action_note) lines.push(`Purchase note: ${request.balance_action_note}`);
    }

    lines.push("", `Request #${request.advance_request_id}`);
    return lines.join("\n");
  };

  const keyboardFor = (requestId) => {
    const buttons = [
      [
        { text: "Approve", callback_data: `${CALLBACK_PREFIX}:${requestId}:A` },
        { text: "Hold", callback_data: `${CALLBACK_PREFIX}:${requestId}:H` },
        { text: "Reject", callback_data: `${CALLBACK_PREFIX}:${requestId}:R` },
      ],
    ];
    if (webBaseUrl) {
      buttons.push([
        { text: "View", url: `${String(webBaseUrl).replace(/\/$/, "")}/advance-request/view/${requestId}` },
      ]);
    }
    return { inline_keyboard: buttons };
  };

  /** Active registered groups whose "Used For" names advance requests. */
  const approvalGroups = async () => {
    const rows = (await registryRepo.getAll({ is_active: true })) || [];
    return rows.filter((g) => {
      const usedFor = String(g.used_for || "").toLowerCase().replace(/\s+/g, " ");
      return g.chat_id && GROUP_USED_FOR.some((words) => usedFor.includes(words));
    });
  };

  /**
   * Post the card to the approval group(s). Never throws: the stage that
   * called this has already committed.
   */
  const notifyApprovers = async (request) => {
    if (!configured()) return { sent: 0, reason: "TELEGRAM_NOT_CONFIGURED" };
    try {
      const groups = registryRepo ? await approvalGroups() : [];
      if (groups.length === 0) {
        log("NO-GROUP", "No active Telegram group has 'Urgent payments' or 'Advance Request' in Used For", {
          request_id: request.advance_request_id,
        });
        return { sent: 0, reason: "NO_APPROVAL_GROUP" };
      }

      const text = composeMessage(request);
      const replyMarkup = keyboardFor(request.advance_request_id);
      let sent = 0;
      for (const group of groups) {
        try {
          await telegram.sendMessage(group.chat_id, text, {
            parseMode: null,
            replyMarkup,
            // An approval is something to act on, so it should ping.
            disableNotification: false,
          });
          sent += 1;
        } catch (err) {
          log("NOTIFY-GROUP", err, { request_id: request.advance_request_id, group: group.group_name });
        }
      }
      return { sent };
    } catch (err) {
      log("NOTIFY-APPROVERS", err, { request_id: request && request.advance_request_id });
      return { sent: 0, reason: "SEND_FAILED" };
    }
  };

  /** The employee behind a Telegram account, and whether they are an admin. */
  const approverFor = async (telegramUserId) => {
    if (!telegramUserId) return { employeeId: null, allowed: false };
    const identity = await employeeTelegramRepo.getActiveIdentityByTelegramUser(telegramUserId);
    if (!identity || !identity.employee_id) return { employeeId: null, allowed: false };
    const employeeId = Number(identity.employee_id);
    return { employeeId, allowed: await advanceRequestRepo.isEmployeeAdmin(employeeId) };
  };

  /** Who tapped, as Telegram shows them - for the group's confirmation line. */
  const nameOf = (from) =>
    from ? [from.first_name || from.firstName, from.last_name || from.lastName].filter(Boolean).join(" ") || from.username || null : null;

  const retireButtons = async (chatId, messageId) => {
    if (!chatId || !messageId) return;
    try {
      await telegram.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    } catch (err) {
      log("RETIRE-BUTTONS", err, { chat_id: chatId, message_id: messageId });
    }
  };

  const say = async (chatId, text) => {
    try {
      await telegram.sendMessage(chatId, text, { parseMode: null });
    } catch (err) {
      log("SAY", err, { chat_id: chatId });
    }
  };

  /** The one decision path for every button and reply. */
  const decide = async ({ employeeId, actorName, requestId, decision, note, chatId, messageId, answer }) => {
    try {
      await advanceRequestUsecase.approval(requestId, { decision, approval_note: note || null }, employeeId);
    } catch (err) {
      if (err && (err.name === "ConflictError" || err.name === "NotFoundError")) {
        await answer("This request has already been actioned.");
        await retireButtons(chatId, messageId);
        return { handled: true, outcome: "ALREADY_DECIDED" };
      }
      log("DECIDE", err, { request_id: requestId });
      await answer("That could not be recorded. Please use the web app.");
      return { handled: true, outcome: "ERROR" };
    }

    const by = actorName ? ` by ${actorName}` : "";
    const why = note ? `\nReason: ${note}` : "";
    const done = {
      approve: `Advance request #${requestId} approved${by}. Accounts can now pay it.`,
      hold: `Advance request #${requestId} put on hold${by}. It can still be approved or rejected from the card.${why}`,
      reject: `Advance request #${requestId} rejected${by}.${why}`,
    };
    await answer(decision === "approve" ? "Approved" : decision === "hold" ? "On hold" : "Rejected");
    // A held request is still waiting for this admin, so its card keeps
    // its buttons; anything else is settled.
    if (decision !== "hold") await retireButtons(chatId, messageId);
    await say(chatId, done[decision]);
    return { handled: true, outcome: decision };
  };

  const handleCallback = async (update) => {
    const query = callbackQueryOf(update);
    const match = CALLBACK_PATTERN.exec(String((query && query.data) || ""));
    if (!match) return { handled: false };

    const requestId = Number(match[1]);
    const decision = VERB[match[2]];
    const chatId = query.message && query.message.chat ? query.message.chat.id : null;
    const messageId = messageIdOf(query.message);

    const answer = async (text) => {
      try {
        await telegram.answerCallbackQuery(query.id, text);
      } catch (err) {
        log("ANSWER-CALLBACK", err, { request_id: requestId });
      }
    };

    const { employeeId, allowed } = await approverFor(query.from ? query.from.id : null);
    if (!employeeId) {
      await answer("This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }
    if (!allowed) {
      await answer("Only an admin can approve advance requests.");
      return { handled: true, outcome: "FORBIDDEN" };
    }

    if (decision !== "approve") {
      await answer("Please reply with the reason.");
      try {
        await telegram.sendMessage(chatId, PROMPT(decision, requestId), {
          parseMode: null,
          // Whoever replies is checked again, so the prompt need not be
          // limited to the person who tapped.
          replyMarkup: { force_reply: true },
          replyToMessageId: messageId || undefined,
        });
      } catch (err) {
        log("PROMPT", err, { request_id: requestId });
      }
      return { handled: true, outcome: "REASON_REQUESTED" };
    }

    return decide({ employeeId, actorName: nameOf(query.from), requestId, decision, note: null, chatId, messageId, answer });
  };

  /** Claimed ONLY when it replies to this module's own prompt. */
  const claimsReply = (update) => {
    const message = update && update.message;
    const repliedTo = replyToOf(message);
    return Boolean(
      message &&
        typeof message.text === "string" &&
        repliedTo &&
        typeof repliedTo.text === "string" &&
        PROMPT_PATTERN.test(repliedTo.text)
    );
  };

  const handleReply = async (update) => {
    const message = update.message;
    const [, verb, id] = PROMPT_PATTERN.exec(replyToOf(message).text);
    const requestId = Number(id);
    const decision = verb === "Hold" ? "hold" : "reject";
    const chatId = message.chat ? message.chat.id : null;
    const note = String(message.text || "").trim();
    const answer = (text) => say(chatId, text);

    if (note.length < MIN_NOTE) {
      await answer(`Please give a reason of at least ${MIN_NOTE} characters. Tap ${verb} again to retry.`);
      return { handled: true, outcome: "REASON_TOO_SHORT" };
    }

    const { employeeId, allowed } = await approverFor(message.from ? message.from.id : null);
    if (!employeeId) {
      await answer("This Telegram account is not linked to an employee.");
      return { handled: true, outcome: "NOT_LINKED" };
    }
    if (!allowed) {
      await answer("Only an admin can approve advance requests.");
      return { handled: true, outcome: "FORBIDDEN" };
    }

    return decide({
      employeeId,
      actorName: nameOf(message.from),
      requestId,
      decision,
      note: note.slice(0, 500),
      chatId,
      messageId: null,
      answer,
    });
  };

  const claimsCallback = (update) => {
    const query = callbackQueryOf(update);
    return Boolean(query && CALLBACK_PATTERN.test(String(query.data || "")));
  };

  /**
   * Post a card for every request already waiting on the admin - Awaiting
   * Approval or On Hold - oldest first. For requests that reached the admin
   * before the card existed, or whose card has scrolled away. Each card is
   * an ordinary card, so a request decided elsewhere meanwhile is answered
   * "already actioned" when tapped.
   */
  const sendPending = async () => {
    if (!configured()) return { requests: 0, sent: 0, reason: "TELEGRAM_NOT_CONFIGURED" };
    const groups = registryRepo ? await approvalGroups() : [];
    if (groups.length === 0) return { requests: 0, sent: 0, reason: "NO_APPROVAL_GROUP" };

    const pending = [];
    for (const status of ["pending_approval", "on_hold"]) {
      const rows = (await advanceRequestRepo.getAll({ status }, PENDING_LIMIT, 0, "created_at", "asc")) || [];
      pending.push(...rows);
    }
    pending.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let sent = 0;
    for (const request of pending) {
      const result = await notifyApprovers(request);
      if (result && result.sent > 0) sent += 1;
    }
    return { requests: pending.length, sent };
  };

  return {
    CALLBACK_PREFIX,
    sendPending,
    GROUP_USED_FOR,
    PROMPT,
    updateTypes: ["callback_query", "message"],
    claims: (update) => claimsCallback(update) || claimsReply(update),
    handle: async (update) => {
      if (claimsCallback(update)) return handleCallback(update);
      if (claimsReply(update)) return handleReply(update);
      return { handled: false };
    },
    notifyApprovers,
    composeMessage,
    keyboardFor,
  };
};
