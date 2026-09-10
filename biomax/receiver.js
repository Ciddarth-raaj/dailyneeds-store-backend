/**
 * Biomax BM70W receiver - a standalone, always-on process.
 *
 * Runs as its own pm2 app ("biomax-receiver"), NOT inside server.js, so a
 * deploy or restart of the API never touches it - and even a restart of the
 * receiver itself loses nothing: a request cut mid-flight gets no ACK and
 * the device retransmits it in ~3 minutes (R1). Listens directly on
 * BIOMAX_PORT (7005), not behind nginx, which drops underscore headers such
 * as `request_code` and `dev_id` by default (D2).
 *
 * WHAT IT DOES, per request (rules from docs/biomax-attendance-part1.md):
 *
 *   R10  the `request_code` header alone decides: `realtime_glog` is a
 *        punch; anything else is answered as a poll (`ERROR_NO_CMD` with the
 *        two empty command headers), and an unknown code is also recorded.
 *   R1   a punch is acknowledged `response_code: OK` only after its bytes
 *        are durable - a punch row (new or duplicate) or a raw-request row.
 *        If neither commit succeeds the socket is closed with NO reply, so
 *        the device keeps the punch and retries.
 *   R2   a retransmitted punch is a counter bump on the unique key, still OK.
 *   R5   the employee code is matched numerically but strictly, never to 0.
 *   R18  the attendance date comes from the employee's assigned shift and
 *        the PREVIOUS calendar day's Attendance Day Cutoff, nothing else.
 *   A3   a punch that cannot be dated is stored with a null date and a
 *        status; nothing falls back to the calendar date silently.
 *   D3   an unregistered Cloud ID is stored and ACKed, subject to R13 caps.
 *
 * HISTORICAL PULL SCAFFOLDING (docs/biomax-historical-pull.md):
 *
 *   receive_cmd       when BIOMAX_COMMANDS_ENABLED=1 AND a GET_LOG_DATA is
 *                     queued for THIS dev_id, the poll is answered with that
 *                     command (claimed exactly once). Otherwise, and always
 *                     when the flag is off (the default), ERROR_NO_CMD as
 *                     before. A store error while claiming also falls back
 *                     to ERROR_NO_CMD: the command stays PENDING.
 *   send_cmd_result   preserved RAW - every header, the body bytes, a hash -
 *                     matched by trans_id to the command that was issued and
 *                     by dev_id to the device it was issued to; ACKed OK
 *                     only once the block row is committed (R1). Nothing
 *                     decodes the body: the FKDataHS102 historical layout is
 *                     not captured, so no punch is created from it yet.
 *
 * WHAT IT NEVER DOES: pair IN/OUT, compute hours, apply grace, breaks, OT,
 * or status. It stores and dates. Part 2 is elsewhere. It never queues a
 * command itself and never issues anything but GET_LOG_DATA
 * (biomax/commands.js refuses the rest by name).
 *
 * Usage:  BIOMAX_PORT=7005 node biomax/receiver.js
 * Health: GET /healthz  -> {"ok":true,"db":true,"last_punch_received":...}
 */

const http = require("http");
const path = require("path");

const protocol = require("./protocol");
const { parseEmployeeCode } = require("./employeeMatch");
const { deriveAttendanceDate, STATUS } = require("./attendanceDate");
const { createFloodGuard } = require("./flood");
const { createLog } = require("./log");
const { createSpool } = require("./spool");
const commands = require("./commands");

/**
 * Production runs this under ec2-user on Node 14.21.3, the same interpreter
 * as the API (D1, amended). Everything in biomax/ is written for Node 14:
 * no fetch(), no node: import prefixes, no ??= / ||=, no replaceAll, no
 * Array.prototype.at. Node 14 reached end-of-life in April 2023; that is a
 * pre-existing condition of the host and upgrading the API runtime is out
 * of scope for Part 1 (recorded as technical debt in the spec).
 */
const MIN_NODE_MAJOR = 14;
const TESTED_NODE_MAJORS = [14, 16, 18, 20, 22];

function readConfig(env = process.env) {
  const int = (name, fallback) => {
    const n = Number(String(env[name] === undefined ? "" : env[name]).trim());
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return {
    port: int("BIOMAX_PORT", 7005),
    host: env.BIOMAX_HOST || "0.0.0.0",
    maxBodyBytes: int("BIOMAX_MAX_BODY", protocol.DEFAULT_MAX_BODY_BYTES),
    socketTimeoutMs: int("BIOMAX_SOCKET_TIMEOUT_MS", 15000),
    spoolDir: env.BIOMAX_SPOOL_DIR || null,
    // OFF unless explicitly "1"/"true": with it off, a queued command is never
    // handed to any device, however it got queued.
    commandsEnabled: /^(1|true|yes)$/i.test(String(env.BIOMAX_COMMANDS_ENABLED === undefined ? "" : env.BIOMAX_COMMANDS_ENABLED).trim()),
    flood: {
      perMinute: int("BIOMAX_UNREG_PER_MINUTE", 30),
      perDay: int("BIOMAX_UNREG_PER_DAY", 2000),
      devicesPerDay: int("BIOMAX_UNREG_DEVICES_PER_DAY", 20),
    },
  };
}

/** Rebuild the frame as the device sent it, for the raw-request table. */
function rebuildFrame(req, body) {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body || Buffer.alloc(0)]);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        // Keep what we have (truncated) for diagnosis; stop buffering.
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ body: Buffer.concat(chunks), oversized, size }));
    req.on("error", reject);
  });
}

/**
 * Build the receiver around injected collaborators, so the end-to-end test
 * can run it on port 0 with a fake store and a fixed clock.
 */
function createReceiver({ store, log, spool, flood, config } = {}) {
  const cfg = { ...readConfig(), ...(config || {}) };
  const logger = log || createLog();
  const spooler = spool || createSpool(cfg.spoolDir);
  const guard = flood || createFloodGuard({ limits: cfg.flood });

  // Unregistered devices we have already announced this process lifetime.
  const announcedUnregistered = new Set();

  function reply(res, kind) {
    // setHeader keeps insertion order, and unlike the array form of
    // writeHead it behaves identically on Node 14 (the production runtime)
    // and on the Node 22 the tests run under.
    for (const [k, v] of protocol.buildAckHeaders(kind)) res.setHeader(k, v);
    res.writeHead(200);
    res.end();
  }

  /** Hand a claimed GET_LOG_DATA to the polling device (assumed reply shape - see protocol.js). */
  function replyCommand(res, command) {
    const { headers, body } = protocol.buildCommandReply(command);
    for (const [k, v] of headers) res.setHeader(k, v);
    res.writeHead(200);
    res.end(body);
  }

  /** No ACK: the device must keep the punch and retry (R1). */
  function refuse(req) {
    req.socket.destroy();
  }

  async function handlePunch(ctx) {
    const { req, res, envelope, body, frame, sourceIp, sourcePort, started, oversized } = ctx;
    const base = {
      dev_id: envelope.dev_id,
      request_code: protocol.REQUEST_PUNCH,
      source_ip: sourceIp,
      bytes: frame.length,
    };

    if (!envelope.dev_id) {
      return preserveAndAck(ctx, "unparsed", "missing dev_id header", base);
    }
    if (oversized) {
      return preserveAndAck(ctx, "oversized", `body exceeded ${cfg.maxBodyBytes} bytes`, base);
    }

    const parsed = protocol.parsePunchBody(body);
    if (!parsed.ok) {
      return preserveAndAck(ctx, "unparsed", parsed.reason, base);
    }

    // Registered? Decides only logging and the flood cap; the punch is
    // stored either way (D3, R7).
    let device;
    try {
      device = await store.findDevice(envelope.dev_id);
    } catch (err) {
      return storeFailure(ctx, err, base);
    }

    if (!device) {
      const admitted = guard.admit(envelope.dev_id);
      if (!admitted.allowed) {
        if (guard.oncePerHour(`flood:${envelope.dev_id}`)) {
          await safeRaw({ ...base, outcome: "flood_capped", reason: admitted.reason, byte_length: frame.length, raw_frame: frame });
        }
        logger.request({ ...base, outcome: "flood_capped", reason: admitted.reason, user_id: parsed.punch.user_id, io_time_raw: parsed.punch.io_time_raw, duration_ms: Date.now() - started, error: true });
        reply(res, protocol.ACK_OK);
        return;
      }
    }

    // Identity, posting and the attendance date - snapshotted now (R16).
    let employee = null;
    let derived;
    try {
      const code = parseEmployeeCode(parsed.punch.user_id);
      employee = code === null ? null : await store.findEmployee(code);

      const scheduleRow =
        employee && employee.default_work_shift_id !== null && employee.default_work_shift_id !== undefined
          ? await prefetchSchedule(employee.default_work_shift_id, parsed.punch.io_time_raw)
          : null;

      const decision = deriveAttendanceDate({
        ioTimeRaw: parsed.punch.io_time_raw,
        employee,
        readSchedule: () => scheduleRow,
      });
      derived = {
        attendance_date: decision.attendance_date,
        status: decision.status,
        employee_id: employee ? employee.employee_id : null,
        home_outlet_id: employee ? nullable(employee.store_id) : null,
        department_id: employee ? nullable(employee.department_id) : null,
        work_shift_id: decision.work_shift_id,
        work_shift_weekly_schedule_id: decision.work_shift_weekly_schedule_id,
        cutoff_applied: decision.cutoff_applied,
      };
    } catch (err) {
      return storeFailure(ctx, err, base);
    }

    let result;
    try {
      result = await store.insertPunch(
        {
          ...parsed.punch,
          dev_id: envelope.dev_id,
          cmd_id: envelope.cmd_id,
          blk_no: envelope.blk_no,
          blk_len: envelope.blk_len,
          content_length: envelope.content_length,
          source_ip: sourceIp,
          source_port: sourcePort,
        },
        derived
      );
    } catch (err) {
      return storeFailure(ctx, err, base);
    }

    // Durable. Acknowledge FIRST, then the housekeeping that must never
    // stand between a stored punch and its ACK.
    reply(res, protocol.ACK_OK);

    const outcome = result.outcome === "duplicate" ? "duplicate" : device ? "stored" : "stored_unregistered";
    logger.request({
      ...base,
      outcome,
      user_id: parsed.punch.user_id,
      io_time_raw: parsed.punch.io_time_raw,
      attendance_date: derived.attendance_date,
      derivation_status: derived.status,
      biomax_punch_id: result.biomax_punch_id,
      warnings: parsed.warnings.length ? parsed.warnings : undefined,
      duration_ms: Date.now() - started,
      error: !device || derived.status === STATUS.MISSING_CUTOFF || derived.status === STATUS.NO_SCHEDULE_ROW,
    });

    if (device) {
      await safe(() => store.touchDevice(envelope.dev_id, { punch: true }));
    } else if (!announcedUnregistered.has(envelope.dev_id)) {
      announcedUnregistered.add(envelope.dev_id);
      await safeRaw({ ...base, outcome: "unregistered_device_first_seen", reason: "no biomax_device row for this Cloud ID; punches are stored and quarantined until it is registered", byte_length: frame.length, raw_frame: frame });
    }

    if (
      result.outcome === "stored" &&
      (derived.status === STATUS.MISSING_CUTOFF || derived.status === STATUS.NO_SCHEDULE_ROW) &&
      guard.oncePerHour(`config:${derived.work_shift_id}:${derived.status}`)
    ) {
      await safeRaw({
        ...base,
        outcome: "config_error",
        reason: `${derived.status}: work_shift_id ${derived.work_shift_id} has no usable Attendance Day Cutoff for the previous weekday; punches are held in the review queue`,
        byte_length: 0,
        raw_frame: null,
      });
    }
  }

  /**
   * The previous calendar day's schedule row, fetched through the store's
   * cache and handed to the pure rule as a synchronous reader.
   */
  async function prefetchSchedule(workShiftId, ioTimeRaw) {
    const { calendarDates } = require("./attendanceDate");
    const { previousDayOfWeek } = calendarDates(ioTimeRaw);
    return store.findScheduleRow(Number(workShiftId), previousDayOfWeek);
  }

  /** Preserve a frame we could not turn into a punch, then ACK (R1). */
  async function preserveAndAck(ctx, outcome, reason, base) {
    const { res, frame, started } = ctx;
    try {
      await store.insertRawRequest({ ...base, outcome, reason, byte_length: frame.length, raw_frame: frame });
    } catch (err) {
      return storeFailure(ctx, err, base, `${outcome}: ${reason}`);
    }
    reply(res, protocol.ACK_OK);
    logger.request({ ...base, outcome, reason, duration_ms: Date.now() - started, error: true });
  }

  /** Nothing durable: spool for diagnosis, no ACK, error log. */
  function storeFailure(ctx, err, base, reasonPrefix) {
    const { req, frame, started } = ctx;
    let spooled = null;
    try {
      spooled = spooler.write(base.dev_id, frame, `${reasonPrefix ? `${reasonPrefix}; ` : ""}${err && err.message}`);
    } catch (spoolErr) {
      logger.error("SPOOL_FAILED", spoolErr.message, { dev_id: base.dev_id });
    }
    logger.request({
      ...base,
      outcome: "store_error",
      error: err && err.message ? err.message : String(err),
      spooled,
      duration_ms: Date.now() - started,
    });
    refuse(req);
  }

  async function handlePoll(ctx, classified) {
    const { res, envelope, frame, sourceIp, started } = ctx;
    const base = {
      dev_id: envelope.dev_id,
      request_code: classified.code,
      source_ip: sourceIp,
      bytes: frame.length,
    };

    // A genuine receive_cmd from an identified device may carry a queued
    // command back - only with the flag on, only its own device's command,
    // only once (the store's claim is the UPDATE that flips PENDING->SENT).
    if (!classified.unknown && envelope.dev_id && cfg.commandsEnabled && typeof store.claimPendingCommand === "function") {
      let command = null;
      try {
        command = await store.claimPendingCommand(envelope.dev_id, sourceIp);
      } catch (err) {
        logger.error("COMMAND_CLAIM_FAILED", err && err.message ? err.message : String(err), { dev_id: envelope.dev_id });
        command = null; // stays PENDING; the device is told there is nothing
      }
      if (command) {
        try {
          commands.assertAllowedCommand(command.cmd_code);
        } catch (err) {
          // Cannot happen (the column is a one-value ENUM), but never send
          // anything this module has not vetted.
          logger.error("COMMAND_REFUSED", err.message, { dev_id: envelope.dev_id, trans_id: command.trans_id });
          reply(res, protocol.ACK_NO_CMD);
          return;
        }
        replyCommand(res, command);
        logger.request({ ...base, outcome: "command_sent", trans_id: command.trans_id, cmd_code: command.cmd_code, begin_time: command.begin_time, end_time: command.end_time, biomax_historical_pull_id: command.biomax_historical_pull_id, duration_ms: Date.now() - started });
        await safe(() => store.touchDevice(envelope.dev_id, { punch: false }));
        return;
      }
    }

    reply(res, protocol.ACK_NO_CMD);
    if (classified.unknown) {
      await safeRaw({ ...base, outcome: "unknown_request_code", reason: `request_code ${JSON.stringify(classified.code)}`, byte_length: frame.length, raw_frame: frame });
    }
    logger.request({ ...base, outcome: classified.unknown ? "unknown_request_code" : "poll", duration_ms: Date.now() - started, error: classified.unknown });
    if (envelope.dev_id) await safe(() => store.touchDevice(envelope.dev_id, { punch: false }));
  }

  /**
   * send_cmd_result: keep it, match it, ACK it - in that order. Nothing is
   * decoded. The block row is the durable record; if it cannot be written
   * the socket is closed with no reply, exactly as for a punch (R1).
   */
  async function handleCmdResult(ctx, classified) {
    const { req, res, envelope, body, frame, sourceIp, started, oversized } = ctx;
    const base = {
      dev_id: envelope.dev_id,
      request_code: classified.code,
      source_ip: sourceIp,
      bytes: frame.length,
    };
    if (!envelope.dev_id) {
      return preserveAndAck(ctx, "unparsed", "send_cmd_result without dev_id header", base);
    }

    let command = null;
    try {
      command = envelope.trans_id ? await store.findCommandByTransId(envelope.trans_id) : null;
    } catch (err) {
      return storeFailure(ctx, err, base, "send_cmd_result: command lookup");
    }
    const match = commands.matchResult(envelope, command);
    const pullId = match === commands.MATCH.MATCHED ? Number(command.biomax_historical_pull_id) : null;

    let stored;
    try {
      stored = await store.insertResultBlock({
        biomax_historical_pull_id: pullId,
        dev_id: envelope.dev_id,
        trans_id: envelope.trans_id,
        cmd_id: envelope.cmd_id,
        cmd_code: envelope.cmd_code,
        cmd_return_code: envelope.cmd_return_code,
        blk_no: envelope.blk_no === null ? 0 : envelope.blk_no,
        blk_len: envelope.blk_len,
        content_length: envelope.content_length,
        headers_json: JSON.stringify(protocol.listHeaders(req.rawHeaders)),
        raw_body: body,
        match_status: match,
        source_ip: sourceIp,
      });
    } catch (err) {
      return storeFailure(ctx, err, base, "send_cmd_result: block");
    }

    // Durable. ACK first, then the pull's bookkeeping.
    reply(res, protocol.ACK_OK);

    const failed = commands.isFailureReturnCode(envelope.cmd_return_code);
    logger.request({
      ...base,
      outcome: `cmd_result_${match.toLowerCase()}`,
      block_outcome: stored.outcome,
      trans_id: envelope.trans_id,
      blk_no: envelope.blk_no,
      body_len: body.length,
      body_sha256: stored.body_sha256,
      cmd_return_code: envelope.cmd_return_code,
      biomax_historical_pull_id: pullId,
      oversized: oversized || undefined,
      duration_ms: Date.now() - started,
      error: match !== commands.MATCH.MATCHED || failed || stored.outcome === "conflict" || oversized,
    });

    if (match === commands.MATCH.MATCHED && stored.outcome === "stored") {
      if (failed) {
        await safe(() => store.markPullFailed(pullId, `device returned cmd_return_code ${envelope.cmd_return_code}`));
      } else {
        await safe(() => store.markPullReceiving(pullId));
      }
    }
    if (match !== commands.MATCH.MATCHED && stored.outcome === "stored") {
      await safeRaw({ ...base, outcome: "unknown_request_code", reason: `send_cmd_result ${match}: trans_id ${JSON.stringify(envelope.trans_id)}`, byte_length: frame.length, raw_frame: frame });
    }
    await safe(() => store.touchDevice(envelope.dev_id, { punch: false }));
  }

  async function handleHealth(res) {
    let db = false;
    let last = null;
    try {
      db = await store.ping();
      last = await store.lastPunchAt();
    } catch (err) {
      db = false;
    }
    res.writeHead(db ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: db, db, last_punch_received: last, node: process.versions.node }));
  }

  async function handle(req, res) {
    const started = Date.now();
    const sourceIp = req.socket.remoteAddress || null;
    const sourcePort = req.socket.remotePort || null;

    if (req.method === "GET" && req.url === "/healthz") return handleHealth(res);

    let read;
    try {
      read = await readBody(req, cfg.maxBodyBytes);
    } catch (err) {
      logger.request({ request_code: null, dev_id: protocol.headerValue(req.headers, "dev_id") || null, source_ip: sourceIp, outcome: "read_error", error: err.message, duration_ms: Date.now() - started });
      return refuse(req);
    }

    const envelope = protocol.readEnvelope(req.headers);
    const classified = protocol.classifyRequest(req.headers);
    const frame = rebuildFrame(req, read.body);
    const ctx = { req, res, envelope, body: read.body, frame, sourceIp, sourcePort, started, oversized: read.oversized };

    if (classified.kind === "punch") return handlePunch(ctx);
    if (classified.kind === "cmd_result") return handleCmdResult(ctx, classified);
    return handlePoll(ctx, classified);
  }

  async function safe(fn) {
    try {
      await fn();
    } catch (err) {
      logger.error("HOUSEKEEPING_FAILED", err && err.message ? err.message : String(err));
    }
  }
  const safeRaw = (entry) => safe(() => store.insertRawRequest(entry));
  const nullable = (v) => (v === undefined ? null : v);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error("UNHANDLED", err && err.stack ? err.stack : String(err));
      try {
        req.socket.destroy();
      } catch (e) {
        /* already gone */
      }
    });
  });
  server.timeout = cfg.socketTimeoutMs;
  server.keepAliveTimeout = 1000;

  function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, handle, listen, close, config: cfg };
}

/* ----------------------------------------------------------------- main -- */

function assertRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    // Loud and immediate, so a wrong interpreter is a visible crash loop in
    // `pm2 ls`, not a syntax error buried in a log.
    console.error(
      `biomax-receiver: Node ${process.versions.node} is unsupported; Node ${MIN_NODE_MAJOR}+ is required ` +
        "(production target: Node 14.21.3 under ec2-user, the API's own interpreter)."
    );
    process.exit(78); // EX_CONFIG
  }
  if (!TESTED_NODE_MAJORS.includes(major)) {
    console.warn(`biomax-receiver: Node ${process.versions.node} has not been exercised by the test suite; continuing.`);
  }
}

async function main() {
  assertRuntime();
  // Same resolution as server.js: NODE_ENV, else "development". On dnds-be
  // the API runs with NODE_ENV unset, so its live pool is
  // config.json db.mysql.development; the receiver must use the very same
  // block. BIOMAX_DB_ENV overrides only when set explicitly.
  global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
  global.isDev = () => global.env === "development";
  const dbEnv = process.env.BIOMAX_DB_ENV || global.env;

  // Same config.json section the API uses (drivers/mysql.js).
  const configPath = path.join(__dirname, "..", "config.json");
  const dbConfig = require(configPath).db.mysql[dbEnv];
  if (!dbConfig) {
    console.error(`biomax-receiver: config.json has no db.mysql.${dbEnv} block`);
    process.exit(78);
  }
  const { createPool, createStore } = require("./store");
  const pool = createPool(dbConfig);
  const store = createStore(pool);
  const log = createLog();

  await store.ping();

  const receiver = createReceiver({ store, log });
  const address = await receiver.listen();
  log.info("STARTED", `listening on ${address.address}:${address.port}`, {
    node: process.versions.node,
    env: global.env,
    db_env: dbEnv,
    db: `${dbConfig.host}/${dbConfig.database}`,
    max_body: receiver.config.maxBodyBytes,
    commands_enabled: receiver.config.commandsEnabled,
    flood: receiver.config.flood,
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("STOPPING", `received ${signal}; finishing in-flight requests`);
    // Stop accepting; in-flight requests finish. A request cut off by the
    // hard exit below simply gets no ACK and is retransmitted (R1).
    const timer = setTimeout(() => process.exit(0), 5000);
    await receiver.close();
    await store.close();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("biomax-receiver failed to start:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { createReceiver, readConfig, rebuildFrame, assertRuntime, MIN_NODE_MAJOR, TESTED_NODE_MAJORS };
