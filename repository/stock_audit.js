const { queryAsync, getConnectionAsync, beginTransactionAsync, commitAsync, rollbackAsync } = require("../utils/batchInsert");

/**
 * Stock Audit & Premier League - every SQL statement of the module.
 *
 * Reads RetailPilot data ONLY from the DNDS mirror tables (sa_rp_*), which
 * the sync fills; this file never talks to RetailPilot. Writes go to sa_*
 * tables only, plus wh_rp_staff_map (the RetailPilot user -> employee
 * mapping the warehouse screens already share). Timestamps come back as UTC
 * ISO strings with microseconds, never through a JS Date.
 */
const TS = (col, as = col.split(".").pop()) => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${as}`;
const CHUNK = 1000;
const chunks = (list, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (n) => new Array(n).fill("?").join(",");
const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);

class StockAuditRepository {
  constructor(db) {
    this.db = db;
  }

  q(sql, params = []) {
    return queryAsync(this.db, sql, params);
  }

  /** Runs fn(conn) in one transaction; everything or nothing. */
  async tx(fn) {
    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const out = await fn((sql, params = []) => queryAsync(conn, sql, params));
      await commitAsync(conn);
      return out;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------------------------------------------------------------- stores, people
  /** Every Branch Master outlet with a RetailPilot id (programme stores and the warehouse). */
  async rpOutlets() {
    const rows = await this.q(`SELECT outlet_id, outlet_name AS name, retailpilot_id AS rp_id FROM outlets WHERE retailpilot_id IS NOT NULL AND retailpilot_id <> ''`);
    return rows.map((r) => ({ outlet_id: Number(r.outlet_id), name: r.name, rp_id: r.rp_id }));
  }

  /** RetailPilot users seen by the module, with their mapping (shared wh_rp_staff_map). */
  async rpUsers() {
    return this.q(
      `SELECT u.rp_user_id, u.rp_name, u.last_rp_store_id, m.employee_id, e.employee_name, e.store_id AS employee_store_id,
              d.designation_name AS designation, m.updated_at AS mapped_at, ub.employee_name AS mapped_by_name
         FROM sa_rp_user u
         LEFT JOIN wh_rp_staff_map m ON m.rp_user_id = u.rp_user_id
         LEFT JOIN new_employee e ON e.employee_id = m.employee_id
         LEFT JOIN designation d ON d.designation_id = e.designation_id
         LEFT JOIN new_employee ub ON ub.employee_id = m.updated_by
        ORDER BY (m.employee_id IS NULL) DESC, u.rp_name, u.rp_user_id`
    );
  }

  async upsertRpUsers(list) {
    for (const part of chunks(list.filter((u) => u.rp_user_id))) {
      await this.q(
        `INSERT INTO sa_rp_user (rp_user_id, rp_name, last_rp_store_id) VALUES ${part.map(() => "(?, ?, ?)").join(",")}
         ON DUPLICATE KEY UPDATE rp_name = COALESCE(VALUES(rp_name), rp_name), last_rp_store_id = COALESCE(VALUES(last_rp_store_id), last_rp_store_id)`,
        part.flatMap((u) => [u.rp_user_id, u.rp_name || null, u.rp_store_id || null])
      );
    }
  }

  /** Map (or unmap, employee_id null) one RetailPilot user id - the same row the warehouse mapping screen edits. */
  async setStaffMap({ rp_user_id, employee_id, note, updated_by }) {
    await this.q(
      `INSERT INTO wh_rp_staff_map (rp_user_id, employee_id, note, updated_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id), note = VALUES(note), updated_by = VALUES(updated_by)`,
      [rp_user_id, employee_id, note || null, updated_by]
    );
  }

  /** Active employees of the given stores, to map RetailPilot users to. */
  async employeeChoices(outletIds) {
    if (!outletIds.length) return [];
    return this.q(
      `SELECT e.employee_id, e.employee_name, e.store_id, o.outlet_name AS store, d.designation_name AS designation
         FROM new_employee e
         LEFT JOIN outlets o ON o.outlet_id = e.store_id
         LEFT JOIN designation d ON d.designation_id = e.designation_id
        WHERE e.status = 1 AND e.store_id IN (${marks(outletIds.length)})
        ORDER BY e.employee_name, e.employee_id`,
      outletIds
    );
  }

  async employeeExists(employeeId) {
    const r = await this.q(`SELECT employee_id FROM new_employee WHERE employee_id = ? AND status = 1`, [employeeId]);
    return r.length > 0;
  }

  /** Mapped people: Map rp_user_id -> { employee_id, name, designation, store_id }. */
  async people() {
    const rows = await this.q(
      `SELECT m.rp_user_id, m.employee_id, e.employee_name, e.store_id, d.designation_name
         FROM wh_rp_staff_map m
         JOIN new_employee e ON e.employee_id = m.employee_id
         LEFT JOIN designation d ON d.designation_id = e.designation_id
        WHERE m.employee_id IS NOT NULL`
    );
    return new Map(rows.map((r) => [r.rp_user_id, { employee_id: Number(r.employee_id), name: r.employee_name, designation: r.designation_name, store_id: r.store_id == null ? null : Number(r.store_id) }]));
  }

  async rpNames() {
    const rows = await this.q(`SELECT rp_user_id, rp_name FROM sa_rp_user WHERE rp_name IS NOT NULL`);
    return new Map(rows.map((r) => [r.rp_user_id, r.rp_name]));
  }

  /** Active staff of the stores with their designation, to find each store's Supervisor / Store Manager. */
  async storeStaff(outletIds) {
    if (!outletIds.length) return [];
    const rows = await this.q(
      `SELECT e.employee_id, e.employee_name, e.store_id, d.designation_name
         FROM new_employee e LEFT JOIN designation d ON d.designation_id = e.designation_id
        WHERE e.status = 1 AND e.store_id IN (${marks(outletIds.length)})`,
      outletIds
    );
    return rows.map((r) => ({ employee_id: Number(r.employee_id), name: r.employee_name, outlet_id: Number(r.store_id), designation: r.designation_name || "" }));
  }

  // ---------------------------------------------------------------- cycles
  async periods() {
    const rows = await this.q(
      `SELECT period_code, MIN(name) AS name, MIN(start_date) AS start_date, MAX(end_date) AS end_date, MAX(deadline) AS deadline,
              GROUP_CONCAT(DISTINCT status) AS statuses, COUNT(*) AS stores
         FROM sa_cycle GROUP BY period_code ORDER BY MIN(start_date) DESC`
    );
    return rows.map((r) => ({ ...r, stores: Number(r.stores), start_date: dateStr(r.start_date), end_date: dateStr(r.end_date), deadline: dateStr(r.deadline) }));
  }

  async cycles(periodCode = null) {
    const rows = await this.q(
      `SELECT cycle_id, outlet_id, name, period_code, start_date, end_date, deadline, status, created_by
         FROM sa_cycle ${periodCode ? "WHERE period_code = ?" : ""} ORDER BY start_date DESC, outlet_id`,
      periodCode ? [periodCode] : []
    );
    return rows.map(cycleRow);
  }

  async cycle(cycleId) {
    const rows = await this.q(`SELECT cycle_id, outlet_id, name, period_code, start_date, end_date, deadline, status, created_by FROM sa_cycle WHERE cycle_id = ?`, [cycleId]);
    return rows.length ? cycleRow(rows[0]) : null;
  }

  /** One audit period for several stores at once; the unique keys refuse a duplicate. */
  async createPeriod({ period_code, name, start_date, end_date, deadline, outletIds, created_by }) {
    return this.tx(async (q) => {
      for (const o of outletIds) {
        await q(`INSERT INTO sa_cycle (outlet_id, name, period_code, start_date, end_date, deadline, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
          [o, name, period_code, start_date, end_date, deadline, created_by]);
      }
      return outletIds.length;
    });
  }

  async updatePeriod(periodCode, { name, end_date, deadline, status }) {
    const sets = [];
    const params = [];
    if (name != null) { sets.push("name = ?"); params.push(name); }
    if (end_date != null) { sets.push("end_date = ?"); params.push(end_date); }
    if (deadline != null) { sets.push("deadline = ?"); params.push(deadline); }
    if (status != null) { sets.push("status = ?"); params.push(status); }
    if (!sets.length) return 0;
    const r = await this.q(`UPDATE sa_cycle SET ${sets.join(", ")} WHERE period_code = ?`, [...params, periodCode]);
    return r.affectedRows;
  }

  // ---------------------------------------------------------------- allotment import
  /** Current (confirmed, not superseded) files of these cycles, with their auditable articles. */
  async currentAllotment(cycleIds) {
    if (!cycleIds.length) return [];
    const files = await this.q(
      `SELECT file_id, cycle_id, outlet_id, rp_store_id, rp_user_id, revision, content_sha1 FROM sa_allotment_file
        WHERE state = 'CURRENT' AND cycle_id IN (${marks(cycleIds.length)})`,
      cycleIds
    );
    const rows = await this.q(`SELECT cycle_id, rp_user_id, article_id FROM sa_allotment WHERE effective = 'Y' AND cycle_id IN (${marks(cycleIds.length)})`, cycleIds);
    const byKey = new Map();
    for (const r of rows) {
      const k = `${r.cycle_id}|${r.rp_user_id}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(Number(r.article_id));
    }
    return files.map((f) => ({ ...f, cycle_id: Number(f.cycle_id), file_id: Number(f.file_id), outlet_id: Number(f.outlet_id), revision: Number(f.revision), articles: byKey.get(`${f.cycle_id}|${f.rp_user_id}`) || [] }));
  }

  /** Stage a validated upload: batch + files + every line, nothing in sa_allotment yet. */
  async stageBatch({ period_code, created_by, summary, files }) {
    return this.tx(async (q) => {
      const b = await q(`INSERT INTO sa_allotment_batch (period_code, status, file_count, summary_json, created_by) VALUES (?, 'VALIDATED', ?, ?, ?)`,
        [period_code, files.length, JSON.stringify(summary), created_by]);
      const batchId = b.insertId;
      for (const f of files) {
        const r = await q(
          `INSERT INTO sa_allotment_file (batch_id, file_name, content_sha1, rp_store_id, outlet_id, cycle_id, rp_user_id, rp_user_name, employee_id,
             validation, auditable, not_auditable, line_errors, issues_json, diff_json, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAGED')`,
          [batchId, f.name.slice(0, 255), f.fp, f.store_id, f.outlet_id, f.cycle_id, f.auditor_id, f.auditor_name, f.employee_id, f.status,
            f.auditable, f.not_auditable, f.line_errors, JSON.stringify({ issues: f.issues, warnings: f.warnings, conflicts: f.conflicts || 0, match: f.match || null, revision: f.revision || null }),
            f.diff ? JSON.stringify(f.diff) : null]
        );
        const lines = f.lines.filter((l) => !l.errors.length);
        for (const part of chunks(lines)) {
          await q(`INSERT INTO sa_allotment_line (file_id, article_id, effective, article_name) VALUES ${part.map(() => "(?, ?, ?, ?)").join(",")}`,
            part.flatMap((l) => [r.insertId, Number(l.article_id), l.auditable ? "Y" : "N", (l.article || "").slice(0, 255) || null]));
        }
      }
      return batchId;
    });
  }

  async batch(batchId) {
    const b = await this.q(`SELECT batch_id, period_code, status, file_count, summary_json, created_by, confirmed_by, confirmed_at, created_at FROM sa_allotment_batch WHERE batch_id = ?`, [batchId]);
    if (!b.length) return null;
    const files = await this.q(
      `SELECT file_id, file_name, content_sha1, rp_store_id, outlet_id, cycle_id, rp_user_id, rp_user_name, employee_id, validation, auditable, not_auditable,
              line_errors, issues_json, revision, diff_json, state FROM sa_allotment_file WHERE batch_id = ? ORDER BY file_id`,
      [batchId]
    );
    return { ...b[0], summary: parse(b[0].summary_json), files: files.map((f) => ({ ...f, issues: parse(f.issues_json), diff: parse(f.diff_json) })) };
  }

  async batches(limit = 50) {
    const rows = await this.q(
      `SELECT b.batch_id, b.period_code, b.status, b.file_count, b.summary_json, b.created_at, b.confirmed_at, e.employee_name AS created_by_name,
              GROUP_CONCAT(DISTINCT o.outlet_name ORDER BY o.outlet_name SEPARATOR ', ') AS stores
         FROM sa_allotment_batch b
         LEFT JOIN sa_allotment_file f ON f.batch_id = b.batch_id
         LEFT JOIN outlets o ON o.outlet_id = f.outlet_id
         LEFT JOIN new_employee e ON e.employee_id = b.created_by
        GROUP BY b.batch_id ORDER BY b.batch_id DESC LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({ ...r, summary: parse(r.summary_json) }));
  }

  async discardBatch(batchId) {
    return this.tx(async (q) => {
      const r = await q(`UPDATE sa_allotment_batch SET status = 'DISCARDED' WHERE batch_id = ? AND status = 'VALIDATED'`, [batchId]);
      if (!r.affectedRows) return false;
      await q(`UPDATE sa_allotment_file SET state = 'DISCARDED' WHERE batch_id = ? AND state = 'STAGED'`, [batchId]);
      return true;
    });
  }

  /**
   * Confirm a staged batch in ONE transaction. For each importable file the
   * auditor's current revision is locked, superseded and replaced. Two
   * auditors holding one auditable article -> the unique key
   * uq_sa_allotment_auditable throws and NOTHING of the batch is applied.
   * @param expected Map file_id -> the content_sha1 of the current revision that validation saw (null = none)
   */
  async confirmBatch(batchId, confirmedBy, expected) {
    return this.tx(async (q) => {
      const b = await q(`SELECT status FROM sa_allotment_batch WHERE batch_id = ? FOR UPDATE`, [batchId]);
      if (!b.length) throw codeError(404, "Upload not found");
      if (b[0].status !== "VALIDATED") throw codeError(409, `This upload is already ${b[0].status.toLowerCase()}`);
      const files = await q(`SELECT file_id, cycle_id, outlet_id, rp_user_id, content_sha1, validation FROM sa_allotment_file WHERE batch_id = ? AND state = 'STAGED' ORDER BY file_id`, [batchId]);
      const importable = files.filter((f) => f.validation === "VALID" || f.validation === "WARNINGS");
      let applied = 0;
      for (const f of importable) {
        const cur = await q(`SELECT file_id, revision, content_sha1 FROM sa_allotment_file WHERE cycle_id = ? AND rp_user_id = ? AND state = 'CURRENT' FOR UPDATE`, [f.cycle_id, f.rp_user_id]);
        const seen = expected.has(Number(f.file_id)) ? expected.get(Number(f.file_id)) : null;
        const now = cur.length ? cur[0].content_sha1 : null;
        if (seen !== now) throw codeError(409, "The allotment changed since this upload was validated - validate again");
        const max = await q(`SELECT COALESCE(MAX(revision), 0) AS m FROM sa_allotment_file WHERE cycle_id = ? AND rp_user_id = ?`, [f.cycle_id, f.rp_user_id]);
        const revision = Number(max[0].m) + 1;
        if (cur.length) await q(`UPDATE sa_allotment_file SET state = 'SUPERSEDED' WHERE file_id = ?`, [cur[0].file_id]);
        await q(`DELETE FROM sa_allotment WHERE cycle_id = ? AND rp_user_id = ?`, [f.cycle_id, f.rp_user_id]);
        await q(
          `INSERT INTO sa_allotment (cycle_id, outlet_id, rp_user_id, article_id, effective, file_id)
           SELECT ?, ?, ?, l.article_id, l.effective, l.file_id FROM sa_allotment_line l WHERE l.file_id = ?`,
          [f.cycle_id, f.outlet_id, f.rp_user_id, f.file_id]
        );
        await q(`UPDATE sa_allotment_file SET state = 'CURRENT', revision = ? WHERE file_id = ?`, [revision, f.file_id]);
        applied += 1;
      }
      await q(`UPDATE sa_allotment_file SET state = 'DISCARDED' WHERE batch_id = ? AND state = 'STAGED'`, [batchId]);
      await q(`UPDATE sa_allotment_batch SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE batch_id = ?`, [confirmedBy, batchId]);
      return { applied };
    });
  }

  async allotmentRows(cycleIds) {
    if (!cycleIds.length) return [];
    const rows = await this.q(`SELECT cycle_id, rp_user_id, article_id, effective FROM sa_allotment WHERE cycle_id IN (${marks(cycleIds.length)})`, cycleIds);
    return rows.map((r) => ({ cycle_id: Number(r.cycle_id), rp_user_id: r.rp_user_id, article_id: Number(r.article_id), effective: r.effective }));
  }

  async allotmentCycles(cycleIds) {
    if (!cycleIds.length) return new Set();
    const rows = await this.q(`SELECT DISTINCT cycle_id FROM sa_allotment_file WHERE state = 'CURRENT' AND cycle_id IN (${marks(cycleIds.length)})`, cycleIds);
    return new Set(rows.map((r) => Number(r.cycle_id)));
  }

  /** Revision history of one auditor in one store cycle. */
  async revisions(cycleId, rpUserId) {
    return this.q(
      `SELECT f.file_id, f.batch_id, f.file_name, f.revision, f.state, f.auditable, f.not_auditable, f.diff_json, b.confirmed_at
         FROM sa_allotment_file f JOIN sa_allotment_batch b ON b.batch_id = f.batch_id
        WHERE f.cycle_id = ? AND f.rp_user_id = ? AND f.revision IS NOT NULL ORDER BY f.revision DESC`,
      [cycleId, rpUserId]
    );
  }

  // ---------------------------------------------------------------- mirrored audits
  /** Sessions of these outlets touching [fromUtc, toUtc) (finalize time, else start time). */
  async sessions(outletIds, fromUtc, toUtc) {
    if (!outletIds.length) return [];
    const rows = await this.q(
      `SELECT rp_slug, rp_store_id, outlet_id, article_id, status, initiated_by, finalized_by, var_qty, var_value, recount_slug,
              ${TS("started_at")}, ${TS("finalized_at")}
         FROM sa_rp_session
        WHERE outlet_id IN (${marks(outletIds.length)}) AND COALESCE(finalized_at, started_at) >= ? AND COALESCE(finalized_at, started_at) < ?`,
      [...outletIds, fromUtc, toUtc]
    );
    return rows.map((r) => ({ ...r, outlet_id: Number(r.outlet_id), article_id: Number(r.article_id), var_qty: r.var_qty == null ? null : Number(r.var_qty), var_value: r.var_value == null ? null : Number(r.var_value) }));
  }

  /** Counted quantities per session (sum of its count lines). */
  async countedBySession(slugs) {
    const out = new Map();
    for (const part of chunks(slugs)) {
      const rows = await this.q(`SELECT session_slug, SUM(counted_qty) AS counted, COUNT(*) AS n FROM sa_rp_line WHERE session_slug IN (${marks(part.length)}) GROUP BY session_slug`, part);
      for (const r of rows) out.set(r.session_slug, { counted: r.counted == null ? null : Number(r.counted), lines: Number(r.n) });
    }
    return out;
  }

  async articleNames(articleIds) {
    const out = new Map();
    for (const part of chunks(articleIds)) {
      const rows = await this.q(`SELECT article_id, MAX(article_name) AS name FROM sa_allotment_line l JOIN sa_allotment a ON a.file_id = l.file_id AND a.article_id = l.article_id WHERE l.article_id IN (${marks(part.length)}) GROUP BY article_id`, part);
      for (const r of rows) out.set(Number(r.article_id), r.name);
    }
    return out;
  }

  async verifications(cycleIds) {
    if (!cycleIds.length) return [];
    const rows = await this.q(
      `SELECT id, cycle_id, outlet_id, article_id, original_session_slug, recount_ref, original_user, recount_user, original_qty, recount_qty,
              ${TS("original_at")}, ${TS("recount_at")}, net_movement_qty, expected_qty, verdict, verdict_reason, review_status
         FROM sa_verification WHERE cycle_id IN (${marks(cycleIds.length)})`,
      cycleIds
    );
    return rows.map((r) => ({ ...r, cycle_id: Number(r.cycle_id), outlet_id: Number(r.outlet_id), article_id: Number(r.article_id) }));
  }

  async reviews(cycleIds) {
    if (!cycleIds.length) return new Map();
    const rows = await this.q(`SELECT cycle_id, outlet_id, article_id, review_decision, review_employee_id FROM sa_eligibility WHERE review_decision IS NOT NULL AND cycle_id IN (${marks(cycleIds.length)})`, cycleIds);
    return new Map(rows.map((r) => [`${r.cycle_id}|${r.outlet_id}|${r.article_id}`, { decision: r.review_decision, employee_id: r.review_employee_id == null ? null : Number(r.review_employee_id) }]));
  }

  /** Operations Manager's independent verification per store cycle (sa_approval entity store_verification). */
  async storeVerifications(cycleIds) {
    if (!cycleIds.length) return new Map();
    const rows = await this.q(`SELECT entity_id, decision FROM sa_approval WHERE entity = 'store_verification' AND level = 'OPERATIONS_MANAGER' AND entity_id IN (${marks(cycleIds.length)}) ORDER BY round DESC`, cycleIds);
    const out = new Map();
    for (const r of rows) if (!out.has(Number(r.entity_id))) out.set(Number(r.entity_id), r.decision === "APPROVED");
    return out;
  }

  async recordStoreVerification(cycleId, approverId, done, comment) {
    await this.q(
      `INSERT INTO sa_approval (entity, entity_id, level, round, approver_id, decision, comment) VALUES ('store_verification', ?, 'OPERATIONS_MANAGER', 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE approver_id = VALUES(approver_id), decision = VALUES(decision), comment = VALUES(comment), decided_at = CURRENT_TIMESTAMP`,
      [cycleId, approverId, done ? "APPROVED" : "REJECTED", comment || null]
    );
  }

  // ---------------------------------------------------------------- sync (mirror writes)
  async existingHashes(table, key, keys) {
    const out = new Map();
    for (const part of chunks(keys)) {
      const rows = await this.q(`SELECT ${key} AS k, row_hash FROM ${table} WHERE ${key} IN (${marks(part.length)})`, part);
      for (const r of rows) out.set(r.k, r.row_hash);
    }
    return out;
  }

  async _upsert(table, key, cols, rows) {
    if (!rows.length) return;
    const updates = cols.filter((c) => c !== key).map((c) => `${c} = VALUES(${c})`).join(", ");
    for (const part of chunks(rows, 500)) {
      await this.q(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${part.map(() => `(${marks(cols.length)})`).join(",")} ON DUPLICATE KEY UPDATE ${updates}`,
        part.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c])))
      );
    }
  }

  /** Upserts only new / changed rows. @returns { inserted, updated, unchanged } */
  async upsertMirror(kind, rows) {
    const spec = MIRROR[kind];
    const have = await this.existingHashes(spec.table, spec.key, rows.map((r) => r[spec.key]));
    const changed = rows.filter((r) => have.get(r[spec.key]) !== r.row_hash);
    await this._upsert(spec.table, spec.key, spec.cols, changed);
    const inserted = changed.filter((r) => !have.has(r[spec.key])).length;
    return { inserted, updated: changed.length - inserted, unchanged: rows.length - changed.length };
  }

  /** Booked difference of each session from its finalize marker. */
  async applyMarkers(markers) {
    for (const m of markers) {
      if (!m.session_slug || m.var_qty == null) continue;
      await this.q(`UPDATE sa_rp_session SET var_qty = ?, var_value = ? WHERE rp_slug = ? AND (marker_ledger_slug = ? OR marker_ledger_slug IS NULL)`,
        [m.var_qty, m.var_value, m.session_slug, m.rp_ledger_slug]);
    }
  }

  async markSessionsWithLines(slugs) {
    for (const part of chunks(slugs)) await this.q(`UPDATE sa_rp_session SET has_lines = 1 WHERE has_lines = 0 AND rp_slug IN (${marks(part.length)})`, part);
  }

  async syncState() {
    const rows = await this.q(`SELECT stream, ${TS("watermark_ts")}, watermark_slug, last_success_run FROM sa_sync_state`);
    return new Map(rows.map((r) => [r.stream, { ts: r.watermark_ts, slug: r.watermark_slug, run: r.last_success_run }]));
  }

  async setWatermarks(runId, cursors) {
    await this.tx(async (q) => {
      for (const [stream, c] of Object.entries(cursors)) {
        if (!c) continue;
        await q(`INSERT INTO sa_sync_state (stream, watermark_ts, watermark_slug, last_success_run) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE watermark_ts = VALUES(watermark_ts), watermark_slug = VALUES(watermark_slug), last_success_run = VALUES(last_success_run)`,
          [stream, c.ts_sql, c.slug, runId]);
      }
    });
  }

  async createRun({ kind, trigger, started_by, window }) {
    const r = await this.q(`INSERT INTO sa_sync_run (kind, run_trigger, started_by, status, window_json) VALUES (?, ?, ?, 'RUNNING', ?)`, [kind, trigger, started_by, JSON.stringify(window || {})]);
    return r.insertId;
  }

  async finishRun(runId, { status, counts, error, resume_after, issue_count }) {
    await this.q(`UPDATE sa_sync_run SET status = ?, counts_json = ?, error = ?, resume_after = ?, issue_count = ?, finished_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
      [status, JSON.stringify(counts || {}), error ? String(error).slice(0, 2000) : null, resume_after || null, issue_count || 0, runId]);
  }

  /** A run left RUNNING by a crash is not running: mark it failed so a new one can start. */
  async failStaleRuns(olderThanMinutes = 60) {
    await this.q(`UPDATE sa_sync_run SET status = 'FAILED', error = 'Interrupted (server restart)', finished_at = CURRENT_TIMESTAMP WHERE status = 'RUNNING' AND started_at < (CURRENT_TIMESTAMP - INTERVAL ? MINUTE)`, [olderThanMinutes]);
  }

  async addIssues(runId, issues) {
    const uniq = new Map();
    for (const i of issues) uniq.set(`${i.kind}|${i.rp_ref}`, i);
    for (const part of chunks([...uniq.values()], 500)) {
      await this.q(`INSERT IGNORE INTO sa_sync_issue (run_id, kind, rp_ref, detail) VALUES ${part.map(() => "(?, ?, ?, ?)").join(",")}`,
        part.flatMap((i) => [runId, i.kind, String(i.rp_ref).slice(0, 128), i.detail || null]));
    }
    return uniq.size;
  }

  async runs(limit = 30) {
    const rows = await this.q(`SELECT run_id, kind, run_trigger, started_by, status, resume_after, window_json, counts_json, issue_count, error, started_at, finished_at FROM sa_sync_run ORDER BY run_id DESC LIMIT ?`, [limit]);
    return rows.map((r) => ({ ...r, run_id: Number(r.run_id), window: parse(r.window_json), counts: parse(r.counts_json) }));
  }

  async issues(runId) {
    return this.q(`SELECT kind, rp_ref, detail, created_at FROM sa_sync_issue WHERE run_id = ? ORDER BY kind, rp_ref LIMIT 2000`, [runId]);
  }

  async lastSuccess() {
    const r = await this.q(`SELECT run_id, finished_at FROM sa_sync_run WHERE status = 'SUCCESS' AND kind <> 'DRY_RUN' ORDER BY run_id DESC LIMIT 1`);
    return r.length ? r[0] : null;
  }

  // ---------------------------------------------------------------- Premier League
  async seasons() {
    const rows = await this.q(`SELECT * FROM sa_sapl_season ORDER BY start_date DESC`);
    return rows.map(seasonRow);
  }

  async season(seasonId) {
    const rows = await this.q(`SELECT * FROM sa_sapl_season WHERE season_id = ?`, [seasonId]);
    return rows.length ? seasonRow(rows[0]) : null;
  }

  async createSeason({ name, period_code, start_date, deadline, prize_amount, rules, created_by }) {
    const r = await this.q(`INSERT INTO sa_sapl_season (name, period_code, start_date, deadline, prize_amount, rules_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      [name, period_code, start_date, deadline, prize_amount, JSON.stringify(rules), created_by]);
    return r.insertId;
  }

  async updateSeason(seasonId, fields) {
    const allowed = ["name", "deadline", "prize_amount", "rules_json", "status", "verified_by", "verified_at", "finalized_by", "finalized_at", "winner_outlet_id"];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return 0;
    const r = await this.q(`UPDATE sa_sapl_season SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE season_id = ?`, [...keys.map((k) => fields[k]), seasonId]);
    return r.affectedRows;
  }

  async saveStandings(seasonId, date, rows, isFinal) {
    await this.tx(async (q) => {
      for (const r of rows) {
        await q(
          `INSERT INTO sa_sapl_standing (season_id, standing_date, outlet_id, points_json, total_points, complete, rank_no, is_final) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE points_json = VALUES(points_json), total_points = VALUES(total_points), complete = VALUES(complete), rank_no = VALUES(rank_no), is_final = VALUES(is_final)`,
          [seasonId, date, r.outlet_id, JSON.stringify(r.rows), r.total, r.complete ? 1 : 0, r.rank, isFinal ? 1 : 0]
        );
      }
    });
  }

  /** The ranks of the latest standing BEFORE `date` (yesterday's movement). */
  async previousRanks(seasonId, date) {
    const rows = await this.q(
      `SELECT outlet_id, rank_no FROM sa_sapl_standing WHERE season_id = ? AND standing_date = (SELECT MAX(standing_date) FROM sa_sapl_standing WHERE season_id = ? AND standing_date < ?)`,
      [seasonId, seasonId, date]
    );
    return new Map(rows.map((r) => [Number(r.outlet_id), r.rank_no == null ? null : Number(r.rank_no)]));
  }

  async standingHistory(seasonId) {
    return this.q(`SELECT standing_date, outlet_id, total_points, rank_no, complete, is_final FROM sa_sapl_standing WHERE season_id = ? ORDER BY standing_date, rank_no`, [seasonId]);
  }

  async savePrizeShares(seasonId, outletId, method, shares, createdBy) {
    await this.tx(async (q) => {
      await q(`DELETE FROM sa_sapl_prize_share WHERE season_id = ? AND status = 'DRAFT'`, [seasonId]);
      for (const s of shares) {
        await q(`INSERT INTO sa_sapl_prize_share (season_id, employee_id, outlet_id, method, basis_json, amount, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
          [seasonId, s.employee_id, outletId, method, JSON.stringify(s.basis || null), s.amount, createdBy]);
      }
    });
  }

  async prizeShares(seasonId) {
    return this.q(`SELECT p.employee_id, e.employee_name, p.outlet_id, p.method, p.amount, p.status FROM sa_sapl_prize_share p LEFT JOIN new_employee e ON e.employee_id = p.employee_id WHERE p.season_id = ? ORDER BY p.amount DESC, p.employee_id`, [seasonId]);
  }

  // ---------------------------------------------------------------- policy
  async ruleSets() {
    return this.q(`SELECT version, status, note, supersedes, created_by, approved_by, approved_at, created_at FROM sa_rule_set ORDER BY version DESC`);
  }
}

const MIRROR = {
  session: {
    table: "sa_rp_session",
    key: "rp_slug",
    cols: ["rp_slug", "rp_store_id", "outlet_id", "article_id", "stock_location", "status", "initiated_by", "finalized_by", "started_at", "finalized_at",
      "rp_updated_at", "net_adj_action", "marker_ledger_slug", "recount_slug", "cancel_reason", "row_hash"],
  },
  line: {
    table: "sa_rp_line",
    key: "rp_slug",
    cols: ["rp_slug", "session_slug", "stock_location", "batch_id", "mrp", "counted_qty", "snapshot_qty", "snapshot_cells", "source", "holding_type", "status",
      "rp_created_at", "rp_updated_at", "row_hash"],
  },
  adjustment: {
    table: "sa_rp_adjustment",
    key: "rp_ledger_slug",
    cols: ["rp_ledger_slug", "session_slug", "is_marker", "rp_store_id", "article_id", "batch_id", "stock_location", "quantity", "net_landing_cost", "mrp",
      "traceability", "ts", "row_hash"],
  },
};

function dateStr(d) {
  if (d == null) return null;
  if (typeof d === "string") return d.slice(0, 10);
  // DATE columns come back as a local-midnight Date; format the local date
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cycleRow(r) {
  return { cycle_id: Number(r.cycle_id), outlet_id: Number(r.outlet_id), name: r.name, period_code: r.period_code, start_date: dateStr(r.start_date), end_date: dateStr(r.end_date), deadline: dateStr(r.deadline), status: r.status, created_by: r.created_by };
}

function seasonRow(r) {
  return { ...r, season_id: Number(r.season_id), start_date: dateStr(r.start_date), deadline: dateStr(r.deadline), prize_amount: Number(r.prize_amount), rules: parse(r.rules_json), winner_outlet_id: r.winner_outlet_id == null ? null : Number(r.winner_outlet_id) };
}

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = code;
  return e;
}

module.exports = (db) => new StockAuditRepository(db);
module.exports.MIRROR = MIRROR;
module.exports.codeError = codeError;
module.exports.dateStr = dateStr;
