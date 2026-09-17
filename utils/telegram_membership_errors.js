/**
 * THE ONE ERROR THE WORKER IS MEANT TO SEE. Phase 3C.
 *
 * Reconciliation swallows nothing that matters. When cleanup was REQUIRED and
 * Telegram would not do it - it did not answer, the bot lacks the right, the
 * ban was refused - that has to reach the queue, because the queue is what
 * retries and what eventually gives up loudly into the dead-letter list.
 *
 * An earlier revision returned those cases as ordinary result fields, and the
 * worker completed the job as SUCCEEDED: the claim sat in REMOVAL_PENDING
 * forever, the queue said everything was fine, and the only way to find out
 * was to notice somebody still in a group months later.
 *
 * `retryAfter` carries Telegram's own `retry_after` through unchanged, so a
 * 429 reaches the delay path instead of spending a retry on work Telegram
 * never let us attempt.
 */
class TelegramMembershipRetryableError extends Error {
  constructor(message, { code = "TELEGRAM_REMOVAL_FAILED", retryAfter = null, cause = null } = {}) {
    super(message);
    this.name = "TelegramMembershipRetryableError";
    this.code = code;
    this.retryable = true;
    if (retryAfter) this.retryAfter = retryAfter;
    // Kept so the worker's existing 429 detection, which reads Telegram's own
    // shapes, still sees what it is looking for.
    if (cause) {
      this.cause = cause;
      if (cause.parameters) this.parameters = cause.parameters;
      if (cause.telegramDescription) this.telegramDescription = cause.telegramDescription;
    }
  }
}

/** Telegram's `retry_after`, in seconds, from any shape it arrives in. */
function retryAfterOf(err) {
  if (!err) return null;
  const parameters = err.parameters || (err.response && err.response.parameters);
  if (parameters && parameters.retry_after) return Number(parameters.retry_after);
  if (err.retryAfter) return Number(err.retryAfter);
  const description = String(err.telegramDescription || err.message || "");
  const match = description.match(/Too Many Requests[^0-9]*(\d+)/i);
  return match ? Number(match[1]) : null;
}

module.exports = { TelegramMembershipRetryableError, retryAfterOf };
