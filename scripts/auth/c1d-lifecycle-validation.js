#!/usr/bin/env node
/**
 * Stage 0C / C1d — lifecycle validation and Digisme exit readiness. READ ONLY.
 *
 *   c1d-lifecycle-validation.js check --db <schema> [--since <ISO8601>]
 *                                     [--config config.json] [--detail 10]
 *                                     [--json]
 *
 * WHY THIS EXISTS
 *
 * The Digisme subscription is ending, so the question is no longer "does
 * dnds.co.in agree with Digisme?" but "can dnds.co.in stand on its own when
 * Digisme is gone?". This answers that in three parts:
 *
 *   1. is the lifecycle data STRUCTURALLY sound - one open period per
 *      employed person, sequences that start at 1 and do not skip, no orphan
 *      or duplicate rows, events that match the periods they describe;
 *   2. what is UNKNOWN, and of that, how much only Digisme can still tell us
 *      before the account closes;
 *   3. what the reconciler WOULD do, so the eventual one-time import from the
 *      Digisme export has a predicted shape to be checked against.
 *
 * READ ONLY, and structurally so: there is no INSERT, UPDATE, DELETE, ALTER
 * or transaction anywhere in this file, and a test strips the comments and
 * log strings and asserts it. C1d never repairs anything. An inconsistency is
 * reported and left for a human to decide about.
 *
 * INDEPENDENCE FROM THE CODE IT CHECKS. The structural checks are plain SQL
 * over the three tables and derive nothing from usecase/employee_lifecycle.js
 * - if C1c had a bug that produced two open periods, a validator that asked
 * C1c what it expected would agree with the bug. Only the forecast column
 * ("would reconciliation act on this employee?") calls the real `decide()`,
 * and it is clearly labelled as a forecast rather than as a verdict.
 *
 * PRIVACY. Employee names are never selected or printed. Operational reports
 * are by employee_id, with the dates involved and the raw `date_of_joining`
 * text, because that text is what a human needs to resolve a flagged row.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const { JOINED_ON, UNPARSEABLE } = require(path.join(ROOT, "utils/joining_date"));
const { decide, toDateOnly } = require(path.join(ROOT, "usecase/employee_lifecycle"));

/* ------------------------------------------------------------------ args -- */
const die = (msg) => {
  process.stderr.write(`\nFAIL: ${msg}\n`);
  process.exit(2);
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const MODE = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "check";
const DB = arg("db", "");
const SINCE = arg("since", null);
const DETAIL = Number(arg("detail", 10));
const AS_JSON = has("json");

if (MODE !== "check") die(`unknown mode '${MODE}'. C1d has one mode: check (read-only).`);
if (!DB) die("--db <schema> is required");
if (SINCE !== null && Number.isNaN(Date.parse(SINCE))) die(`--since '${SINCE}' is not a parseable timestamp`);

/* --------------------------------------------------------------- findings -- */
const errors = [];
const warnings = [];
const notes = [];
const addError = (code, message, rows = []) => errors.push({ code, message, count: rows.length || message.count || 0, rows });
const addWarning = (code, message, rows = []) => warnings.push({ code, message, count: rows.length, rows });

/* ---------------------------------------------------------------- connect -- */
function connect() {
  const file = arg("config", path.join(ROOT, "config.json"));
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    die(`cannot read ${file}: ${err.message}`);
  }
  const env = arg("env", process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV);
  const block = cfg && cfg.db && cfg.db.mysql && cfg.db.mysql[env];
  if (!block) die(`${file} has no db.mysql.${env} block`);
  const mysql = require(path.join(ROOT, "node_modules/mysql"));
  return mysql.createConnection({
    host: block.host,
    port: Number(block.port || 3306),
    user: block.username,
    password: block.password === undefined || block.password === null ? "" : String(block.password),
    database: DB,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const conn = connect();
const q = (sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const scalar = async (sql, params) => {
  const rows = await q(sql, params);
  return rows && rows[0] ? Object.values(rows[0])[0] : null;
};
const count = async (sql, params) => Number(await scalar(sql, params));

/* -------------------------------------------------------------- the views -- */
/** The employee's newest period, with the previous period's end date. */
const LATEST_PERIOD = `
  SELECT p.*,
         ( SELECT prev.ended_on FROM employee_employment_period prev
            WHERE prev.employee_id = p.employee_id AND prev.period_no < p.period_no
            ORDER BY prev.period_no DESC LIMIT 1 ) AS prev_ended_on
    FROM employee_employment_period p
    JOIN ( SELECT employee_id, MAX(period_no) AS period_no
             FROM employee_employment_period GROUP BY employee_id ) latest
      ON latest.employee_id = p.employee_id AND latest.period_no = p.period_no`;

const SNAPSHOT = `
SELECT ne.employee_id, ne.status, ne.resignation_date,
       ne.date_of_joining AS raw_date_of_joining,
       (${JOINED_ON("ne")}) AS parsed_joined_on,
       cur.period_id, cur.period_no, cur.period_state, cur.joined_on, cur.ended_on,
       cur.source, cur.needs_review, cur.prev_ended_on
  FROM new_employee ne
  LEFT JOIN (${LATEST_PERIOD}) cur ON cur.employee_id = ne.employee_id
 ORDER BY ne.employee_id`;

/* ==========================================================================
 *  sections
 * ====================================================================== */

async function population() {
  const p = {
    employees: await count("SELECT COUNT(*) c FROM new_employee"),
    active: await count("SELECT COUNT(*) c FROM new_employee WHERE status = 1"),
    inactive: await count("SELECT COUNT(*) c FROM new_employee WHERE status <> 1"),
    periods: await count("SELECT COUNT(*) c FROM employee_employment_period"),
    backfill: await count("SELECT COUNT(*) c FROM employee_employment_period WHERE source = 'backfill'"),
    local: await count("SELECT COUNT(*) c FROM employee_employment_period WHERE source = 'local'"),
    events: await count("SELECT COUNT(*) c FROM employee_lifecycle_event"),
    multiPeriod: await count(
      `SELECT COUNT(*) c FROM (SELECT employee_id FROM employee_employment_period
        GROUP BY employee_id HAVING COUNT(*) > 1) x`
    ),
    maxPeriodNo: Number(await scalar("SELECT IFNULL(MAX(period_no), 0) m FROM employee_employment_period")),
    openPeriods: await count("SELECT COUNT(*) c FROM employee_employment_period WHERE period_state = 'open'"),
    needsReview: await count("SELECT COUNT(*) c FROM employee_employment_period WHERE needs_review = 1"),
  };
  return p;
}

/**
 * The invariants, in SQL. Every one of these should be zero; each is stated
 * directly against the tables so a defect in C1c cannot make it agree.
 */
async function structure() {
  const rows = async (sql) => q(sql);

  const activeNoOpen = await rows(
    `SELECT ne.employee_id FROM new_employee ne
      WHERE ne.status = 1
        AND EXISTS (SELECT 1 FROM employee_employment_period p WHERE p.employee_id = ne.employee_id)
        AND NOT EXISTS (SELECT 1 FROM employee_employment_period p
                         WHERE p.employee_id = ne.employee_id AND p.period_state = 'open')
      ORDER BY ne.employee_id`
  );
  if (activeNoOpen.length) addError("ACTIVE_NO_OPEN_PERIOD", "active employee with no open period", activeNoOpen);

  const multiOpen = await rows(
    `SELECT employee_id, COUNT(*) AS open_periods FROM employee_employment_period
      WHERE period_state = 'open' GROUP BY employee_id HAVING COUNT(*) > 1 ORDER BY employee_id`
  );
  if (multiOpen.length) addError("MULTIPLE_OPEN_PERIODS", "employee with more than one open period", multiOpen);

  const inactiveOpen = await rows(
    `SELECT ne.employee_id FROM new_employee ne
      JOIN employee_employment_period p ON p.employee_id = ne.employee_id AND p.period_state = 'open'
     WHERE ne.status <> 1 ORDER BY ne.employee_id`
  );
  if (inactiveOpen.length) addError("INACTIVE_WITH_OPEN_PERIOD", "inactive employee with an open period", inactiveOpen);

  const noPeriod = await rows(
    `SELECT ne.employee_id, ne.status FROM new_employee ne
      WHERE NOT EXISTS (SELECT 1 FROM employee_employment_period p WHERE p.employee_id = ne.employee_id)
      ORDER BY ne.employee_id`
  );
  // Not an error by itself - an employee added after the backfill legitimately
  // has none until the reconciler next runs - but it must be visible.
  if (noPeriod.length) addWarning("EMPLOYEE_WITH_NO_PERIOD", "employee with no employment period at all", noPeriod);

  const orphan = await rows(
    `SELECT p.period_id, p.employee_id FROM employee_employment_period p
      LEFT JOIN new_employee ne ON ne.employee_id = p.employee_id
     WHERE ne.employee_id IS NULL ORDER BY p.period_id`
  );
  if (orphan.length) addError("ORPHAN_PERIOD", "period whose employee does not exist", orphan);

  const dupSeq = await rows(
    `SELECT employee_id, period_no, COUNT(*) AS n FROM employee_employment_period
      GROUP BY employee_id, period_no HAVING COUNT(*) > 1 ORDER BY employee_id`
  );
  if (dupSeq.length) addError("DUPLICATE_PERIOD_NO", "duplicate (employee_id, period_no)", dupSeq);

  return { activeNoOpen, multiOpen, inactiveOpen, noPeriod, orphan, dupSeq };
}

/** period_no must start at 1, be contiguous, and only the newest may be open. */
async function sequence() {
  const notFromOne = await q(
    `SELECT employee_id, MIN(period_no) AS first_period_no FROM employee_employment_period
      GROUP BY employee_id HAVING MIN(period_no) <> 1 ORDER BY employee_id`
  );
  if (notFromOne.length) addError("SEQUENCE_NOT_FROM_ONE", "employee whose first period_no is not 1", notFromOne);

  // A gap exists when the count of periods is less than the highest number,
  // given the minimum is 1 and duplicates are reported separately.
  const gaps = await q(
    `SELECT employee_id, COUNT(*) AS periods, MAX(period_no) AS max_period_no
       FROM employee_employment_period GROUP BY employee_id
      HAVING COUNT(DISTINCT period_no) <> MAX(period_no) OR MIN(period_no) <> 1
      ORDER BY employee_id`
  );
  if (gaps.length) addError("SEQUENCE_GAP", "gap in the period_no sequence", gaps);

  const openNotLatest = await q(
    `SELECT p.employee_id, p.period_no, m.max_period_no
       FROM employee_employment_period p
       JOIN ( SELECT employee_id, MAX(period_no) AS max_period_no
                FROM employee_employment_period GROUP BY employee_id ) m
         ON m.employee_id = p.employee_id
      WHERE p.period_state = 'open' AND p.period_no <> m.max_period_no
      ORDER BY p.employee_id`
  );
  if (openNotLatest.length) {
    addError("OPEN_PERIOD_NOT_LATEST", "an open period that is not the employee's newest", openNotLatest);
  }

  return { notFromOne, gaps, openNotLatest };
}

/**
 * Dates. Almost everything here is a WARNING: an unknown historical date is
 * the expected state of 518 rows, not a fault. Only an ordering violation is
 * an error, because the schema forbids it and its presence would mean the
 * CHECK constraint is not doing its job.
 *
 * The current master `date_of_joining` is ONE column describing the CURRENT
 * spell. Comparing it against every historical period would manufacture
 * disagreements for anyone who has rejoined, so it is compared only where
 * that comparison is meaningful: an employee with exactly one period.
 */
async function dates(snapshot) {
  const badOrder = await q(
    `SELECT period_id, employee_id, period_no,
            DATE_FORMAT(joined_on,'%Y-%m-%d') joined_on, DATE_FORMAT(ended_on,'%Y-%m-%d') ended_on
       FROM employee_employment_period
      WHERE ended_on IS NOT NULL AND joined_on IS NOT NULL AND ended_on < joined_on
      ORDER BY employee_id`
  );
  if (badOrder.length) addError("ENDED_BEFORE_JOINED", "period whose ended_on precedes joined_on", badOrder);

  const unreadable = await q(
    `SELECT employee_id, date_of_joining AS raw_date_of_joining FROM new_employee ne
      WHERE ${UNPARSEABLE("ne")} ORDER BY employee_id`
  );
  if (unreadable.length) {
    addWarning("UNREADABLE_MASTER_JOINING_DATE", "date_of_joining present but unreadable", unreadable);
  }

  const unknownJoin = await q(
    `SELECT employee_id, period_no FROM employee_employment_period
      WHERE joined_on IS NULL ORDER BY employee_id`
  );
  if (unknownJoin.length) addWarning("PERIOD_JOINED_ON_UNKNOWN", "period with an unknown joining date", unknownJoin);

  const unknownEnd = await q(
    `SELECT employee_id, period_no FROM employee_employment_period
      WHERE period_state = 'closed' AND ended_on IS NULL ORDER BY employee_id`
  );
  if (unknownEnd.length) {
    addWarning("CLOSED_PERIOD_END_UNKNOWN", "closed period with an unknown end date", unknownEnd);
  }

  // Only for single-period employees: for anyone who has rejoined, the master
  // column describes the latest spell and legitimately differs from period 1.
  const periodCounts = new Map();
  for (const r of await q("SELECT employee_id, COUNT(*) n FROM employee_employment_period GROUP BY employee_id")) {
    periodCounts.set(String(r.employee_id), Number(r.n));
  }

  const conflicts = [];
  const staleRejoin = [];
  for (const r of snapshot) {
    const n = periodCounts.get(String(r.employee_id)) || 0;
    const master = toDateOnly(r.parsed_joined_on);
    const latestJoined = toDateOnly(r.joined_on);

    if (n === 1 && master !== null && latestJoined !== null && master !== latestJoined) {
      conflicts.push({
        employee_id: r.employee_id,
        period_joined_on: latestJoined,
        master_date_of_joining: master,
        raw_date_of_joining: r.raw_date_of_joining,
      });
    }

    // A rejoined employee whose latest period has no joining date, while the
    // master still holds a date that predates the previous spell's end: that
    // is the original joining date, left behind because Digisme never updated
    // the field on a rejoin. Expected, and exactly what the export must fix.
    if (n > 1 && latestJoined === null && master !== null) {
      const prevEnded = toDateOnly(r.prev_ended_on);
      if (prevEnded === null || master <= prevEnded) {
        staleRejoin.push({
          employee_id: r.employee_id,
          latest_period_no: r.period_no,
          previous_ended_on: prevEnded,
          master_date_of_joining: master,
        });
      }
    }
  }
  if (conflicts.length) {
    addWarning(
      "MASTER_DATE_CONFLICTS_PERIOD",
      "single-period employee whose known joined_on differs from the master",
      conflicts
    );
  }
  if (staleRejoin.length) {
    addWarning(
      "STALE_MASTER_DATE_ON_REJOIN",
      "rejoined employee whose master date_of_joining is the ORIGINAL date",
      staleRejoin
    );
  }

  return { badOrder, unreadable, unknownJoin, unknownEnd, conflicts, staleRejoin };
}

/**
 * Events. The 630 backfilled periods deliberately have none - C1b recorded no
 * lifecycle decision - so their absence is correct and is NOT reported. Only
 * periods written at runtime (`source = 'local'`) are expected to carry one.
 */
async function events() {
  const eventless = await q(
    `SELECT p.period_id, p.employee_id, p.period_no, p.period_state
       FROM employee_employment_period p
      WHERE p.source = 'local'
        AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_event e WHERE e.period_id = p.period_id)
      ORDER BY p.employee_id`
  );
  if (eventless.length) {
    addError("RUNTIME_PERIOD_WITHOUT_EVENT", "runtime-created period with no lifecycle event", eventless);
  }

  const missingEmployee = await q(
    `SELECT e.event_id, e.employee_id FROM employee_lifecycle_event e
      LEFT JOIN new_employee ne ON ne.employee_id = e.employee_id
     WHERE ne.employee_id IS NULL ORDER BY e.event_id`
  );
  if (missingEmployee.length) addError("EVENT_MISSING_EMPLOYEE", "event referencing an employee that does not exist", missingEmployee);

  const missingPeriod = await q(
    `SELECT e.event_id, e.employee_id, e.period_id FROM employee_lifecycle_event e
      LEFT JOIN employee_employment_period p ON p.period_id = e.period_id
     WHERE e.period_id IS NOT NULL AND p.period_id IS NULL ORDER BY e.event_id`
  );
  if (missingPeriod.length) addError("EVENT_MISSING_PERIOD", "event referencing a period that does not exist", missingPeriod);

  // One opening and at most one closure per period. A second of either means a
  // repeated sync recorded a transition twice.
  const dupOpen = await q(
    `SELECT period_id, COUNT(*) n FROM employee_lifecycle_event
      WHERE event_type = 'period_opened' AND period_id IS NOT NULL
      GROUP BY period_id HAVING COUNT(*) > 1 ORDER BY period_id`
  );
  const dupClose = await q(
    `SELECT period_id, COUNT(*) n FROM employee_lifecycle_event
      WHERE event_type = 'period_closed' AND period_id IS NOT NULL
      GROUP BY period_id HAVING COUNT(*) > 1 ORDER BY period_id`
  );
  if (dupOpen.length) addError("DUPLICATE_OPEN_EVENT", "period with more than one opening event", dupOpen);
  if (dupClose.length) addError("DUPLICATE_CLOSE_EVENT", "period with more than one closure event", dupClose);

  // A closure recorded against a period that is still open, or an open period
  // whose newest event says it closed.
  const contradiction = await q(
    `SELECT e.event_id, e.period_id, e.event_type, p.period_state
       FROM employee_lifecycle_event e
       JOIN employee_employment_period p ON p.period_id = e.period_id
      WHERE e.event_type = 'period_closed' AND p.period_state = 'open'
      ORDER BY e.event_id`
  );
  if (contradiction.length) {
    addError("EVENT_CONTRADICTS_PERIOD", "closure event on a period that is still open", contradiction);
  }

  const backfillWithEvent = await q(
    `SELECT e.event_id, e.period_id FROM employee_lifecycle_event e
       JOIN employee_employment_period p ON p.period_id = e.period_id
      WHERE p.source = 'backfill' ORDER BY e.event_id`
  );
  if (backfillWithEvent.length) {
    addWarning(
      "BACKFILL_PERIOD_HAS_EVENT",
      "backfilled period carrying a lifecycle event (C1b created none)",
      backfillWithEvent
    );
  }

  return { eventless, missingEmployee, missingPeriod, dupOpen, dupClose, contradiction, backfillWithEvent };
}

/** Session-cutoff configuration and state. No token, hash or secret is read. */
async function auth() {
  let flag = null;
  try {
    flag = require(path.join(ROOT, "config/auth")).login.tokenValidFromEnabled;
  } catch (err) {
    notes.push(`config/auth.js could not be loaded here: ${err.message}`);
  }

  const usersWithCutoff = await count(
    "SELECT COUNT(*) c FROM `user` WHERE token_valid_from IS NOT NULL"
  );
  const recentCutoff =
    SINCE === null
      ? null
      : await count("SELECT COUNT(*) c FROM `user` WHERE token_valid_from >= ?", [
          new Date(SINCE),
        ]);

  // Where the revocation is wired, read from the runtime source. A change that
  // dropped the bump from a rejoin would show up here as `false`.
  const src = fs.readFileSync(path.join(ROOT, "usecase/employee_lifecycle.js"), "utf8");
  const wiredFor = (action) => {
    const i = src.indexOf(`action: "${action}"`);
    if (i < 0) return null;
    const block = src.slice(i, i + 2000);
    const m = block.match(/revokeSessions:\s*(true|false)/);
    return m ? m[1] === "true" : null;
  };

  return {
    tokenValidFromEnabled: flag,
    usersWithCutoff,
    recentCutoff,
    revokeOnClose: wiredFor("close"),
    revokeOnRejoin: wiredFor("open_rejoin"),
    revokeOnInitialJoin: wiredFor("open_initial"),
    callSitePresent: /bumpTokenValidFromByEmployeeId/.test(src),
  };
}

/**
 * Digisme exit readiness. The subscription is ending, so the question is what
 * becomes permanently unknowable when it does.
 *
 * `date_of_joining` was NEVER carried by the sync mapper - it is not one of
 * the eleven fields Digisme writes - so for an employee whose master column
 * is blank, Digisme's own record is the only remaining source, and only until
 * the account closes.
 */
async function exitReadiness() {
  const joinOnlyDigisme = await count(
    `SELECT COUNT(*) c FROM employee_employment_period p
       JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE p.joined_on IS NULL
        AND (ne.date_of_joining IS NULL OR TRIM(ne.date_of_joining) = '')`
  );
  const joinRecoverableLocally = await count(
    `SELECT COUNT(*) c FROM employee_employment_period p
       JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE p.joined_on IS NULL AND (${JOINED_ON("ne")}) IS NOT NULL`
  );
  const endOnlyDigisme = await count(
    `SELECT COUNT(*) c FROM employee_employment_period p
       JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE p.period_state = 'closed' AND p.ended_on IS NULL AND ne.resignation_date IS NULL`
  );
  const endRecoverableLocally = await count(
    `SELECT COUNT(*) c FROM employee_employment_period p
       JOIN new_employee ne ON ne.employee_id = p.employee_id
      WHERE p.period_state = 'closed' AND p.ended_on IS NULL AND ne.resignation_date IS NOT NULL`
  );
  return { joinOnlyDigisme, joinRecoverableLocally, endOnlyDigisme, endRecoverableLocally };
}

/**
 * What the reconciler WOULD do. A forecast, not a verdict: this is the one
 * place that calls C1c's own decision function, so that the eventual one-time
 * import from the Digisme export has a predicted shape to be checked against.
 */
function forecast(snapshot) {
  const tally = { none: 0, open_initial: 0, open_rejoin: 0, close: 0, fill: 0 };
  const acting = [];
  for (const r of snapshot) {
    const employee = {
      employee_id: r.employee_id,
      status: r.status,
      resignation_date: r.resignation_date,
      raw_date_of_joining: r.raw_date_of_joining,
      parsed_joined_on: r.parsed_joined_on,
    };
    const latest =
      r.period_id === null
        ? null
        : {
            period_id: r.period_id, period_no: r.period_no, period_state: r.period_state,
            joined_on: r.joined_on, ended_on: r.ended_on, prev_ended_on: r.prev_ended_on,
          };
    const plan = decide(employee, latest);
    if (tally[plan.action] !== undefined) tally[plan.action] += 1;
    if (plan.action !== "none") {
      acting.push({ employee_id: r.employee_id, action: plan.action, period_no: r.period_no });
    }
  }
  return { tally, acting };
}

/** Real transitions, taken from event timestamps - never from updated_at. */
async function transitions() {
  const where = SINCE === null ? "" : "WHERE e.created_at >= ?";
  const params = SINCE === null ? [] : [new Date(SINCE)];
  const byType = await q(
    `SELECT e.event_type,
            JSON_UNQUOTE(JSON_EXTRACT(e.detail_json, '$.reason')) AS reason,
            COUNT(*) AS n,
            MIN(e.created_at) AS first_at,
            MAX(e.created_at) AS last_at
       FROM employee_lifecycle_event e ${where}
      GROUP BY e.event_type, reason ORDER BY n DESC`,
    params
  );
  const recent = await q(
    `SELECT e.event_id, e.employee_id, e.period_id, e.event_type,
            JSON_UNQUOTE(JSON_EXTRACT(e.detail_json, '$.reason')) AS reason, e.created_at
       FROM employee_lifecycle_event e ${where}
      ORDER BY e.event_id DESC LIMIT ?`,
    [...params, DETAIL]
  );
  return { byType, recent };
}

/* ==========================================================================
 *  report
 * ====================================================================== */
const line = (label, value) => console.log(`   ${String(label).padEnd(46)} ${value}`);

function showFindings(list, heading) {
  if (list.length === 0) {
    console.log(`\n   ${heading}: none`);
    return;
  }
  console.log(`\n   ${heading}: ${list.length} kind(s)`);
  for (const f of list) {
    console.log(`     [${f.code}] ${f.message} — ${f.count}`);
    for (const r of f.rows.slice(0, DETAIL)) {
      console.log(`        ${JSON.stringify(r)}`);
    }
    if (f.rows.length > DETAIL) console.log(`        ... and ${f.rows.length - DETAIL} more`);
  }
}

async function main() {
  console.log(`\n== Stage 0C / C1d lifecycle validation — '${DB}'   ${new Date().toISOString()}`);
  console.log("   mode: check (READ ONLY — this script issues SELECTs and nothing else)");

  const active = await scalar("SELECT DATABASE() AS d");
  if (String(active) !== DB) die(`connected to '${active}', not '${DB}'`);

  const locale = String(await scalar("SELECT @@lc_time_names AS l"));
  if (locale !== "en_US") {
    die(`lc_time_names is '${locale}', not en_US — every long-form joining date would read as NULL`);
  }
  line("database", active);
  line("mysql", await scalar("SELECT VERSION() v"));
  line("lc_time_names", locale);
  if (SINCE) line("--since", SINCE);

  for (const t of ["employee_employment_period", "employee_lifecycle_event"]) {
    const n = await count(
      "SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [DB, t]
    );
    if (n !== 1) die(`${t} is missing — C1a is not applied to this schema`);
  }

  const snapshot = await q(SNAPSHOT);

  console.log("\n== population");
  const pop = await population();
  line("employees", pop.employees);
  line("  active (status = 1)", pop.active);
  line("  inactive", pop.inactive);
  line("employment periods", pop.periods);
  line("  backfill (C1b)", pop.backfill);
  line("  local (runtime, C1c)", pop.local);
  line("  open", pop.openPeriods);
  line("  flagged needs_review", pop.needsReview);
  line("employees with more than one period", pop.multiPeriod);
  line("maximum period_no", pop.maxPeriodNo);
  line("lifecycle events", pop.events);

  const st = await structure();
  const sq = await sequence();
  const dt = await dates(snapshot);
  const ev = await events();

  console.log("\n== current-state consistency");
  line("active employees with no open period", st.activeNoOpen.length);
  line("employees with multiple open periods", st.multiOpen.length);
  line("inactive employees with an open period", st.inactiveOpen.length);
  line("employees with no period at all", st.noPeriod.length);
  line("orphan periods", st.orphan.length);
  line("duplicate (employee_id, period_no)", st.dupSeq.length);

  console.log("\n== period sequence integrity");
  line("first period_no is not 1", sq.notFromOne.length);
  line("gap in the sequence", sq.gaps.length);
  line("open period that is not the newest", sq.openNotLatest.length);

  console.log("\n== dates");
  line("ended_on before joined_on (ERROR)", dt.badOrder.length);
  line("master date_of_joining unreadable", dt.unreadable.length);
  line("periods with unknown joined_on", dt.unknownJoin.length);
  line("closed periods with unknown ended_on", dt.unknownEnd.length);
  line("single-period master/period date conflict", dt.conflicts.length);
  line("stale original date on a rejoined employee", dt.staleRejoin.length);

  console.log("\n== lifecycle events");
  line("runtime periods with no event", ev.eventless.length);
  line("events referencing a missing employee", ev.missingEmployee.length);
  line("events referencing a missing period", ev.missingPeriod.length);
  line("periods with a duplicate opening event", ev.dupOpen.length);
  line("periods with a duplicate closure event", ev.dupClose.length);
  line("closure events on a still-open period", ev.contradiction.length);
  line("backfilled periods carrying an event", ev.backfillWithEvent.length);

  console.log("\n== authentication lifecycle");
  const au = await auth();
  line("AUTH_TOKEN_VALID_FROM_ENABLED (as this process reads it)", au.tokenValidFromEnabled);
  line("users with a session cutoff set", au.usersWithCutoff);
  if (au.recentCutoff !== null) line(`users whose cutoff moved since --since`, au.recentCutoff);
  line("revocation wired on resignation (close)", au.revokeOnClose);
  line("revocation wired on rejoin", au.revokeOnRejoin);
  line("revocation NOT wired on initial join", au.revokeOnInitialJoin === false);
  line("bumpTokenValidFromByEmployeeId call present", au.callSitePresent);
  if (au.tokenValidFromEnabled === false) {
    addError(
      "SESSION_CUTOFF_DISABLED",
      "AUTH_TOKEN_VALID_FROM_ENABLED is false: a rejoin would not revoke a pre-resignation token",
      []
    );
  }
  if (au.revokeOnRejoin !== true || au.revokeOnClose !== true) {
    addError("REVOCATION_NOT_WIRED", "the lifecycle runtime no longer revokes sessions on a rejoin or a closure", []);
  }
  console.log("   (no token, hash or secret is read or printed)");

  console.log("\n== Digisme exit readiness");
  const ex = await exitReadiness();
  line("unknown joining dates ONLY Digisme can supply", ex.joinOnlyDigisme);
  line("  recoverable from the local master already", ex.joinRecoverableLocally);
  line("unknown end dates ONLY Digisme can supply", ex.endOnlyDigisme);
  line("  recoverable from the local master already", ex.endRecoverableLocally);
  console.log(
    "   date_of_joining was never carried by the Digisme sync mapper, so for a blank\n" +
      "   master column Digisme's own record is the only source, and only until expiry."
  );

  console.log("\n== forecast: what a reconciliation would do now");
  const fc = forecast(snapshot);
  for (const [k, v] of Object.entries(fc.tally)) line(`  ${k}`, v);
  line("employees that would be written", fc.acting.length);
  for (const a of fc.acting.slice(0, DETAIL)) console.log(`        ${JSON.stringify(a)}`);
  if (fc.acting.length > DETAIL) console.log(`        ... and ${fc.acting.length - DETAIL} more`);

  console.log(`\n== real transitions${SINCE ? ` since ${SINCE}` : " (all time)"}`);
  const tr = await transitions();
  if (tr.byType.length === 0) {
    console.log("   none recorded");
  } else {
    for (const t of tr.byType) {
      console.log(`   ${String(t.event_type).padEnd(20)} ${String(t.reason || "-").padEnd(16)} ${t.n}   ${t.first_at} .. ${t.last_at}`);
    }
    console.log("   most recent:");
    for (const r of tr.recent) console.log(`        ${JSON.stringify(r)}`);
  }
  console.log("   (counted from lifecycle event timestamps, never from updated_at)");

  showFindings(errors, "ERRORS");
  showFindings(warnings, "WARNINGS");
  for (const n of notes) console.log(`\n   note: ${n}`);

  if (AS_JSON) {
    console.log("\n== json");
    console.log(JSON.stringify({ population: pop, auth: au, exitReadiness: ex, forecast: fc.tally, errors, warnings }, null, 2));
  }

  const errCount = errors.reduce((n, e) => n + 1, 0);
  const warnRows = warnings.reduce((n, w) => n + w.count, 0);
  console.log(
    `\n   ${errCount} error kind(s), ${warnings.length} warning kind(s) covering ${warnRows} row(s).`
  );
  console.log("   C1d does not repair anything. Nothing was written.");

  if (errCount > 0) {
    console.log("\nC1D LIFECYCLE VALIDATION: FAILED");
    process.exit(1);
  }
  console.log("\nC1D LIFECYCLE VALIDATION: PASSED");
}

process.on("unhandledRejection", (err) => die(`unhandled rejection: ${(err && err.message) || err}`));
main()
  .catch((err) => die((err && err.message) || String(err)))
  .finally(() => conn.end());
