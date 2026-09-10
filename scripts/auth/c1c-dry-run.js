#!/usr/bin/env node
/**
 * Stage 0C / C1c — what the FIRST reconciliation would do. READ ONLY.
 *
 *   c1c-dry-run.js --db <schema> [--config config.json] [--examples 5]
 *
 * Runs the real `decide()` from usecase/employee_lifecycle.js over every
 * employee and reports the plan it produces, without executing any of it.
 * There is not one INSERT, UPDATE, DELETE or ALTER in this file, and it
 * never opens a transaction: every statement is a SELECT.
 *
 * It is the same decision the reconciler would take, not a re-implementation
 * of it in SQL - so a rule that changed in the usecase changes this report
 * too, and the two cannot drift.
 *
 * Employee names are never printed. Where examples help, only employee_id,
 * the dates involved, and the raw `date_of_joining` text are shown, because
 * that text is exactly what a human needs in order to resolve a flagged row.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const { JOINED_ON } = require(path.join(ROOT, "utils/joining_date"));
const { decide, toDateOnly } = require(path.join(ROOT, "usecase/employee_lifecycle"));

const die = (msg) => {
  process.stderr.write(`\nFAIL: ${msg}\n`);
  process.exit(1);
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const DB = arg("db", "");
const EXAMPLES = Number(arg("examples", 5));
if (!DB) die("--db <schema> is required");

/* ---------------------------------------------------------------- connect */
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

/**
 * Every employee with their newest period and the end date of the one
 * before it - exactly the two rows `reconcileEmployee` reads, fetched in one
 * pass instead of 630 transactions.
 */
const SNAPSHOT_SQL = `
SELECT
  ne.employee_id,
  ne.status,
  ne.resignation_date,
  ne.date_of_joining AS raw_date_of_joining,
  (${JOINED_ON("ne")}) AS parsed_joined_on,
  cur.period_id, cur.period_no, cur.period_state, cur.joined_on, cur.ended_on,
  cur.source, cur.needs_review,
  ( SELECT prev.ended_on
      FROM employee_employment_period prev
     WHERE prev.employee_id = cur.employee_id
       AND prev.period_no < cur.period_no
     ORDER BY prev.period_no DESC LIMIT 1 ) AS prev_ended_on
FROM new_employee ne
LEFT JOIN (
  SELECT p.*
    FROM employee_employment_period p
    JOIN ( SELECT employee_id, MAX(period_no) AS period_no
             FROM employee_employment_period GROUP BY employee_id ) latest
      ON latest.employee_id = p.employee_id AND latest.period_no = p.period_no
) cur ON cur.employee_id = ne.employee_id
ORDER BY ne.employee_id`;

const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));

async function main() {
  console.log(`\n== Stage 0C / C1c DRY RUN on '${DB}'   ${new Date().toISOString()}`);
  console.log("   read-only: this script issues SELECTs and nothing else\n");

  const active = await scalar("SELECT DATABASE() AS d");
  if (String(active) !== DB) die(`connected to '${active}', not '${DB}'`);
  console.log(`   active database        ${active}`);

  const locale = await scalar("SELECT @@lc_time_names AS l");
  if (String(locale) !== "en_US") {
    die(`lc_time_names is '${locale}', not en_US - every long-form date would read as NULL`);
  }
  console.log(`   lc_time_names          ${locale}`);
  console.log(`   mysql                  ${await scalar("SELECT VERSION() AS v")}`);

  const totals = {
    employees: Number(await scalar("SELECT COUNT(*) AS c FROM new_employee")),
    periods: Number(await scalar("SELECT COUNT(*) AS c FROM employee_employment_period")),
    backfill: Number(
      await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'backfill'")
    ),
    local: Number(
      await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'local'")
    ),
    events: Number(await scalar("SELECT COUNT(*) AS c FROM employee_lifecycle_event")),
    review: Number(
      await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE needs_review = 1")
    ),
  };
  console.log(
    `\n   ${totals.employees} employees, ${totals.periods} period(s) ` +
      `(${totals.backfill} backfill, ${totals.local} local), ${totals.events} event(s), ` +
      `${totals.review} flagged for review`
  );

  const rows = await q(SNAPSHOT_SQL);

  const bucket = {
    none: [], open_initial: [], open_rejoin: [], close: [], fill: [],
  };
  /** A–G, as the question asked them. */
  const cat = { A: [], B: [], C: [], D: [], E: [], F: [], G: [] };
  /** What a fill would actually touch. */
  const fillEnded = [];
  const fillJoined = [];
  const fillOnBackfill = [];

  for (const r of rows) {
    const employee = {
      employee_id: r.employee_id,
      status: r.status,
      resignation_date: r.resignation_date,
      raw_date_of_joining: r.raw_date_of_joining,
      parsed_joined_on: r.parsed_joined_on,
    };
    const latest = r.period_id === null ? null : {
      period_id: r.period_id,
      period_no: r.period_no,
      period_state: r.period_state,
      joined_on: r.joined_on,
      ended_on: r.ended_on,
      prev_ended_on: r.prev_ended_on,
    };
    const plan = decide(employee, latest);
    const isBackfill = String(r.source) === "backfill";

    const note = {
      employee_id: r.employee_id,
      period_no: r.period_no,
      source: r.source,
      joined_on: toDateOnly(r.joined_on),
      ended_on: toDateOnly(r.ended_on),
      master_resignation_date: toDateOnly(r.resignation_date),
      raw_date_of_joining: r.raw_date_of_joining,
    };

    bucket[plan.action] && bucket[plan.action].push(note);

    /* -- A: closed backfill periods with no end date ---------------------- */
    if (isBackfill && r.period_state === "closed" && r.ended_on === null) {
      cat.A.push(note);
      const wouldFillEnd =
        plan.action === "fill" && plan.fills.some((f) => f.column === "ended_on");
      if (wouldFillEnd) cat.B.push({ ...note, would_set_ended_on: toDateOnly(r.resignation_date) });
      else cat.C.push(note);
    }

    /* -- D/E/F ------------------------------------------------------------ */
    if (plan.action === "close" && isBackfill) cat.D.push(note);
    if (plan.action === "open_rejoin") cat.E.push(note);
    if (plan.action === "open_initial") cat.F.push(note);

    /* -- G: a master date the rules refuse ------------------------------- */
    const parsed = toDateOnly(r.parsed_joined_on);
    const resDate = toDateOnly(r.resignation_date);
    if (plan.action === "close" && resDate !== null && plan.ended_on === null) {
      cat.G.push({ ...note, refused: "resignation_date precedes joined_on", value: resDate });
    }
    if (plan.action === "open_rejoin" && parsed !== null && plan.period.joined_on === null) {
      cat.G.push({ ...note, refused: "date_of_joining does not postdate the previous period", value: parsed });
    }
    // Only a period being created CLOSED can refuse an end date. An active
    // employee's new period has ended_on NULL because they are employed, not
    // because anything was rejected - counting that as a refusal would flag
    // every active employee who still carries a stale resignation_date.
    if (
      plan.action === "open_initial" &&
      plan.period.period_state === "closed" &&
      resDate !== null &&
      plan.period.ended_on === null
    ) {
      cat.G.push({ ...note, refused: "resignation_date precedes joined_on (new closed period)", value: resDate });
    }
    if (
      plan.action !== "fill" && latest && latest.joined_on === null && parsed !== null &&
      !(plan.action === "close" || plan.action === "open_rejoin")
    ) {
      cat.G.push({ ...note, refused: "date_of_joining not usable for this period", value: parsed });
    }

    /* -- what a fill would touch ----------------------------------------- */
    if (plan.action === "fill") {
      if (isBackfill) fillOnBackfill.push(note);
      for (const f of plan.fills) {
        (f.column === "ended_on" ? fillEnded : fillJoined).push({ ...note, value: f.value });
      }
    }
  }

  /* ------------------------------------------------------------- report -- */
  const show = (label, list) => {
    console.log(`\n   ${label}: ${list.length}`);
    for (const e of list.slice(0, EXAMPLES)) {
      const bits = [`employee ${e.employee_id}`];
      if (e.period_no !== undefined && e.period_no !== null) bits.push(`period ${e.period_no} (${e.source})`);
      if (e.joined_on !== undefined) bits.push(`joined_on ${e.joined_on === null ? "NULL" : e.joined_on}`);
      if (e.ended_on !== undefined) bits.push(`ended_on ${e.ended_on === null ? "NULL" : e.ended_on}`);
      if (e.would_set_ended_on) bits.push(`-> ended_on ${e.would_set_ended_on}`);
      if (e.refused) bits.push(`REFUSED: ${e.refused} (${e.value})`);
      if (e.raw_date_of_joining) bits.push(`raw ${JSON.stringify(e.raw_date_of_joining)}`);
      console.log(`     ${bits.join("  ")}`);
    }
    if (list.length > EXAMPLES) console.log(`     ... and ${list.length - EXAMPLES} more`);
  };

  console.log("\n== what the first reconciliation would do");
  for (const [action, list] of Object.entries(bucket)) {
    console.log(`   ${action.padEnd(14)} ${String(list.length).padStart(5)}`);
  }
  const touching = rows.length - bucket.none.length;
  console.log(
    `   ${"".padEnd(14)} ${String(touching).padStart(5)} employee(s) would be written to ` +
      `(${pct(touching, rows.length)}% of ${rows.length})`
  );

  console.log("\n== A-G");
  show("A. closed backfill periods with ended_on IS NULL", cat.A);
  show("B.   of those, C1c would fill ended_on", cat.B);
  show("C.   of those, would stay NULL / needs_review", cat.C);
  show("D. open backfill periods whose master disagrees -> close", cat.D);
  show("E. latest closed but master active -> rejoin period", cat.E);
  show("F. employees with no period at all -> initial period", cat.F);
  show("G. master dates the rules would refuse", cat.G);

  console.log("\n== the safety question: are backfill rows written to?");
  console.log(`   backfill rows a 'fill' would UPDATE:        ${fillOnBackfill.length}`);
  console.log(`     of which ended_on filled:                 ${fillEnded.filter((f) => f.source === "backfill").length}`);
  console.log(`     of which joined_on filled:                ${fillJoined.filter((f) => f.source === "backfill").length}`);
  console.log(`   backfill rows a 'close' would UPDATE:       ${cat.D.length}`);
  console.log(
    `   backfill rows otherwise untouched:          ` +
      `${totals.backfill - fillOnBackfill.length - cat.D.length}`
  );
  console.log(
    `\n   lifecycle events that would be created:     ` +
      `${touching}   (one per real transition; none for a no-op)`
  );

  console.log("\nC1C DRY RUN: complete. Nothing was written.");
}

process.on("unhandledRejection", (err) => die(`unhandled rejection: ${(err && err.message) || err}`));
main()
  .catch((err) => die((err && err.message) || String(err)))
  .finally(() => conn.end());
