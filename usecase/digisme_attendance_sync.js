/**
 * DigiSME attendance API sync - the automated replacement for the manual
 * Excel upload, on the SAME ingest path.
 *
 * WHY THIS EXISTS. The Excel workflow failed silently: 11-14 Sep 2026 were
 * never uploaded, attendance recalculation read the missing punches as real
 * absence, and roughly 208 phantom absences a day were produced until
 * somebody noticed. Nothing in this file may be able to fail that quietly -
 * hence the metrics every run records and the two loud conditions below.
 *
 * WHAT IT DOES NOT DO. It does not insert punches itself. Every punch goes
 * through `usecase/attendance_import.js` -> `biomax/store.js insertPunch`,
 * the same code path, the same tables and the same dedup as an Excel import
 * and a live device punch. There is exactly one attendance insertion
 * implementation and this is not it.
 *
 *   ingest_source   DIGISME_IMPORT for Excel AND API alike. The unique
 *                   `import_dedup_key` is CONCAT(ingest_source,'|',user_id,
 *                   '|',io_time_raw), so sharing the value is what stops the
 *                   same real punch existing once from each route. A
 *                   DIGISME_API value here would CREATE that duplicate.
 *   source_type     DIGISME_API_PULL on the batch. That is where the two
 *                   routes are told apart - an audit dimension with no dedup,
 *                   calculation or label consumer.
 *
 * TWO JOBS, ONE VENDOR BUDGET.
 *
 *   live        every minute, TODAY only. Fetches the whole current day, not
 *               a delta, so any minute missed to a restart, a deploy or a
 *               vendor blip is recovered by the next successful poll. Today
 *               therefore never needs the recovery job.
 *   historical  four times a day, today-3 / today-2 / yesterday, each its own
 *               try/catch so one bad date cannot hide the other two. This is
 *               for vendor-delayed records, not for today.
 *
 * Both share the ONE throttle queue in services/digisme_attendance.js, which
 * is what keeps total traffic under the vendor's 5 calls/minute however the
 * two interleave. Neither job reasons about the rate limit and neither
 * should. They do not lock against each other: their date ranges are
 * disjoint, so they cannot return the same punch, and the database settles it
 * even if that were ever wrong. Each guards only against ITSELF re-entering.
 *
 * NOTHING HERE RECALCULATES ATTENDANCE. The Excel commit path does not
 * either. Recalculating a date from inside a sync that has not finished
 * fetching its window would recalculate against knowingly incomplete punch
 * data - which is the exact failure this integration exists to end.
 */

const logger = require("../utils/logger");
const { INGEST_SOURCE } = require("../biomax/store");

const COMPONENT = "USECASE.DIGISME_ATTENDANCE_SYNC";

/** Batch `source_type` for a row this sync created. Excel keeps DIGISME_ATD_DAILY. */
const API_SOURCE_TYPE = "DIGISME_API_PULL";

/* ------------------------------------------------------- monitoring rules */

/**
 * The monitoring window, IST. Stores run about 09:00-22:00; the window opens
 * a full hour after that so an empty dataset during the first punches of the
 * morning is never an alert, and closes at 22:00 so a quiet night is never
 * one either. Deliberately blunt: there is no company-wide holiday calendar
 * in this schema (`work_shift_weekly_schedule.is_working_day` is per SHIFT),
 * and with 208 staff a genuine zero inside this window is always an incident.
 */
const ALERT_WINDOW_START_HOUR = 10;
const ALERT_WINDOW_END_HOUR = 22;

/** Consecutive zero-row current-day polls before the feed is called missing. */
const ZERO_POLL_ALERT_STREAK = 15;

/**
 * How long the vendor's own latest punch may fail to advance, inside the
 * window, before the feed is called stale.
 *
 * 90 minutes is deliberately loose. Punches cluster at shift boundaries, so a
 * genuinely quiet mid-afternoon can plausibly run 45-60 minutes with nobody
 * clocking. Starting loose and tightening once we have a fortnight of real
 * `latest_vendor_punch_ts` behaviour is the right order: an alert nobody
 * trusts is worse than one that arrives half an hour late.
 */
const STALE_FEED_MINUTES = 90;

/** One alert per condition per hour. A per-minute poll must not spam Telegram. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/** Persist a log row every Nth minute even when a run is entirely quiet. */
const HEARTBEAT_EVERY_MINUTES = 15;

/* ----------------------------------------------------------------- dates */

const pad = (n) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' for a Date, read in IST. */
function istDateString(date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

/** Whole IST hour (0-23) of an instant. */
function istHour(date) {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

/** IST minute-of-hour, for the heartbeat. */
function istMinute(date) {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).getUTCMinutes();
}

function addDaysIso(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 14-digit io_time_raw -> epoch ms, read as the IST wall clock it is. */
function rawToMs(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(raw || ""));
  if (!m) return null;
  return (
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 5.5 * 60 * 60 * 1000
  );
}

/* ------------------------------------------------------------ credentials */

/**
 * Message-only error text.
 *
 * An axios error carries `config.headers`, which on a DigiSME call holds
 * `Authorization: <DIGISME_API_KEY>` and `customKey: <DIGISME_CUSTOM_KEY>`.
 * Anything that stringifies the ERROR OBJECT - `JSON.stringify(err)`,
 * `util.inspect(err)`, logging `err.config` - writes both credentials into
 * `api_sync_log.error_message` and into the application log, where they are
 * durable and searchable. Every error that leaves this file goes through
 * here, and nothing in this file ever touches `err.config` or `err.request`.
 */
function safeError(err) {
  if (!err) return "unknown error";
  const status = err.response && err.response.status;
  const message = String((err && err.message) || err).slice(0, 400);
  return status ? `HTTP ${status}: ${message}` : message;
}

class DigismeAttendanceSyncUsecase {
  /**
   * @param {object} deps
   * @param {object} deps.client   services/digisme_attendance (fetchRawAttendance)
   * @param {object} deps.repo     repository/attendance_import
   * @param {object} deps.store    biomax/store createStore(pool)
   * @param {object} deps.importUsecase  usecase/attendance_import - the
   *   resolver and the insert path are reused from it, never reimplemented
   * @param {object} [deps.apiSyncLogger] utils/api_sync_logger
   * @param {object} [deps.alerter] { sendMessage } - services/telegram
   * @param {function} [deps.now] clock, for tests
   */
  constructor(deps = {}) {
    this.client = deps.client;
    this.repo = deps.repo;
    this.store = deps.store;
    this.importUsecase = deps.importUsecase;
    this.apiSyncLogger = deps.apiSyncLogger || null;
    this.alerter = deps.alerter || null;
    this.now = deps.now || (() => new Date());

    /* Re-entrancy guards. A tick that arrives while the previous run of the
     * SAME job is still in flight is SKIPPED, not queued: piling minute on
     * minute behind a slow vendor is how a backlog becomes an outage. */
    this.liveRunning = false;
    this.historicalRunning = false;

    /* Monitoring state, in memory on purpose. A restart means the app was
     * down, which is separately visible, and the first poll after it
     * re-establishes the baseline from the vendor's own dataset. No new
     * monitoring table for this. */
    this.state = {
      consecutive_zero_polls: 0,
      consecutive_failures: 0,
      last_successful_fetch_at: null,
      last_nonempty_dataset_at: null,
      latest_vendor_punch_ts: null,
      last_alert_at: {},
    };
  }

  /* ------------------------------------------------------------- alerting */

  /** One alert per key per ALERT_COOLDOWN_MS, whatever the poll rate. */
  async _alert(key, message) {
    const nowMs = this.now().getTime();
    const last = this.state.last_alert_at[key];
    if (last && nowMs - last < ALERT_COOLDOWN_MS) return false;
    this.state.last_alert_at[key] = nowMs;
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: COMPONENT,
      code: `${COMPONENT}.ALERT.${key}`,
      description: message,
      category: "",
      ref: {},
    });
    if (this.alerter && typeof this.alerter.sendMessage === "function") {
      try {
        await this.alerter.sendMessage(message);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: COMPONENT,
          code: `${COMPONENT}.ALERT_FAILED`,
          description: safeError(err),
          category: "",
          ref: { key },
        });
      }
    }
    return true;
  }

  /* ----------------------------------------------------------- one date */

  /**
   * Fetch one date and store only what is genuinely new.
   *
   *   fetch -> client dedup -> existingImportKeys pre-filter -> lazy batch
   *   -> insertPunch (the shared path) -> DB unique key has the last word
   *
   * THE PRE-FILTER IS AN OPTIMISATION, NOT THE GUARANTEE. Without it the
   * live job would stage the WHOLE current day every minute: by 22:00 that is
   * ~525 candidate rows a poll, 1,440 polls a day, ~756,000
   * biomax_attendance_import_item rows to describe 525 real punches - and an
   * Import screen showing nothing but empty API batches. With it, staging is
   * proportional to what actually arrived. Anything the pre-filter misses -
   * a punch inserted between the read and the write, a race with the
   * recovery job - still hits the UNIQUE `import_dedup_key` and is counted
   * as a duplicate, exactly as a re-imported Excel row is.
   *
   * @returns {object} the metrics for this date
   */
  async syncDate(dateIso, { expectPunches } = {}) {
    const startedAt = Date.now();
    const m = {
      attendance_date: dateIso,
      api_ok: false,
      vendor_row_count: 0,
      client_deduped_count: 0,
      new_candidate_count: 0,
      inserted_count: 0,
      duplicate_count: 0,
      rejected_count: 0,
      latest_vendor_punch_ts: null,
      stored_punch_count: null,
      latest_stored_punch_ts: null,
      import_batch_id: null,
      duration_ms: 0,
      error: null,
    };

    let punches;
    try {
      // fetchRawAttendance already: throttles through the shared queue,
      // refreshes a 401 once, normalises, and collapses the vendor's
      // byte-identical double-send. None of that is reimplemented here.
      punches = await this.client.fetchRawAttendance(dateIso, dateIso);
      m.api_ok = true;
    } catch (err) {
      m.error = safeError(err);
      m.duration_ms = Date.now() - startedAt;
      return m;
    }

    m.client_deduped_count = punches.length;
    // What the vendor sent, as the client counted it - not `length * 2`.
    // The byte-identical double-send is an observation, not a guarantee.
    m.vendor_row_count =
      punches.vendor_row_count === undefined ? punches.length : punches.vendor_row_count;
    m.rejected_count = punches.unparseable_count || 0;
    for (const p of punches) {
      if (!m.latest_vendor_punch_ts || p.io_time_raw > m.latest_vendor_punch_ts) {
        m.latest_vendor_punch_ts = p.io_time_raw;
      }
    }

    if (punches.length) {
      const raws = punches.map((p) => p.io_time_raw).sort();
      const codes = [...new Set(punches.map((p) => p.user_id))];
      const existing = await this.repo.existingImportKeys(codes, raws[0], raws[raws.length - 1]);
      const fresh = punches.filter((p) => !existing.has(`${p.user_id}|${p.io_time_raw}`));
      m.new_candidate_count = fresh.length;
      m.duplicate_count = punches.length - fresh.length;

      if (fresh.length) {
        const committed = await this._commitNewPunches(dateIso, fresh);
        m.import_batch_id = committed.import_batch_id;
        m.inserted_count = committed.inserted;
        m.duplicate_count += committed.duplicate;
        m.rejected_count += committed.failed;
      }
    }

    try {
      const stored = await this.repo.storedForDate(dateIso);
      m.stored_punch_count = stored.count;
      m.latest_stored_punch_ts = stored.latest_io_time_raw;
    } catch (err) {
      // Monitoring must never fail an otherwise good sync.
      m.stored_punch_count = null;
    }

    // A COMPLETED operating day with no punches at all is not a quiet day,
    // it is a missing feed - the 11-14 Sep failure, seen from the other side.
    if (expectPunches && m.api_ok && m.vendor_row_count === 0) {
      m.error = `DigiSME returned ZERO punches for ${dateIso}`;
    }

    m.duration_ms = Date.now() - startedAt;
    return m;
  }

  /**
   * Create the batch, stage only the new punches, and commit them through the
   * shared insert path. Called ONLY when there is something to write - a run
   * that found nothing new creates no batch and no items at all.
   */
  async _commitNewPunches(dateIso, fresh) {
    const resolver = this.importUsecase._resolver();
    const resolved = [];
    for (const p of fresh) {
      resolved.push({ punch: p, r: await resolver.derive(p.user_id, p.io_time_raw) });
    }

    const batchId = await this.repo.transaction("API-SYNC-BATCH", async (conn) => {
      const id = await this.repo.insertBatch(conn, {
        source_type: API_SOURCE_TYPE,
        // The batch table is Excel-shaped because Excel came first. These
        // are the honest API equivalents, not invented filenames: the
        // "file" is one GetRawAttendance response for one date.
        original_filename: `GetRawAttendance ${dateIso}`,
        file_sha256: this._responseHash(fresh),
        file_size_bytes: 0,
        sheet_name: "GetRawAttendance",
        time_columns: null,
        uploaded_by: null,
        excel_row_count: fresh.length,
        employee_code_count: new Set(fresh.map((p) => p.user_id)).size,
        candidate_count: fresh.length,
        valid_count: fresh.length,
        bad_count: 0,
        unmatched_count: 0,
        reimport_duplicate_count: 0,
        cross_source_collision_count: 0,
        date_from: dateIso,
        date_to: dateIso,
      });
      await this.repo.insertItems(
        conn,
        id,
        resolved.map(({ punch, r }, i) => ({
          excel_row: i + 1,
          column_name: null,
          raw_employee_code: punch.user_id,
          raw_clock_date: dateIso,
          raw_clock_time: punch.io_time ? punch.io_time.slice(11) : null,
          user_id: punch.user_id,
          io_time_raw: punch.io_time_raw,
          employee_id: r.employee ? r.employee.employee_id : null,
          classification: r.employee ? "VALID" : "UNMATCHED_EMPLOYEE",
          derivation_status: r.derived.status,
          attendance_date: r.derived.attendance_date,
          collided_punch_id: null,
          message: r.employee ? null : "Employee Code is not in the employee master",
        }))
      );
      return id;
    });

    const tally = { inserted: 0, duplicate: 0, failed: 0, import_batch_id: batchId };
    const items = await this.repo.itemsForCommit(batchId);
    const byKey = new Map(resolved.map(({ punch, r }) => [`${punch.user_id}|${punch.io_time_raw}`, { punch, r }]));

    for (const it of items) {
      const hit = byKey.get(`${it.user_id}|${it.io_time_raw}`);
      if (!hit) continue;
      let outcome;
      let punchId = null;
      let message = null;
      try {
        const res = await this.store.insertPunch(
          { user_id: it.user_id, io_time_raw: it.io_time_raw, raw_json: hit.punch.raw_json },
          hit.r.derived,
          { source: INGEST_SOURCE.DIGISME_IMPORT, importBatchId: batchId }
        );
        punchId = res.biomax_punch_id;
        if (res.outcome === "duplicate") {
          // The pre-filter missed one: a concurrent write, or a punch that
          // arrived between the read and here. The database had the last
          // word, which is the design.
          outcome = "SKIPPED_REIMPORT_DUPLICATE";
          message = "already imported (database dedup)";
          tally.duplicate += 1;
        } else if (hit.r.derived.employee_id === null) {
          outcome = "IMPORTED_UNMATCHED";
          tally.inserted += 1;
        } else {
          outcome = "IMPORTED";
          tally.inserted += 1;
        }
      } catch (err) {
        outcome = "FAILED";
        message = safeError(err).slice(0, 255);
        tally.failed += 1;
      }
      await this.repo.updateItemOutcome(it.import_item_id, {
        outcome,
        biomax_punch_id: punchId,
        message,
        collided_punch_id: null,
      });
    }

    await this.repo.finishBatch(batchId, {
      status: tally.failed > 0 ? "COMMITTED_WITH_ERRORS" : "COMMITTED",
      imported_count: tally.inserted,
      skipped_count: tally.duplicate,
      failed_count: tally.failed,
      error_message: null,
    });
    return tally;
  }

  /** A stable fingerprint of what this batch carried, for the audit column. */
  _responseHash(punches) {
    const crypto = require("crypto");
    const canonical = punches
      .map((p) => `${p.user_id}|${p.io_time_raw}`)
      .sort()
      .join(",");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /* -------------------------------------------------------------- the jobs */

  /**
   * Every minute, today only.
   *
   * Returns a payload `wrapCron`/`isSuccess` can read: a `code` other than
   * 200 is logged as a failure. A quiet minute is a SUCCESS - `vendor_row_
   * count` in the hundreds with `inserted_count` zero is the normal steady
   * state once everyone who is coming has arrived, and alerting on it would
   * train everyone to ignore the channel.
   */
  async runLive() {
    if (this.liveRunning) {
      logger.Log({
        level: logger.LEVEL.WARN,
        component: COMPONENT,
        code: `${COMPONENT}.LIVE_SKIPPED`,
        description: "previous live run still in flight; this tick is skipped",
        category: "",
        ref: {},
      });
      return { code: 200, skipped: true, reason: "previous run still in flight" };
    }
    this.liveRunning = true;
    const now = this.now();
    const today = istDateString(now);
    try {
      const m = await this.syncDate(today);
      await this._updateStateAndAlert(m, now);

      const result = {
        code: m.error ? 500 : 200,
        message: m.error || undefined,
        job: "live",
        ...m,
        consecutive_zero_polls: this.state.consecutive_zero_polls,
        consecutive_failures: this.state.consecutive_failures,
        last_successful_fetch_at: this.state.last_successful_fetch_at,
        last_nonempty_dataset_at: this.state.last_nonempty_dataset_at,
      };

      // Every run tells the application log what it saw. Only some runs
      // earn a row in api_sync_log - see _shouldPersist.
      logger.Log({
        level: m.error ? logger.LEVEL.ERROR : logger.LEVEL.INFO,
        component: COMPONENT,
        code: `${COMPONENT}.LIVE`,
        description:
          `${today}: vendor=${m.vendor_row_count} deduped=${m.client_deduped_count} ` +
          `new=${m.new_candidate_count} inserted=${m.inserted_count} duplicate=${m.duplicate_count} ` +
          `rejected=${m.rejected_count} latest_vendor=${m.latest_vendor_punch_ts || "none"} ` +
          `stored=${m.stored_punch_count}`,
        category: "",
        ref: { attendance_date: today },
      });

      if (this._shouldPersist(m, now)) await this._persist("digisme_attendance_live", result);
      return result;
    } catch (err) {
      const message = safeError(err);
      await this._persist("digisme_attendance_live", { code: 500, message, job: "live" });
      return { code: 500, message, job: "live" };
    } finally {
      this.liveRunning = false;
    }
  }

  /**
   * Four times a day: today-3, today-2, yesterday.
   *
   * TODAY IS NOT IN THIS WINDOW. The live job re-fetches the whole current
   * day every minute, so today is already self-healing; re-reading it here
   * would spend vendor calls on nothing. Each date gets its own try/catch so
   * one failure cannot hide the other two, and a completed operating day that
   * comes back empty is loud.
   */
  async runHistorical() {
    if (this.historicalRunning) {
      return { code: 200, skipped: true, reason: "previous recovery run still in flight" };
    }
    this.historicalRunning = true;
    const today = istDateString(this.now());
    const dates = [addDaysIso(today, -3), addDaysIso(today, -2), addDaysIso(today, -1)];
    const results = [];
    try {
      for (const d of dates) {
        try {
          results.push(await this.syncDate(d, { expectPunches: true }));
        } catch (err) {
          results.push({ attendance_date: d, api_ok: false, error: safeError(err) });
        }
      }
      const failed = results.filter((r) => r.error);
      for (const r of failed) {
        await this._alert(
          `historical_${r.attendance_date}`,
          `⚠️ DIGISME ATTENDANCE RECOVERY\n${r.attendance_date}: ${r.error}`
        );
      }
      const payload = {
        code: failed.length ? 500 : 200,
        message: failed.length
          ? `${failed.length} of ${dates.length} dates failed: ${failed.map((r) => r.attendance_date).join(", ")}`
          : undefined,
        job: "historical",
        dates: results,
        inserted_count: results.reduce((a, r) => a + (r.inserted_count || 0), 0),
        duplicate_count: results.reduce((a, r) => a + (r.duplicate_count || 0), 0),
      };
      await this._persist("digisme_attendance_recovery", payload);
      return payload;
    } finally {
      this.historicalRunning = false;
    }
  }

  /* --------------------------------------------------------- monitoring */

  async _updateStateAndAlert(m, now) {
    if (m.api_ok) {
      this.state.consecutive_failures = 0;
      this.state.last_successful_fetch_at = now.toISOString();
    } else {
      this.state.consecutive_failures += 1;
      if (this.state.consecutive_failures >= 5) {
        await this._alert(
          "api_failing",
          `⚠️ DIGISME ATTENDANCE API\n${this.state.consecutive_failures} consecutive failures.\nLast error: ${m.error}`
        );
      }
      return;
    }

    if (m.vendor_row_count > 0) {
      this.state.consecutive_zero_polls = 0;
      this.state.last_nonempty_dataset_at = now.toISOString();
      if (m.latest_vendor_punch_ts) this.state.latest_vendor_punch_ts = m.latest_vendor_punch_ts;
    } else {
      this.state.consecutive_zero_polls += 1;
    }

    if (!this._inAlertWindow(now)) return;

    // B: the vendor's whole current-day dataset is empty, and has been for
    // long enough that a blip is ruled out.
    if (this.state.consecutive_zero_polls >= ZERO_POLL_ALERT_STREAK) {
      await this._alert(
        "zero_dataset",
        `🚨 DIGISME ATTENDANCE: NO PUNCHES\n${m.attendance_date} has returned an EMPTY dataset for ` +
          `${this.state.consecutive_zero_polls} consecutive minutes during operating hours.\n` +
          `The API is responding; the data is not there. Check DigiSME before attendance is recalculated.`
      );
      return;
    }

    // The quieter failure: the API answers, the dataset is non-empty, and
    // yet nothing new has happened for far too long. "Zero new inserts" is
    // meaningless at one-minute granularity - several quiet minutes are
    // normal - so the signal is whether the VENDOR'S OWN latest punch is
    // advancing.
    const latestMs = rawToMs(this.state.latest_vendor_punch_ts);
    if (latestMs !== null) {
      const staleMinutes = Math.floor((now.getTime() - latestMs) / 60000);
      if (staleMinutes >= STALE_FEED_MINUTES) {
        await this._alert(
          "stale_feed",
          `⚠️ DIGISME ATTENDANCE: FEED NOT ADVANCING\nThe API is returning success, but the latest ` +
            `punch in ${m.attendance_date} is ${staleMinutes} minutes old ` +
            `(threshold ${STALE_FEED_MINUTES}).\nVendor rows: ${m.vendor_row_count}. Stored: ${m.stored_punch_count}.`
        );
      }
    }
  }

  _inAlertWindow(now) {
    const h = istHour(now);
    return h >= ALERT_WINDOW_START_HOUR && h < ALERT_WINDOW_END_HOUR;
  }

  /**
   * Which of the 1,440 daily live runs earn a durable row.
   *
   * Writing one per run would put ~525,000 rows a year in api_sync_log and
   * bury every other sync on the operator's screen behind identical
   * "0 inserted" lines. So: anything that actually happened, anything that
   * went wrong, and a heartbeat every quarter hour that carries the full
   * metric set regardless - which is what keeps the stale-feed signal
   * queryable after the fact.
   */
  _shouldPersist(m, now) {
    if (m.inserted_count > 0) return true;
    if (m.error || !m.api_ok) return true;
    if (m.rejected_count > 0) return true;
    // An empty dataset is only worth a durable row when it is SURPRISING.
    // Gating this on the alert window matters: outside opening hours every
    // one of the ~540 overnight polls returns zero rows quite correctly, and
    // persisting each would put back most of the 1,440 rows a day this
    // method exists to avoid.
    if (this.state.consecutive_zero_polls > 0 && this._inAlertWindow(now)) return true;
    return istMinute(now) % HEARTBEAT_EVERY_MINUTES === 0;
  }

  /** One api_sync_log row, in the same shape every other sync writes. */
  async _persist(logType, payload) {
    if (!this.apiSyncLogger) return;
    const failed = !(payload.code === undefined || payload.code === 200);
    await this.apiSyncLogger.write({
      log_type: logType,
      method: "POST",
      path: `/attendance/digisme/${logType === "digisme_attendance_live" ? "live" : "recovery"}`,
      status: failed ? "failed" : "success",
      status_code: payload.code || 200,
      duration_ms: payload.duration_ms || null,
      row_count: payload.inserted_count || 0,
      source: "cron",
      employee_id: null,
      metadata_json: payload,
      error_message: payload.message ? String(payload.message).slice(0, 512) : null,
    });
  }
}

module.exports = (deps) => new DigismeAttendanceSyncUsecase(deps);
module.exports.DigismeAttendanceSyncUsecase = DigismeAttendanceSyncUsecase;
module.exports.API_SOURCE_TYPE = API_SOURCE_TYPE;
module.exports.ZERO_POLL_ALERT_STREAK = ZERO_POLL_ALERT_STREAK;
module.exports.STALE_FEED_MINUTES = STALE_FEED_MINUTES;
module.exports.ALERT_COOLDOWN_MS = ALERT_COOLDOWN_MS;
module.exports.HEARTBEAT_EVERY_MINUTES = HEARTBEAT_EVERY_MINUTES;
module.exports.ALERT_WINDOW_START_HOUR = ALERT_WINDOW_START_HOUR;
module.exports.ALERT_WINDOW_END_HOUR = ALERT_WINDOW_END_HOUR;
module.exports.istDateString = istDateString;
module.exports.addDaysIso = addDaysIso;
module.exports.safeError = safeError;
