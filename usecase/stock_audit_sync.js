/**
 * Stock Audit - RetailPilot -> DNDS mirror sync. READ-ONLY towards
 * RetailPilot: SELECTs through SPECTRA, nothing else.
 *
 *   HISTORICAL   everything from the programme start (25 Nov 2026 00:00 IST)
 *   INCREMENTAL  from each stream's watermark, minus a 30-minute overlap
 *   DRY_RUN      reads and counts, writes nothing
 *
 * NO SCHEDULE. A run starts only when someone with run_stock_audit_sync
 * presses the button (or a later, separately approved cron calls run()).
 *
 * Streams: count sessions, count lines, STK_ADJ ledger rows (for each
 * count's booked difference). Keyset paging on (updated_at | ts, slug),
 * microsecond-exact. Each stream's watermark advances ONLY when the whole
 * run succeeded; a failed or deferred run leaves every watermark as it was,
 * and the next run re-reads (upserts are idempotent by RetailPilot slug and
 * row hash).
 */
const { STREAMS, startCursor, toUtc } = require("../utils/stock_audit_queries");
const { sessionRow, lineRow, adjustmentRow, sessionIssues } = require("../utils/stock_audit_mirror");
const { DEFAULT_POLICY } = require("../utils/stock_audit_policy");

const KINDS = ["HISTORICAL", "INCREMENTAL", "DRY_RUN"];
const STALE_DAYS = 3;

class StockAuditSync {
  /**
   * @param spectra   services/retailpilot_spectra (configured with retry)
   * @param repo      repository/stock_audit
   * @param opts.since programme start (default policy.effectiveFrom)
   */
  constructor(spectra, repo, { since = DEFAULT_POLICY.effectiveFrom, now = () => new Date(), pageSize } = {}) {
    this.spectra = spectra;
    this.repo = repo;
    this.since = since;
    this.now = now;
    this.pageSize = pageSize;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  async run({ kind = "INCREMENTAL", trigger = "manual", startedBy = null } = {}) {
    if (!KINDS.includes(kind)) return { code: 400, message: `kind must be one of ${KINDS.join(", ")}` };
    if (!this.spectra.isConfigured()) return { code: 400, message: "RetailPilot is not configured" };
    if (this.running) return { code: 409, message: "A stock audit sync is already running" };
    this.running = true;
    let runId = null;
    const counts = {};
    const cursors = {};
    const issues = [];
    try {
      await this.repo.failStaleRuns();
      const outlets = await this.repo.rpOutlets();
      const outletOfRp = new Map(outlets.map((o) => [o.rp_id, o.outlet_id]));
      const people = await this.repo.people();
      const state = kind === "HISTORICAL" ? new Map() : await this.repo.syncState();
      const dry = kind === "DRY_RUN";
      const window = {};
      for (const stream of Object.keys(STREAMS)) {
        window[stream] = startCursor(state.get(stream), { since: this.since });
      }
      runId = await this.repo.createRun({ kind, trigger, started_by: startedBy, window });
      const staleBefore = toUtc(new Date(this.now().getTime() - STALE_DAYS * 86400000).toISOString()).sql;
      const seenUsers = new Map();

      for (const stream of ["session", "line", "adjustment"]) {
        const spec = STREAMS[stream];
        const c = { pages: 0, read: 0, inserted: 0, updated: 0, unchanged: 0 };
        const res = await this.spectra.queryKeyset(
          (cursor, size) => spec.build(cursor, size),
          window[stream],
          spec.cursorOf,
          async (rows) => {
            c.pages += 1;
            c.read += rows.length;
            if (!rows.length) return;
            let mapped;
            if (stream === "session") {
              mapped = rows.map((r) => sessionRow(r, (rp) => (outletOfRp.has(rp) ? outletOfRp.get(rp) : null)));
              for (const s of mapped) {
                for (const u of [s.initiated_by, s.finalized_by]) if (u && !seenUsers.has(u)) seenUsers.set(u, s.rp_store_id);
              }
              issues.push(...sessionIssues(mapped, { isMappedUser: (u) => people.has(u), isMappedStore: (rp) => outletOfRp.has(rp), staleBefore }));
            } else if (stream === "line") mapped = rows.map(lineRow);
            else mapped = rows.map(adjustmentRow);
            if (dry) return;
            const r = await this.repo.upsertMirror(stream, mapped);
            c.inserted += r.inserted;
            c.updated += r.updated;
            c.unchanged += r.unchanged;
            if (stream === "line") await this.repo.markSessionsWithLines([...new Set(mapped.map((l) => l.session_slug))]);
            if (stream === "adjustment") await this.repo.applyMarkers(mapped.filter((a) => a.is_marker));
          },
          { size: this.pageSize }
        );
        counts[stream] = c;
        cursors[stream] = res.cursor ? { ts_sql: toUtc(res.cursor.ts).sql, slug: res.cursor.slug } : null;
      }

      if (!dry) await this.repo.upsertRpUsers([...seenUsers].map(([rp_user_id, rp_store_id]) => ({ rp_user_id, rp_store_id })));
      const issueCount = await this.repo.addIssues(runId, issues);
      if (!dry) await this.repo.setWatermarks(runId, cursors);
      await this.repo.finishRun(runId, { status: "SUCCESS", counts, issue_count: issueCount });
      return { code: 200, run_id: runId, kind, counts, issues: issueCount };
    } catch (err) {
      const deferred = Boolean(err && err.deferred);
      const resumeAfter = deferred && err.retryAfterSec ? toUtc(new Date(this.now().getTime() + err.retryAfterSec * 1000).toISOString()).sql.slice(0, 19) : null;
      // never store request details: the message only
      const message = `${err && err.status ? `HTTP ${err.status}: ` : ""}${(err && err.message) || "sync failed"}; watermark unchanged`;
      if (runId) await this.repo.finishRun(runId, { status: deferred ? "DEFERRED" : "FAILED", counts, error: message, resume_after: resumeAfter, issue_count: 0 }).catch(() => {});
      return { code: deferred ? 503 : 500, run_id: runId, message, deferred, resume_after: resumeAfter };
    } finally {
      this.running = false;
    }
  }

  /** Start without waiting (the route returns at once; the run is logged in sa_sync_run). */
  start(args) {
    if (this.running) return { started: false, msg: "A stock audit sync is already running" };
    this.run(args).catch(() => {});
    return { started: true, msg: `${args.kind || "INCREMENTAL"} sync started` };
  }
}

module.exports = (spectra, repo, opts) => new StockAuditSync(spectra, repo, opts);
module.exports.KINDS = KINDS;
