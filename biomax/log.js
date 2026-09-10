/**
 * Structured logging for the receiver: one JSON line per request.
 *
 * Built on utils/logger.js (winston, JSON, stdout - pm2 captures it) so the
 * receiver's lines look like the API's. Two levels only: `info` for every
 * request and `error` for anything an operator must see. `utils/logger.js`
 * maps WARN to the non-standard string "warning", which winston's default
 * levels drop, so warnings are logged at `info` with an explicit `outcome`
 * rather than relying on that level.
 *
 * Fields on every request line: dev_id, request_code, outcome, source_ip,
 * bytes, duration_ms; plus user_id / io_time_raw / derivation_status for
 * punches, and `error` when there was one.
 */

const logger = require("../utils/logger");

const COMPONENT = "BIOMAX.RECEIVER";

function createLog(options = {}) {
  const sink = options.sink || logger;

  function emit(level, code, description, ref) {
    sink.Log({
      level,
      component: COMPONENT,
      code: `${COMPONENT}.${code}`,
      description,
      category: "",
      ref: ref || {},
    });
  }

  return {
    request: (fields) =>
      emit(
        fields.error ? logger.LEVEL.ERROR : logger.LEVEL.INFO,
        String(fields.outcome || "unknown").toUpperCase(),
        `${fields.request_code || "-"} from ${fields.dev_id || "-"} -> ${fields.outcome}`,
        fields
      ),
    error: (code, description, ref) => emit(logger.LEVEL.ERROR, code, description, ref),
    info: (code, description, ref) => emit(logger.LEVEL.INFO, code, description, ref),
  };
}

module.exports = { createLog, COMPONENT };
