/**
 * Device command queue - the pure part. No I/O; Node 14 syntax only.
 *
 * The receiver may hand a device exactly one kind of command, GET_LOG_DATA
 * ("send me the punches between begin_time and end_time"). Everything that
 * could change or erase state on a terminal is refused here BY NAME and
 * cannot be stored either (biomax_device_command.cmd_code is a one-value
 * ENUM). This module decides what a valid command is, mints transaction
 * ids, and works out how a send_cmd_result relates to what was asked; the
 * store persists, the receiver talks HTTP.
 *
 * WHAT IS NOT KNOWN (docs/biomax-historical-pull.md, section "Unknowns"):
 * the exact reply headers/body a BM70W expects for a command, the header
 * names it uses on send_cmd_result, its cmd_return_code vocabulary, and the
 * FKDataHS102 record layout of a historical block. Nothing below guesses
 * the record layout. The reply shape is a documented ASSUMPTION that is
 * only ever exercised by the fake device until a capture proves it.
 */

const crypto = require("crypto");

const CMD_GET_LOG_DATA = "GET_LOG_DATA";

/** The only command this system will ever queue. */
const ALLOWED_COMMANDS = [CMD_GET_LOG_DATA];

/**
 * Refused explicitly and forever from this code path. Listed so a future
 * "just add the command" change has to delete a line that says why not.
 */
const FORBIDDEN_COMMANDS = [
  "CLEAR_LOG_DATA", // erases the terminal's punch log
  "CLEAR_ENROLL_DATA", // erases enrolled faces/fingers
  "DELETE_USER", // removes a person from the terminal
  "RESET_FK", // factory reset
  "SET_WEB_SERVER_INFO", // repoints the terminal away from DigiSME
];

/**
 * PENDING  queued, never handed out
 * SENT     handed out; a delivery lease is running (see store.claimPendingCommand)
 * ANSWERED at least one MATCHED result block arrived - never re-sent
 * FAILED   reserved; nothing sets it until the return-code vocabulary is known
 */
const COMMAND_STATUS = { PENDING: "PENDING", SENT: "SENT", ANSWERED: "ANSWERED", FAILED: "FAILED" };

const PULL_STATUS = {
  REQUESTED: "REQUESTED",
  WAITING_DEVICE: "WAITING_DEVICE",
  RECEIVING: "RECEIVING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};
const ACTIVE_PULL_STATUSES = [PULL_STATUS.REQUESTED, PULL_STATUS.WAITING_DEVICE, PULL_STATUS.RECEIVING];

const MATCH = { MATCHED: "MATCHED", UNKNOWN_TRANS_ID: "UNKNOWN_TRANS_ID", WRONG_DEVICE: "WRONG_DEVICE" };

/**
 * cmd_return_code: the device's vocabulary has NOT been captured, so this
 * module deliberately has no notion of which values mean success or
 * failure. The receiver records the value verbatim on every block and
 * infers nothing from it; FAILED semantics arrive with a real capture.
 */

const DEVID_RE = /^[A-Za-z0-9]{6,32}$/;
const TIME14_RE = /^\d{14}$/;
const TRANS_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

class CommandRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandRefused";
  }
}

/** Refuse anything but GET_LOG_DATA, naming the dangerous ones. */
function assertAllowedCommand(cmdCode) {
  const code = String(cmdCode === undefined || cmdCode === null ? "" : cmdCode).trim().toUpperCase();
  if (FORBIDDEN_COMMANDS.indexOf(code) !== -1) {
    throw new CommandRefused(`${code} is a destructive or routing command and is never issued by this system`);
  }
  if (ALLOWED_COMMANDS.indexOf(code) === -1) {
    throw new CommandRefused(`unsupported command ${JSON.stringify(cmdCode)}; only ${ALLOWED_COMMANDS.join(", ")} may be queued`);
  }
  return code;
}

/**
 * A transaction id that is unique, opaque, and safe in an HTTP header:
 * `HP` + 14-digit UTC stamp + 10 hex chars from a CSPRNG. 26 characters.
 * Whether the device echoes long ids faithfully is one of the unknowns; the
 * fake device echoes it verbatim.
 */
function newTransId(now) {
  const d = now ? new Date(now) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `HP${stamp}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

/** 'YYYY-MM-DD HH:MM:SS' -> 'YYYYMMDDHHMMSS' (the device's own format). */
function toDeviceTime(dateTime) {
  const digits = String(dateTime || "").replace(/[^0-9]/g, "");
  if (!TIME14_RE.test(digits)) throw new CommandRefused(`not a YYYY-MM-DD HH:MM:SS datetime: ${JSON.stringify(dateTime)}`);
  return digits;
}

/**
 * Build the queue row for a GET_LOG_DATA command. Pure validation; the
 * caller persists it in the same transaction as the pull request.
 */
function buildGetLogDataCommand({ trans_id, dev_id, begin_time, end_time, cmd_code }) {
  const code = assertAllowedCommand(cmd_code === undefined ? CMD_GET_LOG_DATA : cmd_code);
  if (!DEVID_RE.test(String(dev_id || ""))) throw new CommandRefused("dev_id must be 6-32 alphanumerics");
  if (!TRANS_ID_RE.test(String(trans_id || ""))) throw new CommandRefused("trans_id must be 8-40 URL-safe characters");
  const begin = toDeviceTime(begin_time);
  const end = toDeviceTime(end_time);
  if (begin > end) throw new CommandRefused("begin_time must not be after end_time");
  return {
    trans_id: String(trans_id),
    dev_id: String(dev_id),
    cmd_code: code,
    begin_time: begin,
    end_time: end,
    status: COMMAND_STATUS.PENDING,
  };
}

/**
 * How a send_cmd_result relates to what was issued.
 *
 * @param {{dev_id: string, trans_id: string|null}} envelope from the request
 * @param {{dev_id: string, biomax_historical_pull_id: number}|null} command
 *        the queued command with that trans_id, if any
 */
function matchResult(envelope, command) {
  if (!command) return MATCH.UNKNOWN_TRANS_ID;
  if (String(command.dev_id) !== String(envelope.dev_id)) return MATCH.WRONG_DEVICE;
  return MATCH.MATCHED;
}

module.exports = {
  CMD_GET_LOG_DATA,
  ALLOWED_COMMANDS,
  FORBIDDEN_COMMANDS,
  COMMAND_STATUS,
  PULL_STATUS,
  ACTIVE_PULL_STATUSES,
  MATCH,
  CommandRefused,
  assertAllowedCommand,
  newTransId,
  toDeviceTime,
  buildGetLogDataCommand,
  matchResult,
};
