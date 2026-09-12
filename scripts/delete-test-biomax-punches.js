#!/usr/bin/env node
/**
 * Deletes TEST punches from `biomax_punch` / `biomax_punch_derived`.
 *
 * These two tables are otherwise append-only (see repository/biomax_punch.js
 * and docs/biomax-attendance-part1.md, receiver activation step 3): the only
 * sanctioned delete is removing rows produced by a smoke test or a device
 * trial. This script is that delete, made explicit and reviewable.
 *
 * Selection is by CALENDAR date (`biomax_punch.punch_date`, the date the
 * device stamped), optionally narrowed by device and/or employee code.
 * Rows are listed first; nothing is deleted without --apply.
 *
 * Safety rails:
 *   - Punches that already carry an attendance_date are refused unless
 *     --include-dated is given, because they may already have been rolled
 *     into a calculated attendance day (`raw_punch_ids`).
 *   - `biomax_punch_derived` is deleted first, then `biomax_punch`, in one
 *     transaction (the FK fk_bpd_punch requires this order).
 *   - Import-batch item rows that point at a deleted punch have that
 *     pointer cleared, so the import audit keeps its row but no dangling id.
 *
 * Usage:
 *   NODE_ENV=production node scripts/delete-test-biomax-punches.js --from 2026-09-11 --to 2026-09-11
 *   NODE_ENV=production node scripts/delete-test-biomax-punches.js --from 2026-09-11 --to 2026-09-11 --apply
 *
 * Options:
 *   --from YYYY-MM-DD      first calendar date (required)
 *   --to YYYY-MM-DD        last calendar date, inclusive (default: --from)
 *   --dev-id ID            only this device's punches (repeatable)
 *   --user-id CODE         only this employee code (repeatable)
 *   --include-dated        also delete punches that have an attendance_date
 *   --apply                actually delete; without it the script only lists
 */

global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;

const mysql = require("mysql");

function parseArgs(argv) {
  const opts = { devIds: [], userIds: [], apply: false, includeDated: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--from") opts.from = next();
    else if (a === "--to") opts.to = next();
    else if (a === "--dev-id") opts.devIds.push(next());
    else if (a === "--user-id") opts.userIds.push(next());
    else if (a === "--include-dated") opts.includeDated = true;
    else if (a === "--apply") opts.apply = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.from) throw new Error("--from YYYY-MM-DD is required");
  if (!opts.to) opts.to = opts.from;
  const isDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  };
  if (!isDate(opts.from) || !isDate(opts.to)) {
    throw new Error("--from / --to must be YYYY-MM-DD");
  }
  if (opts.from > opts.to) throw new Error("--from is after --to");
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const config = require("../config.json");
const dbConfig = config.db.mysql[global.env];

const pool = mysql.createPool({
  connectionLimit: 2,
  host: dbConfig.host,
  user: dbConfig.username,
  password: dbConfig.password,
  database: dbConfig.database,
  port: dbConfig.port,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

function query(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getConnection() {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, conn) => (err ? reject(err) : resolve(conn)));
  });
}

function buildWhere() {
  const where = ["p.punch_date BETWEEN ? AND ?"];
  const params = [opts.from, opts.to];
  if (opts.devIds.length) {
    where.push(`p.dev_id IN (${opts.devIds.map(() => "?").join(",")})`);
    params.push(...opts.devIds);
  }
  if (opts.userIds.length) {
    where.push(`p.user_id IN (${opts.userIds.map(() => "?").join(",")})`);
    params.push(...opts.userIds);
  }
  return { where: where.join(" AND "), params };
}

async function main() {
  const conn = await getConnection();
  try {
    const { where, params } = buildWhere();
    const rows = await query(
      conn,
      `SELECT p.biomax_punch_id, p.dev_id, p.user_id,
              DATE_FORMAT(p.io_time, '%Y-%m-%d %H:%i:%s') AS io_time,
              p.source_ip, p.ingest_source,
              DATE_FORMAT(d.attendance_date, '%Y-%m-%d') AS attendance_date,
              d.derivation_status
         FROM biomax_punch p
         LEFT JOIN biomax_punch_derived d ON d.biomax_punch_id = p.biomax_punch_id
        WHERE ${where}
        ORDER BY p.io_time, p.biomax_punch_id`,
      params
    );

    console.log(
      `[${global.env}] ${rows.length} punch(es) match calendar dates ${opts.from}..${opts.to}` +
        (opts.devIds.length ? ` dev_id in (${opts.devIds.join(", ")})` : "") +
        (opts.userIds.length ? ` user_id in (${opts.userIds.join(", ")})` : "") +
        (opts.apply ? "" : " (dry-run: nothing deleted)")
    );
    if (rows.length === 0) return;
    console.table(rows);

    const dated = rows.filter((r) => r.attendance_date !== null);
    if (dated.length && !opts.includeDated) {
      console.error(
        `Refusing: ${dated.length} punch(es) already have an attendance_date ` +
          "and may be part of a calculated attendance day. Narrow the filter " +
          "or pass --include-dated if they really are test rows."
      );
      process.exitCode = 2;
      return;
    }

    if (!opts.apply) {
      console.log("Re-run with --apply to delete these rows.");
      return;
    }

    const ids = rows.map((r) => r.biomax_punch_id);
    const marks = ids.map(() => "?").join(",");

    await query(conn, "START TRANSACTION");
    try {
      const cleared = await query(
        conn,
        `UPDATE biomax_attendance_import_item SET biomax_punch_id = NULL
          WHERE biomax_punch_id IN (${marks})`,
        ids
      );
      const derived = await query(
        conn,
        `DELETE FROM biomax_punch_derived WHERE biomax_punch_id IN (${marks})`,
        ids
      );
      const raw = await query(
        conn,
        `DELETE FROM biomax_punch WHERE biomax_punch_id IN (${marks})`,
        ids
      );
      await query(conn, "COMMIT");
      console.log(
        `Deleted ${raw.affectedRows} biomax_punch row(s), ` +
          `${derived.affectedRows} biomax_punch_derived row(s); ` +
          `cleared ${cleared.affectedRows} import-item pointer(s).`
      );
    } catch (err) {
      await query(conn, "ROLLBACK");
      throw err;
    }
  } finally {
    conn.release();
    pool.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  pool.end();
  process.exit(1);
});
