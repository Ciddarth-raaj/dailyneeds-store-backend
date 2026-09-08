#!/usr/bin/env node
/**
 * Stage 0C / C1b — backfill one employment period per existing employee.
 *
 *   c1b-backfill.js check    --db <schema>
 *   c1b-backfill.js apply    --db <schema> --confirm APPLY-C1B-BACKFILL
 *   c1b-backfill.js verify   --db <schema>
 *   c1b-backfill.js rollback --db <schema> --confirm ROLLBACK-C1B-BACKFILL
 *
 * Options: --config <config.json> (default: the checkout's own), --env <block>.
 *
 * WHAT IT WRITES
 *   Exactly one row per employee in `employee_employment_period`, period_no 1,
 *   source 'backfill'. Nothing else. `new_employee` is never written - not one
 *   column, not one row - which is what makes the rollback a delete from a
 *   single new table.
 *
 * WHAT IT REFUSES TO GUESS
 *   `joined_on` comes only from `new_employee.date_of_joining`. Never
 *   `created_at` (that is when the sync inserted the row), never the
 *   resignation date, never today. A value that is present but unparseable
 *   ABORTS the run before a single insert, listing the employee ids and the
 *   raw text, because a backfill that silently drops a date it could not read
 *   is worse than one that stops.
 *
 * EVERY EXPECTED COUNT IS DERIVED FROM THE TARGET AT RUN TIME. The rehearsal
 * copy had 629 employees and production has 630; a script carrying either
 * number would be wrong somewhere. Nothing here is hard-coded but the rules.
 */
const fs = require("fs");
const path = require("path");

const CONFIRM_APPLY = "APPLY-C1B-BACKFILL";
const CONFIRM_ROLLBACK = "ROLLBACK-C1B-BACKFILL";

const die = (msg) => {
  process.stderr.write(`\nFAIL: ${msg}\n`);
  process.exit(1);
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

/* ------------------------------------------------------------------ SQL --
 * The parsing rule, written once and used by the classifier, the failure
 * report and the insert, so the three can never disagree about what a date
 * means.
 *
 * `%M` and not `%b`: `%b` parses "23 May 2024" but returns NULL for
 * "05 September 2021" and "05 Sept 2021", which would have quietly turned two
 * readable dates into unknowns. Both depend on lc_time_names, which is
 * asserted before anything is read.
 */
const JOINED_ON = (t = "ne") => `
  CASE
    WHEN ${t}.date_of_joining IS NULL OR TRIM(${t}.date_of_joining) = '' THEN NULL
    WHEN ${t}.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(${t}.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
      THEN STR_TO_DATE(LEFT(${t}.date_of_joining, 10), '%Y-%m-%d')
    ELSE STR_TO_DATE(TRIM(${t}.date_of_joining), '%d %M %Y')
  END`;

/** A value that is present but which the rule above cannot read. */
const UNPARSEABLE = (t = "ne") => `
  ${t}.date_of_joining IS NOT NULL
  AND TRIM(${t}.date_of_joining) <> ''
  AND (${JOINED_ON(t)}) IS NULL`;

/**
 * The backfill itself. One statement, and idempotent by construction: an
 * employee who already has ANY period is skipped, so a second run inserts
 * nothing and can never create a period 2 or a duplicate period 1.
 */
const INSERT_SQL = `
INSERT INTO employee_employment_period
  (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type, source, needs_review)
SELECT
  ne.employee_id,
  1,
  CASE WHEN ne.status = 1 THEN 'open' ELSE 'closed' END,
  ${JOINED_ON()},
  CASE WHEN ne.status = 1 THEN NULL ELSE ne.resignation_date END,
  CASE WHEN ne.status = 1 THEN NULL ELSE 'unknown' END,
  'backfill',
  CASE
    WHEN (${JOINED_ON()}) IS NULL THEN 1
    WHEN ne.status <> 1 AND ne.resignation_date IS NULL THEN 1
    ELSE 0
  END
FROM new_employee ne
WHERE NOT EXISTS (
  SELECT 1 FROM employee_employment_period p WHERE p.employee_id = ne.employee_id
)`;

/* ------------------------------------------------------------- plumbing -- */
function readAppConfig(file, envName) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    die(`cannot read the application config ${file}: ${err.message}`);
  }
  const env = envName || (process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV);
  const block = config && config.db && config.db.mysql && config.db.mysql[env];
  if (!block) die(`${file} has no db.mysql.${env} block`);
  if (!block.username) die(`db.mysql.${env} in ${file} has no username`);
  return {
    host: block.host,
    port: Number(block.port || 3306),
    user: block.username,
    password: block.password === undefined || block.password === null ? "" : String(block.password),
  };
}

function connect(db) {
  const cfg = readAppConfig(arg("config", path.join(__dirname, "../../config.json")), arg("env"));
  const mysql = require(path.join(__dirname, "../../node_modules/mysql"));
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    // The schema named on the command line always wins over the one in the
    // config, so the target is never a surprise.
    database: db,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const q = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const one = async (conn, sql, params) => (await q(conn, sql, params))[0];
const scalar = async (conn, sql, params) => {
  const row = await one(conn, sql, params);
  return row ? Object.values(row)[0] : null;
};

let failures = 0;
const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg, detail) => {
  failures++;
  console.log(`  FAIL  ${msg}${detail ? `   [${detail}]` : ""}`);
};
const check = (msg, got, want) =>
  String(got) === String(want) ? ok(`${msg} (${got})`) : bad(msg, `got ${got}, want ${want}`);

/* ------------------------------------------------------------ preflight -- */
/**
 * Reads the target and returns everything the rest of the run compares
 * against. Read-only: `check` stops here.
 */
async function preflight(conn, db) {
  console.log(`\n== preflight on '${db}'`);

  const active = await scalar(conn, "SELECT DATABASE() AS db");
  check("active database is the one named on the command line", active, db);
  if (String(active) !== String(db)) die("wrong database - stopping before anything is read further");

  const locale = await scalar(conn, "SELECT @@lc_time_names AS l");
  check("lc_time_names is en_US (required by the %M date rule)", locale, "en_US");
  if (String(locale) !== "en_US") {
    die("with another locale STR_TO_DATE(..., '%d %M %Y') returns NULL for every row - refusing to run");
  }

  for (const t of ["employee_employment_period", "employee_lifecycle_event"]) {
    const exists = await scalar(
      conn,
      "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [db, t]
    );
    if (String(exists) !== "1") die(`${t} does not exist - apply the C1a migration first`);
  }

  // Everything below is derived from the target, never assumed.
  const emp = await one(
    conn,
    `SELECT
       COUNT(*) AS total,
       SUM(status = 1) AS active,
       SUM(status <> 1) AS inactive,
       SUM(status <> 1 AND resignation_date IS NOT NULL) AS inactive_with_date,
       SUM(status <> 1 AND resignation_date IS NULL) AS inactive_without_date
     FROM new_employee`
  );
  console.log(`\n   employees          ${emp.total}`);
  console.log(`   active (status=1)  ${emp.active}`);
  console.log(`   inactive           ${emp.inactive}  (with end date ${emp.inactive_with_date}, without ${emp.inactive_without_date})`);

  const dates = await q(
    conn,
    `SELECT class, COUNT(*) AS n FROM (
       SELECT CASE
         WHEN ne.date_of_joining IS NULL THEN 'null'
         WHEN TRIM(ne.date_of_joining) = '' THEN 'blank'
         WHEN ne.date_of_joining LIKE '____-__-__%'
              AND STR_TO_DATE(LEFT(ne.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL THEN 'iso'
         WHEN STR_TO_DATE(TRIM(ne.date_of_joining), '%d %M %Y') IS NOT NULL THEN 'day_month_year'
         ELSE 'UNPARSEABLE'
       END AS class
       FROM new_employee ne
     ) c GROUP BY class ORDER BY n DESC`
  );
  console.log("\n   date_of_joining classes:");
  for (const r of dates) console.log(`     ${String(r.class).padEnd(16)} ${r.n}`);

  const unparseable = await q(
    conn,
    `SELECT employee_id, date_of_joining FROM new_employee ne
      WHERE ${UNPARSEABLE()} ORDER BY employee_id`
  );
  if (unparseable.length > 0) {
    console.log(`\n   ${unparseable.length} joining date(s) present but unreadable:`);
    for (const r of unparseable) console.log(`     employee ${r.employee_id}: ${JSON.stringify(r.date_of_joining)}`);
    die(
      `${unparseable.length} joining date(s) cannot be parsed. Nothing has been written. ` +
        `Correct them in new_employee, or decide they are unknown and blank them, then re-run.`
    );
  }
  ok("every non-blank joining date parses");

  // Existing periods: empty (first run), exactly our own (a rerun), or
  // something else - which is a conflict and stops the run.
  const periods = await one(
    conn,
    `SELECT
       COUNT(*) AS total,
       SUM(source = 'backfill') AS backfill,
       SUM(source <> 'backfill') AS other,
       SUM(period_no <> 1) AS beyond_first
     FROM employee_employment_period`
  );
  const events = await scalar(conn, "SELECT COUNT(*) AS c FROM employee_lifecycle_event");

  if (Number(periods.total) === 0) {
    ok("employee_employment_period is empty - this is a first run");
  } else {
    console.log(`\n   employee_employment_period already holds ${periods.total} row(s)`);
    if (Number(periods.other) > 0) {
      die(`${periods.other} period(s) were not created by this backfill (source <> 'backfill'). ` +
          `That is real lifecycle data; refusing to touch it.`);
    }
    if (Number(periods.beyond_first) > 0) {
      die(`${periods.beyond_first} period(s) have period_no <> 1. A rejoin has been recorded; ` +
          `refusing to run a historical backfill over it.`);
    }
    const disagree = await scalar(
      conn,
      `SELECT COUNT(*) AS c
         FROM employee_employment_period p
         JOIN new_employee ne ON ne.employee_id = p.employee_id
        WHERE p.source = 'backfill'
          AND ( p.period_state <> CASE WHEN ne.status = 1 THEN 'open' ELSE 'closed' END
             OR NOT (p.joined_on <=> (${JOINED_ON()}))
             OR NOT (p.ended_on  <=> CASE WHEN ne.status = 1 THEN NULL ELSE ne.resignation_date END) )`
    );
    if (Number(disagree) > 0) {
      die(`${disagree} existing backfill period(s) disagree with what this run would write. ` +
          `The employee data changed after the backfill; this script will not overwrite. Review them first.`);
    }
    ok(`the ${periods.backfill} existing period(s) are this backfill's own and still agree with new_employee`);
  }

  const missing = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM new_employee ne
      WHERE NOT EXISTS (SELECT 1 FROM employee_employment_period p WHERE p.employee_id = ne.employee_id)`
  );
  console.log(`\n   employees without a period: ${missing}  <- what an apply would insert`);

  return {
    employees: Number(emp.total),
    active: Number(emp.active),
    inactive: Number(emp.inactive),
    inactiveWithDate: Number(emp.inactive_with_date),
    inactiveWithoutDate: Number(emp.inactive_without_date),
    periodsBefore: Number(periods.total),
    eventsBefore: Number(events),
    missing: Number(missing),
  };
}

/** CHECKSUM TABLE returns {Table, Checksum}; take the checksum column. */
async function employeeChecksum(conn) {
  const row = await one(conn, "CHECKSUM TABLE new_employee");
  return row ? String(row.Checksum) : null;
}

/* ---------------------------------------------------------- postconditions */
async function verify(conn, db, before) {
  console.log("\n== postconditions (all derived from the target, nothing hard-coded)");

  const emp = await one(
    conn,
    `SELECT COUNT(*) AS total, SUM(status = 1) AS active, SUM(status <> 1) AS inactive FROM new_employee`
  );
  const p = await one(
    conn,
    `SELECT
       COUNT(*) AS total,
       SUM(period_no = 1) AS first_periods,
       SUM(period_state = 'open') AS open_periods,
       SUM(period_state = 'closed') AS closed_periods,
       SUM(source = 'backfill') AS backfill,
       SUM(needs_review = 1) AS needs_review,
       SUM(joined_on IS NULL) AS unknown_join,
       SUM(period_state = 'closed' AND ended_on IS NULL) AS closed_unknown_end
     FROM employee_employment_period`
  );

  check("one period per employee", p.total, emp.total);
  check("every period is period_no 1", p.first_periods, p.total);
  check("open periods match active employees", p.open_periods, emp.active);
  check("closed periods match inactive employees", p.closed_periods, emp.inactive);
  check("every row was written by this backfill", p.backfill, p.total);

  const withoutPeriod = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM new_employee ne
      WHERE NOT EXISTS (SELECT 1 FROM employee_employment_period p WHERE p.employee_id = ne.employee_id)`
  );
  check("no employee is left without a period", withoutPeriod, 0);

  const dupes = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM (
       SELECT employee_id FROM employee_employment_period GROUP BY employee_id HAVING COUNT(*) > 1
     ) d`
  );
  check("no employee has more than one period", dupes, 0);

  const manyOpen = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM (
       SELECT employee_id FROM employee_employment_period
        WHERE period_state = 'open' GROUP BY employee_id HAVING COUNT(*) > 1
     ) d`
  );
  check("at most one open period per employee", manyOpen, 0);

  const orphans = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM employee_employment_period p
      WHERE NOT EXISTS (SELECT 1 FROM new_employee ne WHERE ne.employee_id = p.employee_id)`
  );
  check("no orphan periods", orphans, 0);

  // Unknown stays unknown: every NULL joined_on must correspond to an
  // employee whose date_of_joining really was absent or blank.
  const invented = await scalar(
    conn,
    `SELECT COUNT(*) AS c
       FROM employee_employment_period p JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE NOT (p.joined_on <=> (${JOINED_ON()}))`
  );
  check("every joined_on equals what the parsing rule reads from new_employee", invented, 0);

  const blankButDated = await scalar(
    conn,
    `SELECT COUNT(*) AS c
       FROM employee_employment_period p JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE p.joined_on IS NOT NULL
        AND (ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '')`
  );
  check("no joining date was invented for an employee who had none", blankButDated, 0);

  const endedMismatch = await scalar(
    conn,
    `SELECT COUNT(*) AS c
       FROM employee_employment_period p JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE NOT (p.ended_on <=> CASE WHEN ne.status = 1 THEN NULL ELSE ne.resignation_date END)`
  );
  check("every ended_on equals the employee's resignation_date (or NULL when active)", endedMismatch, 0);

  console.log(`\n   needs_review: ${p.needs_review}  (unknown joining date ${p.unknown_join}, closed with unknown end ${p.closed_unknown_end})`);

  const events = await scalar(conn, "SELECT COUNT(*) AS c FROM employee_lifecycle_event");
  if (before) {
    check("no lifecycle event was created by the backfill", events, before.eventsBefore);
    check("new_employee row count unchanged", emp.total, before.employees);
    if (before.empChecksumValue) {
      check("new_employee is byte-identical (CHECKSUM TABLE)", await employeeChecksum(conn), before.empChecksumValue);
    }
  } else {
    console.log(`   lifecycle events: ${events} (no before-value in this mode)`);
  }
}

/* ----------------------------------------------------------------- main -- */
async function main() {
  const mode = process.argv[2];
  const db = arg("db");
  if (!mode || !db) {
    die("usage: c1b-backfill.js check|apply|verify|rollback --db <schema> [--confirm <word>] [--config f] [--env e]");
  }
  if (!["check", "apply", "verify", "rollback"].includes(mode)) die(`unknown mode '${mode}'`);

  const conn = connect(db);
  await new Promise((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));

  try {
    if (mode === "verify") {
      const active = await scalar(conn, "SELECT DATABASE() AS db");
      check("active database", active, db);
      await verify(conn, db, null);
    } else if (mode === "rollback") {
      if (arg("confirm") !== CONFIRM_ROLLBACK) die(`rollback needs --confirm ${CONFIRM_ROLLBACK}`);
      const active = await scalar(conn, "SELECT DATABASE() AS db");
      if (String(active) !== String(db)) die("wrong database");
      // Refuse if anything has come to depend on these rows.
      const referenced = await scalar(
        conn,
        `SELECT COUNT(*) AS c FROM resignation r
          JOIN employee_employment_period p ON p.period_id = r.period_id WHERE p.source = 'backfill'`
      );
      if (Number(referenced) > 0) die(`${referenced} resignation row(s) reference backfilled periods - not rolling back`);
      const evented = await scalar(
        conn,
        `SELECT COUNT(*) AS c FROM employee_lifecycle_event e
          JOIN employee_employment_period p ON p.period_id = e.period_id WHERE p.source = 'backfill'`
      );
      if (Number(evented) > 0) die(`${evented} lifecycle event(s) reference backfilled periods - not rolling back`);
      const res = await q(conn, "DELETE FROM employee_employment_period WHERE source = 'backfill'");
      console.log(`\nremoved ${res.affectedRows} backfilled period(s)`);
      check("no backfilled period remains", await scalar(conn, "SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'backfill'"), 0);
      console.log("new_employee was never written by this script, so nothing else needs undoing.");
    } else {
      const before = await preflight(conn, db);
      before.empChecksumValue = await employeeChecksum(conn);

      if (mode === "check") {
        console.log("\ncheck mode: nothing was written.");
      } else {
        if (arg("confirm") !== CONFIRM_APPLY) die(`apply needs --confirm ${CONFIRM_APPLY}`);
        console.log(`\n== applying (inserting ${before.missing} period(s))`);
        await q(conn, "START TRANSACTION");
        try {
          const res = await q(conn, INSERT_SQL);
          await q(conn, "COMMIT");
          console.log(`   inserted ${res.affectedRows} row(s)`);
          if (Number(res.affectedRows) !== before.missing) {
            bad("inserted row count differs from what preflight predicted", `${res.affectedRows} vs ${before.missing}`);
          }
        } catch (err) {
          await q(conn, "ROLLBACK").catch(() => {});
          die(`the insert failed and was rolled back: ${err.message}`);
        }
        await verify(conn, db, before);
      }
    }
  } finally {
    conn.end();
  }

  if (failures > 0) {
    console.log(`\nC1B BACKFILL: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nC1B BACKFILL: ALL CHECKS PASSED");
}

process.on("unhandledRejection", (err) => die(`unhandled rejection: ${(err && err.message) || err}`));

if (require.main === module) {
  main().catch((err) => die((err && err.message) || String(err)));
}

module.exports = { JOINED_ON, UNPARSEABLE, INSERT_SQL, CONFIRM_APPLY, CONFIRM_ROLLBACK };
