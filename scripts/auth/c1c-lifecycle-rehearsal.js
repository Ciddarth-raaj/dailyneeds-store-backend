#!/usr/bin/env node
/**
 * Stage 0C / C1c — drive the real lifecycle reconciler through a full
 * employment cycle on a SCRATCH copy.
 *
 *   c1c-lifecycle-rehearsal.js --db <scratch schema> [--config config.json]
 *                              [--keep] [--first-id 990001]
 *
 * WHAT IT REHEARSES
 *
 *   join -> resign -> rejoin -> resign -> rejoin
 *
 * with a repeated reconciliation after EVERY state, plus the three cases the
 * transitions above do not reach: an employee first seen already inactive,
 * a date learned after the fact, and a rejoin whose date_of_joining is stale.
 *
 * It runs `usecase/employee_lifecycle.js` and `repository/employee_lifecycle.js`
 * unmodified, against real MySQL, so the C1a constraints - one open period per
 * employee, unique (employee_id, period_no), ended_on >= joined_on - are the
 * real ones and not a test double.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * No production employee is used as a test subject. The fixtures are new rows
 * with ids in a reserved high range, created here and deleted here; the script
 * refuses to start if any of those ids already exists. Before and after, the
 * 630 backfilled periods and the whole `new_employee` table are checksummed,
 * and a mismatch fails the run.
 *
 * It refuses dnds_prod, and any schema not named like a scratch copy.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");

const die = (msg) => {
  process.stderr.write(`\nFAIL: ${msg}\n`);
  process.exit(1);
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const DB = arg("db", "");
const KEEP = has("keep");
const FIRST_ID = Number(arg("first-id", 990001));

if (!DB) die("--db <scratch schema> is required");
if (DB === "dnds_prod") die("refusing dnds_prod");
if (!/rehearsal|scratch|restore_test/.test(DB)) die(`refusing '${DB}' - not a scratch schema`);
if (!Number.isInteger(FIRST_ID) || FIRST_ID < 100000) die("--first-id must be a high reserved integer");

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m, d) => {
  failures++;
  console.log(`  FAIL  ${m}${d ? `   [${d}]` : ""}`);
};
const eq = (m, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(`${m} (${JSON.stringify(got)})`)
    : bad(m, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

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
  // A pool, because the repository under test checks out its own connection
  // for each transaction - exactly as it does in the running application.
  return mysql.createPool({
    connectionLimit: 5,
    host: block.host,
    port: Number(block.port || 3306),
    user: block.username,
    password: block.password === undefined || block.password === null ? "" : String(block.password),
    database: DB,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const pool = connect();
const q = (sql, params) =>
  new Promise((resolve, reject) =>
    pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const scalar = async (sql, params) => {
  const rows = await q(sql, params);
  return rows && rows[0] ? Object.values(rows[0])[0] : null;
};
/** CHECKSUM TABLE returns { Table, Checksum }; the first column is the NAME. */
const tableChecksum = async (table) => {
  const rows = await q(`CHECKSUM TABLE \`${table}\``);
  return rows && rows[0] ? String(rows[0].Checksum) : null;
};

/* -------------------------------------------------------------- fixtures */
const IDS = {
  CYCLE: FIRST_ID, // join -> resign -> rejoin -> resign -> rejoin
  BORN_INACTIVE: FIRST_ID + 1, // first seen already terminated
  LATE_DATE: FIRST_ID + 2, // joining date learned after the period opened
  STALE_REJOIN: FIRST_ID + 3, // rejoins while date_of_joining still holds the old date
};
const ALL_IDS = Object.values(IDS);

/** The employment periods of one fixture, oldest first. */
const periodsOf = (id) =>
  q(
    `SELECT period_no, period_state, DATE_FORMAT(joined_on,'%Y-%m-%d') AS joined_on,
            DATE_FORMAT(ended_on,'%Y-%m-%d') AS ended_on, end_reason_type, source, needs_review
       FROM employee_employment_period WHERE employee_id = ? ORDER BY period_no`,
    [id]
  );

const eventsOf = (id) =>
  q(
    `SELECT event_type, JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.reason')) AS reason
       FROM employee_lifecycle_event WHERE employee_id = ? ORDER BY event_id`,
    [id]
  );

const shapeOf = async (id) =>
  (await periodsOf(id)).map((p) => [p.period_no, p.period_state, p.joined_on, p.ended_on]);

/* ---------------------------------------------------------------- driver */
async function main() {
  console.log(`\n== Stage 0C / C1c lifecycle rehearsal on '${DB}'   ${new Date().toISOString()}`);

  const active = await scalar("SELECT DATABASE() AS d");
  if (String(active) !== DB) die(`connected to '${active}', not '${DB}'`);
  ok(`active database is ${DB}`);

  const locale = await scalar("SELECT @@lc_time_names AS l");
  if (String(locale) !== "en_US") die(`lc_time_names is '${locale}', not en_US`);
  ok("lc_time_names is en_US");

  for (const t of ["employee_employment_period", "employee_lifecycle_event"]) {
    const n = await scalar(
      "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [DB, t]
    );
    if (String(n) !== "1") die(`${t} is missing - apply C1a first`);
  }

  // Nothing may already occupy the reserved ids.
  const clash = await q(`SELECT employee_id FROM new_employee WHERE employee_id IN (?)`, [ALL_IDS]);
  if (clash.length) die(`reserved fixture ids already in use: ${clash.map((r) => r.employee_id).join(", ")}`);
  ok(`fixture ids ${ALL_IDS[0]}-${ALL_IDS[ALL_IDS.length - 1]} are free`);

  /* ---- the state that must survive untouched ---- */
  const before = {
    employees: Number(await scalar("SELECT COUNT(*) AS c FROM new_employee")),
    empSum: await tableChecksum("new_employee"),
    backfillPeriods: Number(
      await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'backfill'")
    ),
    backfillSum: String(
      await scalar(
        `SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', period_id, employee_id, period_no, period_state,
            IFNULL(joined_on,'-'), IFNULL(ended_on,'-'), IFNULL(end_reason_type,'-'), needs_review))), 0) AS s
           FROM employee_employment_period WHERE source = 'backfill'`
      )
    ),
    events: Number(await scalar("SELECT COUNT(*) AS c FROM employee_lifecycle_event")),
    autoInc: Number(
      await scalar(
        "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'new_employee'",
        [DB]
      )
    ),
  };
  console.log(
    `\n   before: ${before.employees} employees, ${before.backfillPeriods} backfilled period(s), ` +
      `${before.events} lifecycle event(s), AUTO_INCREMENT ${before.autoInc}`
  );

  /* ---- the code under test, wired exactly as server.js wires it ---- */
  const lifecycleRepo = require(path.join(ROOT, "repository/employee_lifecycle"))(pool);
  const userRepo = require(path.join(ROOT, "repository/user"))(pool);
  const uc = require(path.join(ROOT, "usecase/employee_lifecycle"))(lifecycleRepo, userRepo);

  /** A reconcile, then two more, so every step is proved idempotent in place. */
  const reconcile = async (id) => {
    const first = await uc.reconcileEmployee(id);
    const shape = await shapeOf(id);
    const events = (await eventsOf(id)).length;
    for (let i = 0; i < 2; i++) {
      const again = await uc.reconcileEmployee(id);
      if (again.action !== "none") {
        bad(`repeat reconcile of ${id} was not a no-op`, again.action);
      }
    }
    if (JSON.stringify(await shapeOf(id)) !== JSON.stringify(shape)) {
      bad(`repeat reconcile of ${id} changed the periods`);
    }
    if ((await eventsOf(id)).length !== events) {
      bad(`repeat reconcile of ${id} added an event`);
    }
    return first.action;
  };

  const setMaster = (id, patch) =>
    q("UPDATE new_employee SET ? WHERE employee_id = ?", [patch, id]);

  const makeFixture = (id, name, over = {}) =>
    q("INSERT INTO new_employee SET ?", [
      { employee_id: id, employee_name: name, status: 1, date_of_joining: null, ...over },
    ]);

  try {
    /* ============================ the full cycle ============================ */
    console.log("\n== join -> resign -> rejoin -> resign -> rejoin");
    const C = IDS.CYCLE;
    await makeFixture(C, "C1C Rehearsal Cycle", { date_of_joining: "01 March 2022" });

    eq("join: period 1 opens", await reconcile(C), "open_initial");
    eq("  shape", await shapeOf(C), [[1, "open", "2022-03-01", null]]);

    await setMaster(C, { status: 0, resignation_date: "2024-05-31" });
    eq("resign: period 1 closes", await reconcile(C), "close");
    eq("  shape", await shapeOf(C), [[1, "closed", "2022-03-01", "2024-05-31"]]);

    await setMaster(C, { status: 1, resignation_date: null, date_of_joining: "01 February 2025" });
    eq("rejoin: period 2 opens", await reconcile(C), "open_rejoin");
    eq("  shape", await shapeOf(C), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "open", "2025-02-01", null],
    ]);

    await setMaster(C, { status: 0, resignation_date: "2026-01-31" });
    eq("resign again: period 2 closes, no period 3", await reconcile(C), "close");
    eq("  shape", await shapeOf(C), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
    ]);

    await setMaster(C, { status: 1, resignation_date: null, date_of_joining: "2026-06-01" });
    eq("rejoin again: period 3 opens", await reconcile(C), "open_rejoin");
    eq("  shape", await shapeOf(C), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
      [3, "open", "2026-06-01", null],
    ]);

    eq(
      "exactly one open period",
      Number(
        await scalar(
          "SELECT COUNT(*) AS c FROM employee_employment_period WHERE employee_id = ? AND period_state = 'open'",
          [C]
        )
      ),
      1
    );
    eq(
      "one permanent employee_id across all three periods",
      (await q("SELECT DISTINCT employee_id FROM employee_employment_period WHERE employee_id = ?", [C])).length,
      1
    );
    eq(
      "five transitions, five events",
      (await eventsOf(C)).map((e) => `${e.event_type}:${e.reason}`),
      [
        "period_opened:initial_join",
        "period_closed:resignation",
        "period_opened:rejoin",
        "period_closed:resignation",
        "period_opened:rejoin",
      ]
    );

    /* ==================== an employee first seen inactive ==================== */
    console.log("\n== an employee who is already terminated when first seen");
    const B = IDS.BORN_INACTIVE;
    await makeFixture(B, "C1C Rehearsal Born Inactive", {
      status: 0,
      date_of_joining: "15 July 2021",
      resignation_date: "2023-08-31",
    });
    eq("period 1 is created closed", await reconcile(B), "open_initial");
    eq("  shape", await shapeOf(B), [[1, "closed", "2021-07-15", "2023-08-31"]]);
    eq(
      "one event, and no invented closure",
      (await eventsOf(B)).map((e) => `${e.event_type}:${e.reason}`),
      ["period_opened:initial_join"]
    );

    /* ======================== a date learned later ========================== */
    console.log("\n== a joining date that arrives after the period was opened");
    const L = IDS.LATE_DATE;
    await makeFixture(L, "C1C Rehearsal Late Date");
    eq("opens with joined_on NULL", await reconcile(L), "open_initial");
    eq("  shape", await shapeOf(L), [[1, "open", null, null]]);
    eq("  flagged for review", (await periodsOf(L))[0].needs_review, 1);

    await setMaster(L, { date_of_joining: "09 September 2021" });
    eq("the NULL is filled", await reconcile(L), "fill");
    eq("  shape", await shapeOf(L), [[1, "open", "2021-09-09", null]]);
    eq("  review clears", (await periodsOf(L))[0].needs_review, 0);

    await setMaster(L, { date_of_joining: "01 January 2000" });
    eq("a known date is not overwritten", await reconcile(L), "none");
    eq("  shape", await shapeOf(L), [[1, "open", "2021-09-09", null]]);

    /* ===================== a rejoin with a stale date ======================= */
    console.log("\n== a rejoin while date_of_joining still holds the ORIGINAL date");
    const S = IDS.STALE_REJOIN;
    await makeFixture(S, "C1C Rehearsal Stale Rejoin", { date_of_joining: "10 January 2022" });
    await reconcile(S);
    await setMaster(S, { status: 0, resignation_date: "2024-09-30" });
    await reconcile(S);
    // date_of_joining deliberately unchanged: this is what Digisme actually
    // leaves behind, because the sync mapper does not carry the field at all.
    await setMaster(S, { status: 1, resignation_date: null });
    eq("period 2 opens", await reconcile(S), "open_rejoin");
    eq(
      "  the 2022 date is NOT written onto period 2",
      await shapeOf(S),
      [
        [1, "closed", "2022-01-10", "2024-09-30"],
        [2, "open", null, null],
      ]
    );
    eq("  and it is flagged for review", (await periodsOf(S))[1].needs_review, 1);

    /* ========================= reconcileAll is quiet ======================== */
    console.log("\n== a whole-estate pass over the restored copy");
    const summary = await uc.reconcileAll();
    console.log(
      `   candidates ${summary.candidates}: opened ${summary.open_initial}, rejoined ${summary.open_rejoin}, ` +
        `closed ${summary.close}, filled ${summary.fill}, no-op ${summary.none}, failed ${summary.failed}`
    );
    eq("no employee failed", summary.failed, 0);
    eq("the fixtures are settled, so nothing was opened or closed", [
      summary.open_initial,
      summary.open_rejoin,
      summary.close,
    ], [0, 0, 0]);

    /* =================== the production-derived rows are intact ============== */
    console.log("\n== the restored production data");
    eq(
      "backfilled period count unchanged",
      Number(await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'backfill'")),
      before.backfillPeriods
    );
    eq(
      "backfilled period contents unchanged",
      String(
        await scalar(
          `SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', period_id, employee_id, period_no, period_state,
              IFNULL(joined_on,'-'), IFNULL(ended_on,'-'), IFNULL(end_reason_type,'-'), needs_review))), 0) AS s
             FROM employee_employment_period WHERE source = 'backfill'`
        )
      ),
      before.backfillSum
    );
    eq(
      "no lifecycle event was attached to a backfilled period",
      Number(
        await scalar(
          `SELECT COUNT(*) AS c FROM employee_lifecycle_event e
             JOIN employee_employment_period p ON p.period_id = e.period_id
            WHERE p.source = 'backfill'`
        )
      ),
      0
    );
    eq(
      "no real employee gained a period",
      Number(
        await scalar(
          `SELECT COUNT(*) AS c FROM employee_employment_period WHERE source = 'local' AND employee_id NOT IN (?)`,
          [ALL_IDS]
        )
      ),
      0
    );
  } catch (err) {
    bad("the rehearsal threw", err.message);
    console.error(err);
  } finally {
    /* ------------------------------------------------------------ cleanup */
    if (KEEP) {
      console.log(`\n== --keep given: fixtures ${ALL_IDS.join(", ")} left in place`);
    } else {
      console.log("\n== cleanup");
      try {
        // Events first, then periods, then the employees: both FKs are
        // ON DELETE RESTRICT, so the order is the schema's, not a preference.
        const e = await q("DELETE FROM employee_lifecycle_event WHERE employee_id IN (?)", [ALL_IDS]);
        const p = await q("DELETE FROM employee_employment_period WHERE employee_id IN (?)", [ALL_IDS]);
        const m = await q("DELETE FROM new_employee WHERE employee_id IN (?)", [ALL_IDS]);
        console.log(`   removed ${e.affectedRows} event(s), ${p.affectedRows} period(s), ${m.affectedRows} employee(s)`);
        // The fixture ids were explicit, so AUTO_INCREMENT moved past them.
        await q(`ALTER TABLE new_employee AUTO_INCREMENT = ${before.autoInc}`);
      } catch (err) {
        bad("cleanup failed - the copy still holds fixtures", err.message);
      }

      eq(
        "no fixture employee remains",
        Number(await scalar("SELECT COUNT(*) AS c FROM new_employee WHERE employee_id IN (?)", [ALL_IDS])),
        0
      );
      eq(
        "no fixture period remains",
        Number(
          await scalar("SELECT COUNT(*) AS c FROM employee_employment_period WHERE employee_id IN (?)", [ALL_IDS])
        ),
        0
      );
      eq(
        "no fixture event remains",
        Number(await scalar("SELECT COUNT(*) AS c FROM employee_lifecycle_event WHERE employee_id IN (?)", [ALL_IDS])),
        0
      );
      eq(
        "employee count is back where it started",
        Number(await scalar("SELECT COUNT(*) AS c FROM new_employee")),
        before.employees
      );
      eq(
        "new_employee checksum is back where it started",
        await tableChecksum("new_employee"),
        before.empSum
      );
      eq(
        "lifecycle event count is back where it started",
        Number(await scalar("SELECT COUNT(*) AS c FROM employee_lifecycle_event")),
        before.events
      );
      eq(
        "AUTO_INCREMENT restored",
        Number(
          await scalar(
            "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'new_employee'",
            [DB]
          )
        ),
        before.autoInc
      );
    }

    await new Promise((r) => pool.end(() => r()));
  }

  if (failures > 0) {
    console.log(`\nC1C LIFECYCLE REHEARSAL: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nC1C LIFECYCLE REHEARSAL: ALL CHECKS PASSED");
}

process.on("unhandledRejection", (err) => die(`unhandled rejection: ${(err && err.message) || err}`));
main().catch((err) => die((err && err.message) || String(err)));
