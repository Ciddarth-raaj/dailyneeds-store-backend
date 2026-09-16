const logger = require("../utils/logger");

/**
 * THE TELEGRAM UPDATE DISPATCHER - one update stream, several isolated handlers.
 *
 * ================================= WHY THIS EXISTS =========================
 *
 * `usecase/passwordReset.js#pollTelegramUpdates` is the ONLY caller of
 * `getUpdates` in this codebase, and that is not a style choice: passing the
 * offset back ACKNOWLEDGES every update below it, so a second poller would not
 * "also receive" a message - the two would race and each would swallow updates
 * the other needed. `usecase/telegram_update_ownership.test.js` asserts that
 * invariant against the source.
 *
 * That poller used to hand its messages to exactly ONE observer
 * (`onTelegramMessage`), wired to Telegram group detection. A second feature
 * wanting the stream had nowhere to go. This module is that place: the poller
 * still owns the loop and the offset, and hands each update here to be fanned
 * out.
 *
 * NOT AN EVENT BUS. There is no subscription, no wildcard, no ordering
 * guarantee worth naming, no queue and no retry. Handlers are registered once
 * at wiring time in `server.js` and held in an array. Anything more would be
 * infrastructure nobody asked for.
 *
 * ========================= THE DEEP-LINK CLAIM CONTRACT ====================
 *
 * THIS IS THE PART THAT MATTERS, so it is stated plainly.
 *
 * The poller parses EVERY `/start <payload>` and hands it to the password
 * reset's `completeLink`, which looks the payload up in `telegram_link_tokens`
 * and, ON A MISS, replies "That link has expired or was already used."
 *
 * A future employee-Telegram deep link is also a `/start <payload>`. Without
 * this contract, an employee scanning the employee QR would be processed
 * correctly by the employee handler AND THEN TOLD BY THE PASSWORD-RESET BRANCH
 * THAT THEIR LINK HAD EXPIRED. Two handlers, one update, one of them wrong.
 *
 * So a handler may declare a `claims(update)` PREDICATE. `dispatch` evaluates
 * the predicates FIRST, records the first handler that returns true, and
 * reports it back; the poller skips its own linking branch for a claimed
 * update.
 *
 * CLAIMING IS A PREDICATE AND NOT THE HANDLER'S RETURN VALUE, and that is the
 * whole safety property. If ownership were "the handler returned claimed:true",
 * then a handler that THREW or TIMED OUT would fail to claim, the legacy branch
 * would run, and the employee would get the false expired-link message -
 * exactly in the case where something had already gone wrong. The predicate is
 * pure, synchronous and cheap (a string prefix test), so it holds even when the
 * handler behind it crashes. A claimed-but-failed update is simply dropped for
 * that employee, who scans again; it is NEVER answered with a wrong message.
 *
 * A HANDLER'S RETURN VALUE NEVER IMPLIES OWNERSHIP. Group detection's
 * `handleMessage` returns a detection object - truthy, and meaning nothing of
 * the sort. Ownership is the predicate or it is nothing.
 *
 * ORDERING CANNOT CHANGE OWNERSHIP EITHER. Every claim is decided before any
 * handler runs, so re-ordering `register` calls cannot move the claim between a
 * handler that claims and one that merely observes.
 *
 * ================================= ISOLATION ==============================
 *
 * One handler must never be able to break another, and NOTHING here may break
 * password-reset linking:
 *
 *   - every handler runs in its own try/catch;
 *   - every handler is raced against a timeout, so a hung handler cannot stall
 *     the poll tick (which would leave the poller's re-entrancy guard set and
 *     silently stop linking for everybody);
 *   - a `claims` predicate that throws is treated as NOT CLAIMED and logged;
 *   - `dispatch` itself never throws and always settles;
 *   - the offset has already been advanced by the poller before this is called,
 *     so no handler outcome can affect acknowledgement.
 *
 * JS PROMISES CANNOT BE CANCELLED. A timed-out handler keeps running in the
 * background; we stop WAITING for it and ignore whatever it eventually returns.
 * It cannot retro-actively change the claim outcome or the offset - both are
 * already decided.
 *
 * ============================ WHAT IS NEVER LOGGED ========================
 *
 * Handler name, normalised update type, update id, error string. THAT IS ALL.
 * Never the message text, never the `/start` payload or any token, never
 * `message.contact` (a phone number, a name, a Telegram user id), never the
 * chat title and never the sender. The poller already refuses to log a link
 * token and `services/telegram.js` refuses to log message bodies; this is the
 * same discipline, and `telegram_update_dispatcher.test.js` greps this file to
 * keep it.
 */

/** How long one handler may take before the dispatcher stops waiting for it. */
const DEFAULT_HANDLER_TIMEOUT_MS = 5000;

/**
 * Deep-link `/start` payload namespaces.
 *
 * RESERVED IN PHASE 1, USED BY NOBODY. There is no issuer and no consumer of
 * EMPLOYEE_LINK yet; it is here so the Phase 2 handler adds a claim predicate
 * rather than a change to the poller's control flow.
 *
 * PASSWORD_RESET IS THE EMPTY PREFIX because that is what production already
 * issues: `crypto.randomBytes(24).toString("hex")`, 48 bare hex characters that
 * can never carry a prefix. So a namespaced token is unambiguous and no
 * existing token has to be migrated or re-issued.
 */
const DEEP_LINK_NAMESPACES = Object.freeze({
  PASSWORD_RESET: "",
  EMPLOYEE_LINK: "e_",
});

/**
 * Update types this dispatcher knows how to route, and the property each one
 * arrives on.
 *
 * BOTH SPELLINGS, DELIBERATELY. Telegram's Bot API names these in snake_case,
 * but `messaging-api-telegram` camelCases what it hands back - production
 * already depends on that, reading `update.updateId` rather than
 * `update.update_id`. Which layer renamed what is not something a handler
 * author should have to remember, so the alias table accepts either and
 * handlers always register against the SNAKE_CASE BOT API NAME, which is the
 * name in Telegram's documentation.
 *
 * `chat_member` and `my_chat_member` are listed but NOT enabled in
 * `services/telegram.js#getUpdates`: routing them costs nothing, and Telegram
 * sends none of them until they are named in `allowed_updates`.
 */
const UPDATE_TYPE_ALIASES = Object.freeze({
  message: ["message"],
  chat_join_request: ["chatJoinRequest", "chat_join_request"],
  chat_member: ["chatMember", "chat_member"],
  my_chat_member: ["myChatMember", "my_chat_member"],
});

/** The order types are tested in. One update carries exactly one of them. */
const UPDATE_TYPES = Object.keys(UPDATE_TYPE_ALIASES);

/**
 * Which kind of update this is, by the Bot API's own name for it.
 *
 * Returns null for an update carrying none of them - including `null`, `{}` and
 * anything malformed. A null type reaches no handler at all, which is why a
 * handler never has to defend against a missing payload.
 */
function updateType(update) {
  if (!update || typeof update !== "object") return null;
  for (const type of UPDATE_TYPES) {
    for (const alias of UPDATE_TYPE_ALIASES[type]) {
      const value = update[alias];
      if (value !== undefined && value !== null) return type;
    }
  }
  return null;
}

/** The payload of a typed update, whichever spelling it arrived under. */
function updatePayload(update, type) {
  if (!update || !type) return null;
  for (const alias of UPDATE_TYPE_ALIASES[type] || []) {
    const value = update[alias];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/** The only identifier safe to log: a number Telegram assigned, naming nobody. */
function updateId(update) {
  const id = update && (update.updateId !== undefined ? update.updateId : update.update_id);
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

class TelegramUpdateDispatcher {
  constructor({ timeoutMs = DEFAULT_HANDLER_TIMEOUT_MS, log = logger } = {}) {
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_HANDLER_TIMEOUT_MS;
    this.log = log;
    /** @type {{name:string, updateTypes:string[], claims:Function, handle:Function}[]} */
    this.handlers = [];
  }

  _log(code, description, ref = {}, level) {
    try {
      this.log.Log({
        level: level || this.log.LEVEL.ERROR,
        component: "USECASE.TELEGRAM_DISPATCHER",
        code: `USECASE.TELEGRAM_DISPATCHER.${code}`,
        description,
        category: "",
        ref,
      });
    } catch (err) {
      // A broken logger must not be able to stop an update being handled.
    }
  }

  /**
   * Add a handler. Called once per feature at wiring time, never at runtime.
   *
   * @param {object} handler
   * @param {string} handler.name        for logs. NOT an identity - nothing looks it up.
   * @param {string[]} handler.updateTypes  Bot API names: "message", "chat_join_request", ...
   * @param {function} [handler.claims]  PURE and SYNCHRONOUS. True means "this update
   *                                     is mine, and the poller's own `/start` branch
   *                                     must not also answer it". Defaults to never.
   * @param {function} handler.handle    receives the WHOLE update. May be async. Its
   *                                     RETURN VALUE MEANS NOTHING - see the header.
   */
  register({ name, updateTypes, claims, handle } = {}) {
    if (typeof handle !== "function") {
      throw new Error("a Telegram update handler needs a handle function");
    }
    const types = Array.isArray(updateTypes) ? updateTypes.filter((t) => UPDATE_TYPES.includes(t)) : [];
    if (types.length === 0) {
      throw new Error(
        `a Telegram update handler needs at least one known update type (${UPDATE_TYPES.join(", ")})`
      );
    }
    this.handlers.push({
      name: String(name || "unnamed"),
      updateTypes: types,
      // No predicate means this handler OBSERVES and never owns, which is what
      // every Phase 1 handler does.
      claims: typeof claims === "function" ? claims : () => false,
      handle,
    });
    return this;
  }

  /** Handlers registered for this update's type, in registration order. */
  _handlersFor(type) {
    return this.handlers.filter((h) => h.updateTypes.includes(type));
  }

  /**
   * Who owns this update - decided BEFORE any handler runs, and never changed
   * by one. A predicate that throws is a predicate that did not claim.
   */
  _resolveClaim(update, handlers, ref) {
    let claimedBy = null;
    for (const handler of handlers) {
      let claimed = false;
      try {
        claimed = handler.claims(update) === true;
      } catch (err) {
        this._log("CLAIM-PREDICATE", err.toString(), { ...ref, handler: handler.name });
        claimed = false;
      }
      if (!claimed) continue;
      if (claimedBy === null) {
        claimedBy = handler.name;
        continue;
      }
      // Two owners is a wiring mistake somebody has to fix; the first still
      // wins so the behaviour is at least deterministic while they do.
      this._log("CLAIM-CONFLICT", `${claimedBy} already claimed this update`, {
        ...ref,
        handler: handler.name,
        claimed_by: claimedBy,
      });
    }
    return claimedBy;
  }

  /** One handler, isolated: it cannot throw at us and it cannot hang us. */
  async _runHandler(handler, update, ref) {
    let timer = null;
    try {
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`handler timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      });
      // Promise.resolve(): a handler that throws SYNCHRONOUSLY is caught here
      // too, not only one that rejects.
      await Promise.race([Promise.resolve().then(() => handler.handle(update)), timeout]);
      return true;
    } catch (err) {
      this._log("HANDLER", err.toString(), { ...ref, handler: handler.name });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fan one update out. NEVER THROWS, always settles.
   *
   * @returns {Promise<{claimed:boolean, claimedBy:(string|null), type:(string|null),
   *                    delivered:number, failed:number}>}
   */
  async dispatch(update) {
    const type = updateType(update);
    const ref = { update_id: updateId(update), type };

    if (!type) {
      return { claimed: false, claimedBy: null, type: null, delivered: 0, failed: 0 };
    }

    const handlers = this._handlersFor(type);
    if (handlers.length === 0) {
      this._log("NO-HANDLER", `no handler registered for ${type}`, ref, this.log.LEVEL.DEBUG);
      return { claimed: false, claimedBy: null, type, delivered: 0, failed: 0 };
    }

    // OWNERSHIP FIRST, AND ONCE. Everything below can fail without changing it.
    const claimedBy = this._resolveClaim(update, handlers, ref);

    let delivered = 0;
    let failed = 0;
    for (const handler of handlers) {
      // Sequential on purpose: a handful of handlers, each capped by the
      // timeout, and a predictable order is easier to reason about than a
      // Promise.all whose rejections have to be re-collected.
      if (await this._runHandler(handler, update, ref)) delivered += 1;
      else failed += 1;
    }

    return { claimed: claimedBy !== null, claimedBy, type, delivered, failed };
  }
}

module.exports = (deps) => new TelegramUpdateDispatcher(deps);
module.exports.TelegramUpdateDispatcher = TelegramUpdateDispatcher;
module.exports.updateType = updateType;
module.exports.updatePayload = updatePayload;
module.exports.UPDATE_TYPES = UPDATE_TYPES;
module.exports.UPDATE_TYPE_ALIASES = UPDATE_TYPE_ALIASES;
module.exports.DEEP_LINK_NAMESPACES = DEEP_LINK_NAMESPACES;
module.exports.DEFAULT_HANDLER_TIMEOUT_MS = DEFAULT_HANDLER_TIMEOUT_MS;
