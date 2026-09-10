/**
 * Historical pull requests - the rules behind "ask device X for its punches
 * between A and B".
 *
 * Creating a request QUEUES a GET_LOG_DATA command; nothing here talks to a
 * device. The receiver hands the command over on the device's own poll, if
 * and only if BIOMAX_COMMANDS_ENABLED is on in that process, which it is
 * not. Reads never include raw block bytes.
 *
 * Validation:
 *   - the device must be registered (a biomax_device row); an inactive
 *     device may still be asked - its history is exactly what one might want
 *   - from <= to; both real datetimes; `to` not in the future
 *   - at most MAX_RANGE_DAYS per request
 *   - no other ACTIVE pull (REQUESTED / WAITING_DEVICE / RECEIVING) on the
 *     same device whose range overlaps this one
 */
const { normaliseDateTime } = require("./biomax_device");
const commands = require("../biomax/commands");

const MAX_RANGE_DAYS = 31;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}
function conflict(message, extra) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.httpCode = 409;
  Object.assign(err, extra || {});
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  err.httpCode = 404;
  return err;
}

/** Local wall-clock 'YYYY-MM-DD HH:MM:SS' (the host runs in IST). */
function localNow(clock) {
  const d = clock ? new Date(clock()) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Whole days between two 'YYYY-MM-DD HH:MM:SS' strings, via UTC integer math. */
function daysBetween(a, b) {
  const ms = (s) => {
    const [d, t] = s.split(" ");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi, se] = t.split(":").map(Number);
    return Date.UTC(y, mo - 1, da, h, mi, se);
  };
  return (ms(b) - ms(a)) / 86400000;
}

class BiomaxHistoricalPullUsecase {
  /**
   * @param {object} repo repository/biomax_historical_pull
   * @param {object} [options]
   * @param {function} [options.clock] () => ms, for tests
   * @param {function} [options.transId] () => string, for tests
   */
  constructor(repo, options = {}) {
    this.repo = repo;
    this.clock = options.clock || null;
    this.transId = options.transId || (() => commands.newTransId());
  }

  list(filters = {}) {
    return this.repo.list({
      dev_id: filters.dev_id ? String(filters.dev_id) : undefined,
      status: filters.status ? String(filters.status) : undefined,
      limit: filters.limit,
    });
  }

  async details(biomax_historical_pull_id) {
    const id = Number(biomax_historical_pull_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("biomax_historical_pull_id must be a positive integer");
    const pull = await this.repo.getById(id);
    if (!pull) throw notFound("Historical pull not found");
    const [command, blocks] = await Promise.all([this.repo.commandFor(id), this.repo.blocksFor(id)]);
    return {
      ...pull,
      command: command
        ? { cmd_code: command.cmd_code, begin_time: command.begin_time, end_time: command.end_time, status: command.status, created_at: command.created_at, sent_at: command.sent_at }
        : null,
      blocks: blocks || [],
      blocks_received: (blocks || []).length,
    };
  }

  /**
   * @param {{biomax_device_id: number, from: string, to: string}} input
   * @param {{employeeId?: number}} actor
   */
  async create(input, actor) {
    const deviceId = Number(input && input.biomax_device_id);
    if (!Number.isSafeInteger(deviceId) || deviceId <= 0) throw validationError("biomax_device_id must be a positive integer");
    const from = normaliseDateTime(input.from, "from");
    // A bare date for `to` means the end of that day, which is what anyone
    // typing a date range means.
    const toRaw = String(input.to === undefined || input.to === null ? "" : input.to).trim();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? `${toRaw} 23:59:59` : normaliseDateTime(toRaw, "to");

    if (from > to) throw validationError("from must not be after to");
    const now = localNow(this.clock);
    if (to > now) throw validationError(`to must not be in the future (server time ${now})`);
    const days = daysBetween(from, to);
    if (days > MAX_RANGE_DAYS) throw validationError(`range is ${Math.ceil(days)} days; at most ${MAX_RANGE_DAYS} days per request`);

    const device = await this.repo.deviceById(deviceId);
    if (!device) throw validationError("device is not registered; register it on the Devices screen first");

    // Everything the command needs is validated by the queue module before
    // any row is written; a forbidden cmd_code cannot get past this line.
    const trans_id = this.transId();
    const command = commands.buildGetLogDataCommand({ trans_id, dev_id: device.dev_id, begin_time: from, end_time: to });

    return this.repo.transaction("CREATE", async (conn) => {
      const overlapping = await this.repo.findActiveOverlapping(device.dev_id, from, to, conn);
      if (overlapping && overlapping.length) {
        const o = overlapping[0];
        throw conflict(
          `an active pull (#${o.biomax_historical_pull_id}, ${o.status}) already covers ${o.requested_from} to ${o.requested_to} on this device`,
          { existing_pull_id: o.biomax_historical_pull_id }
        );
      }
      const pullId = await this.repo.insertPull(conn, {
        biomax_device_id: device.biomax_device_id,
        dev_id: device.dev_id,
        requested_from: from,
        requested_to: to,
        trans_id,
        requested_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
      });
      await this.repo.insertCommand(conn, { biomax_historical_pull_id: pullId, ...command });
      return { code: 200, biomax_historical_pull_id: pullId, trans_id, status: commands.PULL_STATUS.REQUESTED };
    });
  }
}

module.exports = (repo, options) => new BiomaxHistoricalPullUsecase(repo, options);
module.exports.BiomaxHistoricalPullUsecase = BiomaxHistoricalPullUsecase;
module.exports.MAX_RANGE_DAYS = MAX_RANGE_DAYS;
module.exports.localNow = localNow;
