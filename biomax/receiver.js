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
 *        two empty command headers), and an unknown code is also recorded -
 *        once per identical frame and at most BIOMAX_DIAG_PER_SOURCE times
 *        per device and code per BIOMAX_DIAG_WINDOW_MS, never once per retry.
 *        `realtime_enroll_data` (believed to be enrollment/profile data -
 *        uncaptured, treated as potentially biometric/sensitive) is answered
 *        the same way by default and its body is hashed and discarded, never
 *        stored or logged (handleEnroll).
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
 *                     only once the COMPLETE block row is committed (R1). A
 *                     body over BIOMAX_COMMAND_RESULT_MAX_BODY, or shorter
 *                     than its Content-Length, is never stored truncated and
 *                     never ACKed: the socket is closed so the device retries.
 *                     cmd_return_code is kept verbatim and nothing is inferred
 *                     from it. Nothing decodes the body: the FKDataHS102
 *                     historical layout is not captured, so no punch is
 *                     created from it yet.
 *   delivery lease    a command handed out is SENT for
 *                     BIOMAX_COMMAND_LEASE_SECONDS; if no result block has
 *                     arrived by then it is handed out again on the next poll
 *                     with the SAME trans_id, up to BIOMAX_COMMAND_MAX_ATTEMPTS
 *                     times (GET_LOG_DATA is read-only and result blocks are
 *                     deduplicated, so a repeat is harmless).
 *
 * BOUNDED BY CONSTRUCTION (the 2026-09 OOM, see docs/biomax-receiver-resource-limits.md):
 *
 *   Nothing is awaited after a reply. Device last-seen upkeep, diagnostic
 *   rows and pull bookkeeping go to a bounded housekeeping queue
 *   (housekeeping.js) that uses at most BIOMAX_HOUSEKEEPING_CONCURRENCY of
 *   the pool's connections and drops - counted and logged - rather than
 *   grows. Every DB wait has a deadline (BIOMAX_DB_ACQUIRE_TIMEOUT_MS,
 *   BIOMAX_DB_QUERY_TIMEOUT_MS) and the pool's own queue a limit
 *   (BIOMAX_DB_QUEUE_LIMIT). /healthz probes the database on its OWN
 *   one-connection pool within BIOMAX_HEALTH_DB_BUDGET_MS, so it answers
 *   while the receiver's pool is saturated. A punch that meets any of these
 *   limits before it is durable is refused with no reply - R1 exactly as
 *   before - and the device retries.
 *
 * WHAT IT NEVER DOES: pair IN/OUT, compute hours, apply grace, breaks, OT,
 * or status. It stores and dates. Part 2 is elsewhere. It never queues a
 * command itself and never issues anything but GET_LOG_DATA
 * (biomax/commands.js refuses the rest by name).
 *
 * Usage:  BIOMAX_PORT=7005 node biomax/receiver.js
 * Health: GET /healthz  -> {"ok":true,"db":true,"last_punch_received":...,
 *                            "process":{...},"db_check":{...},"pool":{...},
 *                            "housekeeping":{...},"requests_by_code":{...}}
 */

const crypto = require("crypto");
const http = require("http");
const path = require("path");

const protocol = require("./protocol");
const { parseEmployeeCode } = require("./employeeMatch");
const { deriveAttendanceDate, calendarDates, STATUS } = require("./attendanceDate");
const { resolveWorkShiftIdForPunch } = require("../utils/shiftResolution");

/** `[calendarDate, previousDate]` for a raw io_time, for the shift resolver. */
const punchDates = (ioTimeRaw) => {
  const { calendarDate, previousDate } = calendarDates(ioTimeRaw);
  return [calendarDate, previousDate];
};
const { createFloodGuard } = require("./flood");
const { createLog } = require("./log");
const { createSpool } = require("./spool");
const { createHousekeeper, createDiagLimiter } = require("./housekeeping");
const { createHealthMonitor } = require("./healthMonitor");
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

/** 4 MB by default, never above the 16 MB a MEDIUMBLOB column can hold. */
const DEFAULT_COMMAND_RESULT_MAX_BODY = 4 * 1024 * 1024;
const HARD_COMMAND_RESULT_MAX_BODY = 16 * 1024 * 1024 - 1;

function readConfig(env = process.env) {
  const int = (name, fallback) => {
    const n = Number(String(env[name] === undefined ? "" : env[name]).trim());
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return {
    port: int("BIOMAX_PORT", 7005),
    host: env.BIOMAX_HOST || "0.0.0.0",
    maxBodyBytes: int("BIOMAX_MAX_BODY", protocol.DEFAULT_MAX_BODY_BYTES),
    // send_cmd_result bodies carry historical blocks, not 144-byte punches.
    // Separate, larger, and hard-capped at what biomax_command_result_block
    // .raw_body (MEDIUMBLOB) can hold: a block we could not keep whole is
    // refused, never truncated (see handleCmdResult).
    commandResultMaxBodyBytes: Math.min(int("BIOMAX_COMMAND_RESULT_MAX_BODY", DEFAULT_COMMAND_RESULT_MAX_BODY), HARD_COMMAND_RESULT_MAX_BODY),
    // Delivery lease: how long a SENT command waits for a result before it
    // may be handed out again, and how many hand-outs in total.
    commandLeaseSeconds: int("BIOMAX_COMMAND_LEASE_SECONDS", 600),
    commandMaxAttempts: int("BIOMAX_COMMAND_MAX_ATTEMPTS", 3),
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
    // Concurrent sockets. Each can hold at most maxBodyBytes of body, so
    // this caps request memory as well (Node closes sockets beyond it; a
    // device just retries).
    maxConnections: int("BIOMAX_MAX_CONNECTIONS", 200),
    // The receiver's pool (still connectionLimit 3): how many waiters it may
    // queue, how long a wait for a connection and a single statement may
    // take. A punch that hits any of these is refused with no ACK (R1).
    db: {
      queueLimit: int("BIOMAX_DB_QUEUE_LIMIT", 50),
      acquireTimeoutMs: int("BIOMAX_DB_ACQUIRE_TIMEOUT_MS", 5000),
      queryTimeoutMs: int("BIOMAX_DB_QUERY_TIMEOUT_MS", 10000),
    },
    // /healthz never does DB I/O. A background monitor probes on its own
    // one-connection pool: one probe at a time, every intervalMs after the
    // previous one settled, recorded as failed after timeoutMs; /healthz
    // reports the last result and its age.
    health: {
      intervalMs: int("BIOMAX_HEALTH_PROBE_INTERVAL_MS", 5000),
      timeoutMs: int("BIOMAX_HEALTH_PROBE_TIMEOUT_MS", 2000),
    },
    housekeeping: {
      concurrency: int("BIOMAX_HOUSEKEEPING_CONCURRENCY", 1),
      maxPending: int("BIOMAX_HOUSEKEEPING_MAX_PENDING", 100),
      maxPendingBytes: int("BIOMAX_HOUSEKEEPING_MAX_PENDING_BYTES", 4 * 1024 * 1024),
      maxCriticalPending: int("BIOMAX_HOUSEKEEPING_MAX_CRITICAL_PENDING", 32),
      maxCriticalPendingBytes: int("BIOMAX_HOUSEKEEPING_MAX_CRITICAL_PENDING_BYTES", 64 * 1024),
    },
    // last_seen_at is written at most this often per device for non-punch
    // traffic (a punch always writes). The connectivity thresholds it feeds
    // are 15 and 60 minutes.
    deviceTouchIntervalMs: int("BIOMAX_DEVICE_TOUCH_INTERVAL_MS", 60000),
    // Diagnostic raw rows for unknown codes and enrolment uploads.
    diag: {
      windowMs: int("BIOMAX_DIAG_WINDOW_MS", 60 * 60 * 1000),
      perSource: int("BIOMAX_DIAG_PER_SOURCE", 6),
      maxPerWindow: int("BIOMAX_DIAG_MAX_PER_WINDOW", 120),
    },
    // What a realtime_enroll_data gets back. ERROR_NO_CMD (the default) is
    // exactly what it got before this code knew the name. "OK" is what the
    // device presumably wants and may stop its re-sending; it is an opt-in
    // until a capture of DigiSME's own reply to this code confirms it.
    enrollReply: /^ok$/i.test(String(env.BIOMAX_ENROLL_DATA_REPLY === undefined ? "" : env.BIOMAX_ENROLL_DATA_REPLY).trim()) ? protocol.ACK_OK : protocol.ACK_NO_CMD,
    statsIntervalMs: int("BIOMAX_STATS_INTERVAL_MS", 60000),
  };
}

/** Shallow merge, one level deep for the grouped settings. */
function mergeConfig(base, over) {
  const out = { ...base, ...(over || {}) };
  for (const k of ["flood", "db", "health", "housekeeping", "diag"]) {
    if (over && over[k]) out[k] = { ...base[k], ...over[k] };
  }
  return out;
}

/** biomax_raw_request.raw_frame keeps 65535 bytes; never pin more than that. */
const RAW_FRAME_MAX = 65535;
const diagFrame = (buf) => (buf && buf.length > RAW_FRAME_MAX ? Buffer.from(buf.subarray(0, RAW_FRAME_MAX)) : buf);
const EMPTY = Buffer.alloc(0);
const MAX_COUNTED_CODES = 32;

/** Rebuild the frame as the device sent it, for the raw-request table. */
function rebuildFrame(req, body) {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body || Buffer.alloc(0)]);
}

/**
 * Read the body up to maxBytes. `keep: false` reads and discards (the bytes
 * are only hashed) - for a frame whose content we must not retain.
 * `hash: true` adds the sha256 of what was read (up to the limit).
 */
function readBody(req, maxBytes, opts = {}) {
  const keep = opts.keep !== false;
  const hash = opts.hash ? crypto.createHash("sha256") : null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) {
        size += chunk.length;
        return;
      }
      size += chunk.length;
      let part = chunk;
      if (size > maxBytes) {
        oversized = true;
        // Keep what we have (truncated) for diagnosis; stop buffering.
        part = chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length)));
      }
      if (hash) hash.update(part);
      if (keep) chunks.push(part);
    });
    req.on("end", () => resolve({ body: keep ? Buffer.concat(chunks) : EMPTY, oversized, size, sha256: hash ? hash.digest("hex") : null }));
    req.on("error", reject);
  });
}

/**
 * Build the receiver around injected collaborators, so the end-to-end test
 * can run it on port 0 with a fake store and a fixed clock.
 */
function createReceiver({ store, log, spool, flood, config, health, housekeeper, now } = {}) {
  const cfg = mergeConfig(readConfig(), config);
  const logger = log || createLog();
  const spooler = spool || createSpool(cfg.spoolDir);
  const guard = flood || createFloodGuard({ limits: cfg.flood });
  const clock = now || (() => Date.now());
  // What the background health probe asks. In production a store on its
  // own one-connection pool (createRuntime); in tests the ordinary store.
  const healthStore = health || store;
  const healthMonitor = createHealthMonitor({ probe: healthStore, intervalMs: cfg.health.intervalMs, timeoutMs: cfg.health.timeoutMs, now: clock, log: logger });
  healthMonitor.start();
  const hk = housekeeper || createHousekeeper({ ...cfg.housekeeping, log: logger, now: clock });
  const diag = createDiagLimiter({ ...cfg.diag, now: clock });
  const startedAt = clock();

  // Unregistered devices we have already announced this process lifetime.
  const announcedUnregistered = new Set();

  // Counters for /healthz and the STATS line. Request codes are whatever a
  // client sends, so the map is capped.
  const requestCounts = new Map();
  const touchTotals = { submitted: 0, skipped_interval: 0, not_accepted: 0 };
  let healthRequests = 0;
  let inFlight = 0;
  function countRequest(code) {
    let k = code ? String(code).slice(0, 40) : "(none)";
    if (!requestCounts.has(k) && requestCounts.size >= MAX_COUNTED_CODES) k = "(other)";
    requestCounts.set(k, (requestCounts.get(k) || 0) + 1);
  }

  /** A diagnostic raw row, off the request path, holding only its own bytes. */
  function submitRaw(name, entry) {
    const raw = entry.raw_frame ? diagFrame(entry.raw_frame) : null;
    const row = { ...entry, raw_frame: raw };
    return hk.submit({ name, bytes: raw ? raw.length : 0, run: () => store.insertRawRequest(row) });
  }

  /**
   * last_seen_at upkeep. A punch always writes (it also sets last_punch_at);
   * anything else at most once per deviceTouchIntervalMs per device. A
   * write still waiting in the queue absorbs a repeat (same key).
   */
  const lastTouch = new Map(); // dev_id -> ms of the last accepted touch
  function touch(devId, { punch }) {
    if (!devId) return;
    const t = clock();
    if (!punch) {
      const last = lastTouch.get(devId);
      if (last !== undefined && t - last < cfg.deviceTouchIntervalMs) {
        touchTotals.skipped_interval += 1;
        return;
      }
    }
    const verdict = hk.submit({
      name: punch ? "touch_device_punch" : "touch_device",
      key: `touch:${devId}:${punch ? "p" : "s"}`,
      run: () => store.touchDevice(devId, { punch: !!punch }),
    });
    if (verdict === "accepted" || verdict === "coalesced") {
      if (lastTouch.size >= 1000 && !lastTouch.has(devId)) lastTouch.clear();
      lastTouch.set(devId, t);
      touchTotals.submitted += 1;
    } else {
      touchTotals.not_accepted += 1;
    }
  }

  /** `+N suppressed` suffix for a diagnostic reason. */
  const suppressedNote = (n) => (n ? `; +${n} suppressed since the last row` : "");

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
        // Beyond the cap the frame is not made a punch row, but its bytes
        // are still made durable BEFORE the OK (R1): an awaited raw row on
        // the receiver pool, exactly like an unparseable frame. If that
        // write fails, times out or finds the pool full: no reply, the
        // device retries. Never through the droppable housekeeping queue.
        return preserveAndAck(ctx, "flood_capped", admitted.reason, base, {
          user_id: parsed.punch.user_id,
          io_time_raw: parsed.punch.io_time_raw,
        });
      }
    }

    // Identity, posting and the attendance date - snapshotted now (R16).
    let employee = null;
    let derived;
    try {
      const code = parseEmployeeCode(parsed.punch.user_id);
      employee = code === null ? null : await store.findEmployee(code);

      // WHICH SHIFT, from the DATED assignment history - the same rows the
      // attendance engine, the dashboard and payroll resolve a date
      // against. Reading `default_work_shift_id` here is what let the Punch
      // Audit and the Attendance Dashboard disagree about the same
      // employee, permanently: a punch's derivation status is written once,
      // here, and nothing revisited it.
      const workShiftId = employee
        ? resolveWorkShiftIdForPunch(
            await store.findShiftAssignments(employee.employee_id),
            ...punchDates(parsed.punch.io_time_raw)
          )
        : null;

      const scheduleRow =
        workShiftId === null ? null : await prefetchSchedule(workShiftId, parsed.punch.io_time_raw);

      const decision = deriveAttendanceDate({
        ioTimeRaw: parsed.punch.io_time_raw,
        employee,
        workShiftId,
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
    // stand between a stored punch and its ACK - queued, not awaited, so
    // this request is finished (and its buffers free) the moment we return.
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
      touch(envelope.dev_id, { punch: true });
    } else if (!announcedUnregistered.has(envelope.dev_id)) {
      announcedUnregistered.add(envelope.dev_id);
      submitRaw("raw_unregistered_first_seen", { ...base, outcome: "unregistered_device_first_seen", reason: "no biomax_device row for this Cloud ID; punches are stored and quarantined until it is registered", byte_length: frame.length, raw_frame: frame });
    }

    if (
      result.outcome === "stored" &&
      (derived.status === STATUS.MISSING_CUTOFF || derived.status === STATUS.NO_SCHEDULE_ROW) &&
      guard.oncePerHour(`config:${derived.work_shift_id}:${derived.status}`)
    ) {
      submitRaw("raw_config_error", {
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
    const { previousDayOfWeek } = calendarDates(ioTimeRaw);
    return store.findScheduleRow(Number(workShiftId), previousDayOfWeek);
  }

  /** Preserve a frame we could not turn into a punch, then ACK (R1). */
  async function preserveAndAck(ctx, outcome, reason, base, logExtra) {
    const { res, frame, started } = ctx;
    try {
      await store.insertRawRequest({ ...base, outcome, reason, byte_length: frame.length, raw_frame: frame });
    } catch (err) {
      return storeFailure(ctx, err, base, `${outcome}: ${reason}`);
    }
    reply(res, protocol.ACK_OK);
    logger.request({ ...base, ...(logExtra || {}), outcome, reason, duration_ms: Date.now() - started, error: true });
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
        command = await store.claimPendingCommand(envelope.dev_id, sourceIp, { leaseSeconds: cfg.commandLeaseSeconds, maxAttempts: cfg.commandMaxAttempts });
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
        logger.request({ ...base, outcome: "command_sent", trans_id: command.trans_id, cmd_code: command.cmd_code, begin_time: command.begin_time, end_time: command.end_time, attempt: command.attempt_count, biomax_historical_pull_id: command.biomax_historical_pull_id, duration_ms: Date.now() - started });
        touch(envelope.dev_id, { punch: false });
        return;
      }
    }

    reply(res, protocol.ACK_NO_CMD);
    if (classified.unknown) {
      // Preserved verbatim - the first identical frame per window, and at
      // most diag.perSource per device and code. A device re-sending the
      // same thing all day is one row plus a count, not a row per retry.
      const dev = envelope.dev_id || "-";
      const verdict = diag.check(`${dev}|${classified.code}`, `${dev}|${classified.code}|${ctx.bodySha256}`);
      if (verdict.write) {
        submitRaw("raw_unknown_request_code", { ...base, outcome: "unknown_request_code", reason: `request_code ${JSON.stringify(classified.code)}${suppressedNote(verdict.suppressed)}`, byte_length: frame.length, raw_frame: frame });
        logger.request({ ...base, outcome: "unknown_request_code", suppressed_since_last: verdict.suppressed || undefined, duration_ms: Date.now() - started, error: true });
      }
    } else {
      logger.request({ ...base, outcome: "poll", duration_ms: Date.now() - started });
    }
    touch(envelope.dev_id, { punch: false });
  }

  /**
   * realtime_enroll_data: believed to be the terminal uploading user
   * enrollment/profile data. No capture or protocol definition exists, so
   * the body is treated as potentially biometric/sensitive: it is never
   * parsed, stored, logged or retained - it was read, hashed and dropped
   * before this runs - and nothing here can become a punch (only
   * realtime_glog is attendance). The reply is cfg.enrollReply (ERROR_NO_CMD unless
   * BIOMAX_ENROLL_DATA_REPLY=OK). One diagnostic row per identical upload
   * per window, headers + size + hash only, rate-limited like any unknown
   * code; the rest are counted.
   */
  function handleEnroll(ctx, classified) {
    const { res, envelope, frame, sourceIp, started } = ctx;
    const bodyBytes = ctx.bytesReceived || 0;
    const base = {
      dev_id: envelope.dev_id,
      request_code: classified.code,
      source_ip: sourceIp,
      bytes: frame.length + bodyBytes,
    };
    reply(res, cfg.enrollReply);
    const dev = envelope.dev_id || "-";
    const verdict = diag.check(`${dev}|${classified.code}`, `${dev}|${classified.code}|${ctx.bodySha256}`);
    if (verdict.write) {
      submitRaw("raw_enroll_data", {
        ...base,
        outcome: "unknown_request_code",
        reason: `realtime_enroll_data (believed enrollment/profile data, treated as sensitive): body ${bodyBytes} B sha256 ${String(ctx.bodySha256).slice(0, 16)} NOT stored, reply ${cfg.enrollReply}${suppressedNote(verdict.suppressed)}`,
        byte_length: frame.length + bodyBytes,
        raw_frame: frame, // headers only - the body was never kept
      });
      logger.request({ ...base, outcome: "enroll_data", reply: cfg.enrollReply, body_sha256: ctx.bodySha256, oversized: ctx.oversized || undefined, suppressed_since_last: verdict.suppressed || undefined, duration_ms: Date.now() - started });
    }
    touch(envelope.dev_id, { punch: false });
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

    // Complete or nothing. A body cut by the size limit, or shorter than the
    // device said it would be, is not the block the device sent; storing it
    // and saying OK would make the device forget data we never got. Refuse:
    // no reply, socket closed, device retries.
    if (oversized) {
      logger.request({ ...base, outcome: "oversized_refused", trans_id: envelope.trans_id, blk_no: envelope.blk_no, bytes_received: ctx.bytesReceived, limit: cfg.commandResultMaxBodyBytes, duration_ms: Date.now() - started, error: true });
      return refuse(req);
    }
    if (envelope.content_length !== null && body.length !== envelope.content_length) {
      logger.request({ ...base, outcome: "incomplete_refused", trans_id: envelope.trans_id, blk_no: envelope.blk_no, content_length: envelope.content_length, body_len: body.length, duration_ms: Date.now() - started, error: true });
      return refuse(req);
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

    // Durable and complete. ACK first, then the pull's bookkeeping.
    reply(res, protocol.ACK_OK);

    // cmd_return_code is recorded verbatim on the block and in the log and
    // NOTHING is inferred from it: the device's vocabulary has not been
    // captured, so neither success nor failure is read into any value.
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
      duration_ms: Date.now() - started,
      error: match !== commands.MATCH.MATCHED || stored.outcome === "conflict",
    });

    if (match === commands.MATCH.MATCHED) {
      // Any matched block, first or repeated, proves delivery: the command
      // is answered (no more re-sends) and the pull is receiving. Critical:
      // never dropped for queue capacity (and a later matched block would
      // redo it anyway - the UPDATEs are guarded on status).
      // Critical lane: started before any ordinary job, bounded on its own,
      // and coalesced per (pull, trans_id) - a burst of blocks for one pull
      // is one waiting UPDATE, not one per block. If even that lane is full
      // (the DB has been stuck for a long time) the drop is counted and
      // logged; the next matched block for the pull re-submits it.
      const transId = envelope.trans_id;
      hk.submit({ name: "mark_pull_receiving", critical: true, key: `pull:${pullId}:${transId}`, run: () => store.markPullReceiving(pullId, transId) });
    }
    if (match !== commands.MATCH.MATCHED && stored.outcome === "stored") {
      submitRaw("raw_unmatched_cmd_result", { ...base, outcome: "unknown_request_code", reason: `send_cmd_result ${match}: trans_id ${JSON.stringify(envelope.trans_id)}`, byte_length: frame.length, raw_frame: frame });
    }
    touch(envelope.dev_id, { punch: false });
  }

  /* --------------------------------------------------------- /healthz -- */

  /**
   * Synchronous: no DB I/O, no await. Process state is live; DB state is
   * whatever the background monitor last recorded, with its age. So the
   * answer is immediate however many probes arrive and however sick the
   * database is, and probing /healthz harder never probes the DB harder.
   */
  function handleHealth(res) {
    healthRequests += 1;
    const db = healthMonitor.status();
    const s = stats();
    const body = {
      // `ok`/`db`/`last_punch_received` keep their meaning for the API's
      // probe (utils/biomax_receiver_health.js): ok = able to store, as of
      // the last background probe (a stale result counts as not able).
      ok: db.ok,
      db: db.ok,
      last_punch_received: db.last_punch_received,
      node: process.versions.node,
      process: { ok: true, uptime_s: s.uptime_s, memory: s.memory, in_flight_requests: s.in_flight_requests },
      db_check: {
        ok: db.ok,
        error: db.error,
        stale: db.stale,
        checked_at: db.checked_at,
        age_ms: db.age_ms,
        latency_ms: db.latency_ms,
        consecutive_failures: db.consecutive_failures,
        probe_in_flight: db.probe_in_flight,
        interval_ms: db.interval_ms,
        timeout_ms: db.timeout_ms,
      },
      pool: s.pool,
      housekeeping: {
        pending: s.housekeeping.pending,
        running: s.housekeeping.running,
        pending_bytes: s.housekeeping.pending_bytes,
        critical_pending: s.housekeeping.critical_pending,
        dropped: s.housekeeping.dropped,
        critical_dropped: s.housekeeping.critical_dropped,
        coalesced: s.housekeeping.coalesced,
        failed: s.housekeeping.failed,
      },
      diagnostics: s.diagnostics,
      requests_by_code: s.requests_by_code,
    };
    res.writeHead(db.ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Everything worth watching, for /healthz and the periodic STATS line. */
  function stats() {
    const m = process.memoryUsage();
    const mb = (b) => Math.round((b / 1048576) * 10) / 10;
    const codes = {};
    requestCounts.forEach((v, k) => {
      codes[k] = v;
    });
    return {
      uptime_s: Math.round((clock() - startedAt) / 1000),
      memory: { heap_used_mb: mb(m.heapUsed), heap_total_mb: mb(m.heapTotal), rss_mb: mb(m.rss), external_mb: mb(m.external) },
      in_flight_requests: inFlight,
      health_requests: healthRequests,
      requests_by_code: codes,
      housekeeping: hk.stats(),
      diagnostics: diag.stats(),
      device_touch: { ...touchTotals, interval_ms: cfg.deviceTouchIntervalMs },
      pool: typeof store.poolStats === "function" ? store.poolStats() : null,
      health_pool: healthStore !== store && typeof healthStore.poolStats === "function" ? healthStore.poolStats() : null,
      health_probe: healthMonitor.status(),
    };
  }

  async function handle(req, res) {
    const started = Date.now();
    const sourceIp = req.socket.remoteAddress || null;
    const sourcePort = req.socket.remotePort || null;

    if (req.method === "GET" && req.url === "/healthz") {
      handleHealth(res);
      return;
    }

    const envelope = protocol.readEnvelope(req.headers);
    const classified = protocol.classifyRequest(req.headers);
    countRequest(classified.code);
    const limit = classified.kind === "cmd_result" ? cfg.commandResultMaxBodyBytes : cfg.maxBodyBytes;

    // A result the device announces as larger than we can keep whole is
    // refused before a byte of it is buffered: no ACK, so it is retried
    // later (and the limit can be raised deliberately). Punches keep their
    // preserve-truncated-and-ACK behaviour, which is what R1 wants for them.
    if (classified.kind === "cmd_result" && envelope.content_length !== null && envelope.content_length > limit) {
      logger.request({ request_code: classified.code, dev_id: envelope.dev_id, source_ip: sourceIp, outcome: "oversized_refused", content_length: envelope.content_length, limit, duration_ms: Date.now() - started, error: true });
      return refuse(req);
    }

    // An enrolment upload is read and hashed, never kept; an unknown code is
    // kept (it may be preserved) and hashed so identical retries coalesce.
    const isEnroll = classified.kind === "enroll";
    let read;
    try {
      read = await readBody(req, limit, { keep: !isEnroll, hash: isEnroll || classified.unknown });
    } catch (err) {
      logger.request({ request_code: classified.code || null, dev_id: envelope.dev_id, source_ip: sourceIp, outcome: "read_error", error: err.message, duration_ms: Date.now() - started });
      return refuse(req);
    }

    const frame = rebuildFrame(req, read.body);
    const ctx = { req, res, envelope, body: read.body, frame, sourceIp, sourcePort, started, oversized: read.oversized, bytesReceived: read.size, bodySha256: read.sha256 };

    if (classified.kind === "punch") return handlePunch(ctx);
    if (classified.kind === "cmd_result") return handleCmdResult(ctx, classified);
    if (isEnroll) return handleEnroll(ctx, classified);
    return handlePoll(ctx, classified);
  }

  const nullable = (v) => (v === undefined ? null : v);

  const server = http.createServer((req, res) => {
    inFlight += 1;
    res.once("close", () => {
      inFlight -= 1;
    });
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
  server.maxConnections = cfg.maxConnections;

  function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address());
      });
    });
  }

  /**
   * Stop accepting, let in-flight requests finish, then stop housekeeping:
   * what has not started is dropped (counted), what is running gets
   * housekeepingTimeoutMs. After this nothing touches the store, so the
   * caller may end the pool without a tail of "Pool is closed" failures.
   */
  async function close({ serverTimeoutMs = 0, housekeepingTimeoutMs = 2000 } = {}) {
    healthMonitor.stop();
    await new Promise((resolve) => {
      // serverTimeoutMs: stop WAITING for in-flight requests after this long
      // (0 = wait for all). They keep running; a punch that has not been
      // ACKed by the hard exit is retransmitted (R1).
      const timer = serverTimeoutMs > 0 ? setTimeout(resolve, serverTimeoutMs) : null;
      server.close(() => {
        if (timer) clearTimeout(timer);
        resolve();
      });
    });
    return hk.close({ timeoutMs: housekeepingTimeoutMs });
  }

  return { server, handle, listen, close, stats, housekeeping: hk, config: cfg };
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
  const log = createLog();
  const runtime = createRuntime({ dbConfig, log });

  await runtime.store.ping();

  const receiver = runtime.receiver;
  const address = await receiver.listen();
  log.info("STARTED", `listening on ${address.address}:${address.port}`, {
    node: process.versions.node,
    env: global.env,
    db_env: dbEnv,
    db: `${dbConfig.host}/${dbConfig.database}`,
    max_body: receiver.config.maxBodyBytes,
    commands_enabled: receiver.config.commandsEnabled,
    command_result_max_body: receiver.config.commandResultMaxBodyBytes,
    command_lease_seconds: receiver.config.commandLeaseSeconds,
    command_max_attempts: receiver.config.commandMaxAttempts,
    flood: receiver.config.flood,
    max_connections: receiver.config.maxConnections,
    db_limits: receiver.config.db,
    health: receiver.config.health,
    housekeeping: receiver.config.housekeeping,
    device_touch_interval_ms: receiver.config.deviceTouchIntervalMs,
    diag: receiver.config.diag,
    enroll_reply: receiver.config.enrollReply,
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("STOPPING", `received ${signal}; finishing in-flight requests`);
    // Stop accepting; in-flight requests finish. A request cut off by the
    // hard exit below simply gets no ACK and is retransmitted (R1).
    const timer = setTimeout(() => process.exit(0), 5000);
    const summary = await runtime.stop();
    log.info("STOPPED", "receiver closed", summary);
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/**
 * The production wiring, shared by main() and the stress harness:
 *
 *   pool        the receiver's own, connectionLimit 3 (unchanged), with a
 *               bounded waiter queue and acquire/query deadlines
 *   healthPool  ONE connection, used by /healthz only, so a saturated main
 *               pool can never make the health check wait behind it
 *   STATS       one log line every statsIntervalMs: memory, pool depth,
 *               housekeeping, diagnostics, request counts by code
 *
 * stop(): server closed -> housekeeping closed (nothing new, pending
 * dropped) -> pools ended, in that order.
 */
function createRuntime({ dbConfig, log, env = process.env, config } = {}) {
  const { createPool, createStore } = require("./store");
  const cfg = mergeConfig(readConfig(env), config);
  const logger = log || createLog();
  const pool = createPool(dbConfig, {
    queueLimit: cfg.db.queueLimit,
    acquireTimeoutMs: cfg.db.acquireTimeoutMs,
    connectTimeoutMs: cfg.db.acquireTimeoutMs,
  });
  const store = createStore(pool, { acquireTimeoutMs: cfg.db.acquireTimeoutMs, queryTimeoutMs: cfg.db.queryTimeoutMs });
  // One connection, one waiter: the monitor never has more than one probe
  // in flight. Every step is under the probe timeout, so a probe always
  // settles and the next one can be scheduled.
  const healthPool = createPool(dbConfig, {
    connectionLimit: 1,
    queueLimit: 1,
    acquireTimeoutMs: cfg.health.timeoutMs,
    connectTimeoutMs: cfg.health.timeoutMs,
  });
  const healthStore = createStore(healthPool, { acquireTimeoutMs: cfg.health.timeoutMs, queryTimeoutMs: cfg.health.timeoutMs });
  const receiver = createReceiver({ store, log: logger, health: healthStore, config: cfg });

  const statsTimer = setInterval(() => {
    try {
      logger.info("STATS", "receiver resource snapshot", receiver.stats());
    } catch (err) {
      /* a log line is never worth a crash */
    }
  }, cfg.statsIntervalMs);
  if (typeof statsTimer.unref === "function") statsTimer.unref();

  let stopped = null;
  function stop() {
    if (stopped) return stopped;
    clearInterval(statsTimer);
    stopped = (async () => {
      const housekeeping = await receiver.close({ serverTimeoutMs: 2500, housekeepingTimeoutMs: 1500 });
      await Promise.all([store.close({ timeoutMs: 500 }), healthStore.close({ timeoutMs: 500 })]);
      return { housekeeping };
    })();
    return stopped;
  }

  return { pool, healthPool, store, healthStore, receiver, stats: () => receiver.stats(), stop, config: cfg };
}

if (require.main === module) {
  main().catch((err) => {
    console.error("biomax-receiver failed to start:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { createReceiver, createRuntime, readConfig, rebuildFrame, assertRuntime, MIN_NODE_MAJOR, TESTED_NODE_MAJORS, DEFAULT_COMMAND_RESULT_MAX_BODY, HARD_COMMAND_RESULT_MAX_BODY };
