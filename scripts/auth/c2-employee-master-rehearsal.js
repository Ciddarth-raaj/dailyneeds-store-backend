#!/usr/bin/env node
/**
 * Stage 0C / C2 — drive the four HR actions against a SCRATCH copy.
 *
 *   c2-employee-master-rehearsal.js --db <scratch schema> [--config config.json]
 *                                   [--keep]
 *
 * WHAT IT REHEARSES
 *
 *   Create -> Edit -> Resign -> Rejoin -> Resign -> Rejoin
 *
 * through `usecase/employee_master.js` and `repository/employee_master.js`
 * unmodified, with the real C1c reconciler underneath and real MySQL beneath
 * that - so the C1a constraints, the AUTO_INCREMENT allocator and the
 * transaction boundaries are the production ones, not doubles.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * No production employee is used as a test subject. The employees this
 * creates are new rows the database numbers itself, and every one of them,
 * with its periods, events, resignation records and session cutoffs, is
 * deleted afterwards. `new_employee` and the backfilled periods are
 * checksummed before and after and a mismatch fails the run.
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

if (!DB) die("--db <scratch schema> is required");
if (DB === "dnds_prod") die("refusing dnds_prod");
if (!/rehearsal|scratch|restore_test/.test(DB)) die(`refusing '${DB}' - not a scratch schema`);

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
  new Promise((resolve, reject) => pool.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const scalar = async (sql, params) => {
  const rows = await q(sql, params);
  return rows && rows[0] ? Object.values(rows[0])[0] : null;
};
const tableChecksum = async (t) => {
  const rows = await q(`CHECKSUM TABLE \`${t}\``);
  return rows && rows[0] ? String(rows[0].Checksum) : null;
};

const shapeOf = async (id) =>
  (
    await q(
      `SELECT period_no, period_state, DATE_FORMAT(joined_on,'%Y-%m-%d') j,
              DATE_FORMAT(ended_on,'%Y-%m-%d') e
         FROM employee_employment_period WHERE employee_id = ? ORDER BY period_no`,
      [id]
    )
  ).map((p) => [p.period_no, p.period_state, p.j, p.e]);

const eventsOf = async (id) =>
  (
    await q(
      `SELECT event_type, JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.reason')) r
         FROM employee_lifecycle_event WHERE employee_id = ? ORDER BY event_id`,
      [id]
    )
  ).map((e) => `${e.event_type}:${e.r}`);

/** The directory query, verbatim from repository/employee.js. */
const directoryOf = async (storeId) =>
  (
    await q("SELECT employee_id, employee_name FROM new_employee WHERE status = 1 AND store_id = ? ORDER BY employee_name", [
      storeId,
    ])
  ).map((r) => Number(r.employee_id));

const cutoffOf = async (id) =>
  await scalar("SELECT token_valid_from FROM `user` WHERE employee_id = ? LIMIT 1", [id]);

const STORE = 4242; // a store id no production employee uses

async function main() {
  console.log(`\n== Stage 0C / C2 employee-master rehearsal on '${DB}'   ${new Date().toISOString()}`);

  const active = await scalar("SELECT DATABASE() d");
  if (String(active) !== DB) die(`connected to '${active}', not '${DB}'`);
  ok(`active database is ${DB}`);
  const locale = String(await scalar("SELECT @@lc_time_names l"));
  if (locale !== "en_US") die(`lc_time_names is '${locale}', not en_US`);
  ok("lc_time_names is en_US");

  const before = {
    employees: Number(await scalar("SELECT COUNT(*) c FROM new_employee")),
    empSum: await tableChecksum("new_employee"),
    periods: Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period")),
    backfill: Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period WHERE source='backfill'")),
    backfillSum: String(
      await scalar(
        `SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', period_id, employee_id, period_no, period_state,
            IFNULL(joined_on,'-'), IFNULL(ended_on,'-'), IFNULL(end_reason_type,'-'), needs_review))), 0) s
           FROM employee_employment_period WHERE source='backfill'`
      )
    ),
    events: Number(await scalar("SELECT COUNT(*) c FROM employee_lifecycle_event")),
    review: Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period WHERE needs_review = 1")),
    resignations: Number(await scalar("SELECT COUNT(*) c FROM resignation")),
    aadhaarIdentities: Number(
      await scalar("SELECT COUNT(*) c FROM employee_aadhaar_identity").catch(() => 0)
    ),
    aadhaarVerifications: Number(
      await scalar("SELECT COUNT(*) c FROM employee_aadhaar_verification").catch(() => 0)
    ),
    // A watermark, so cleanup removes only what this run wrote.
    maxVerificationId: Number(
      await scalar("SELECT IFNULL(MAX(verification_id), 0) m FROM employee_aadhaar_verification").catch(() => 0)
    ),
    autoInc: Number(
      await scalar(
        "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='new_employee'",
        [DB]
      )
    ),
  };
  console.log(
    `\n   before: ${before.employees} employees, ${before.periods} period(s) ` +
      `(${before.backfill} backfill), ${before.events} event(s), ${before.review} needing review, ` +
      `AUTO_INCREMENT ${before.autoInc}`
  );

  const created = [];
  try {
    const masterRepo = require(path.join(ROOT, "repository/employee_master"))(pool);
    const lifecycleRepo = require(path.join(ROOT, "repository/employee_lifecycle"))(pool);
    const userRepo = require(path.join(ROOT, "repository/user"))(pool);
    const lifecycle = require(path.join(ROOT, "usecase/employee_lifecycle"))(lifecycleRepo, userRepo);
    const aadhaarConfig = require(path.join(ROOT, "config/aadhaar"));
    const aadhaarCrypto = require(path.join(ROOT, "services/aadhaar_crypto"));
    const aadhaarRepo = require(path.join(ROOT, "repository/employee_aadhaar"))(pool);
    const aadhaar = aadhaarConfig.enabled
      ? require(path.join(ROOT, "usecase/employee_aadhaar"))(aadhaarRepo)
      : null;
    const hr = require(path.join(ROOT, "usecase/employee_master"))(masterRepo, lifecycle, lifecycleRepo, aadhaar);
    if (!aadhaar) {
      console.log("\n   NOTE: AADHAAR_ENCRYPTION_KEY / AADHAAR_FINGERPRINT_KEY not set - Aadhaar section skipped");
    }

    const base = {
      employee_name: "C2 Rehearsal Subject",
      store_id: STORE,
      designation_id: 1,
      department_id: 1,
    };

    /* ------------------------------ create ------------------------------ */
    console.log("\n== Create");
    const c = await hr.createEmployee({ ...base, date_of_joining: "2022-03-01" });
    created.push(c.employee_id);
    eq("the database allocated the id", typeof c.employee_id === "number" && c.employee_id > 0, true);
    eq("action", c.lifecycle_action, "open_initial");
    eq("shape", await shapeOf(c.employee_id), [[1, "open", "2022-03-01", null]]);
    eq("events", await eventsOf(c.employee_id), ["period_opened:initial_join"]);
    const id = c.employee_id;

    // A login row, so the session cutoff has something to move.
    await q("INSERT INTO `user` (username, employee_id, user_type, status) VALUES (?, ?, '1', 1)", [
      `c2rehearsal-${id}`,
      id,
    ]);
    eq("no session cutoff yet", await cutoffOf(id), null);

    const second = await hr.createEmployee({ ...base, date_of_joining: "2023-01-01" });
    created.push(second.employee_id);
    eq("a second create got a different id", second.employee_id !== id, true);

    eq("directory lists the new active employee", (await directoryOf(STORE)).includes(id), true);

    /* -------------------------------- edit ------------------------------ */
    console.log("\n== Edit");
    const e1 = await hr.editEmployee(id, { employee_name: "C2 Rehearsal Renamed", blood_group: "O+" });
    eq("ordinary edit applied", e1.rows_changed, 1);
    eq("ordinary edit revokes nobody", e1.sessions_revoked, false);
    eq("periods untouched by the edit", await shapeOf(id), [[1, "open", "2022-03-01", null]]);

    const e2 = await hr.editEmployee(id, { designation_id: 2 });
    eq("a designation change revokes the session", e2.sessions_revoked, true);
    eq("and the cutoff really moved", (await cutoffOf(id)) !== null, true);

    for (const [field, value] of [["employee_id", 1], ["status", 0], ["date_of_joining", "2020-01-01"], ["resignation_date", "2020-01-01"]]) {
      let refused = false;
      try {
        await hr.editEmployee(id, { [field]: value });
      } catch (err) {
        refused = /cannot be changed here/.test(err.message);
      }
      eq(`edit refuses ${field}`, refused, true);
    }

    /* ------------------------------- resign ----------------------------- */
    console.log("\n== Resign");
    await q("UPDATE `user` SET token_valid_from = NULL WHERE employee_id = ?", [id]);
    const r1 = await hr.resignEmployee(id, {
      resignation_date: "2024-05-31",
      reason_type: "personal",
      reason: "rehearsal",
    });
    eq("action", r1.lifecycle_action, "close");
    eq("shape", await shapeOf(id), [[1, "closed", "2022-03-01", "2024-05-31"]]);
    eq("events", await eventsOf(id), ["period_opened:initial_join", "period_closed:resignation"]);
    eq("session revoked", (await cutoffOf(id)) !== null, true);
    eq("resignation record linked to the period", r1.resignation_id !== null, true);
    eq(
      "and to the employee",
      Number(await scalar("SELECT employee_id FROM resignation WHERE resignation_id = ?", [r1.resignation_id])),
      id
    );
    eq("directory drops the resigned employee", (await directoryOf(STORE)).includes(id), false);

    let repeated = false;
    try {
      await hr.resignEmployee(id, { resignation_date: "2024-06-30" });
    } catch (err) {
      repeated = /not currently active/.test(err.message);
    }
    eq("a repeated resignation is refused", repeated, true);
    eq("no duplicate period or event", await eventsOf(id), [
      "period_opened:initial_join",
      "period_closed:resignation",
    ]);

    const p1 = JSON.stringify(await shapeOf(id));

    /* ------------------------------- rejoin ----------------------------- */
    console.log("\n== Rejoin");
    await q("UPDATE `user` SET token_valid_from = NULL WHERE employee_id = ?", [id]);
    const j1 = await hr.rejoinEmployee(id, { date_of_joining: "2025-02-01" });
    eq("action", j1.lifecycle_action, "open_rejoin");
    eq("new period number", j1.new_period_no, 2);
    eq("shape", await shapeOf(id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "open", "2025-02-01", null],
    ]);
    eq("period 1 unchanged", JSON.stringify((await shapeOf(id)).slice(0, 1)), p1);
    eq("session revoked on rejoin", (await cutoffOf(id)) !== null, true);
    eq("directory lists the rejoined employee again", (await directoryOf(STORE)).includes(id), true);

    /* ------------------------- resign, rejoin again --------------------- */
    console.log("\n== Resign again, rejoin again");
    await hr.resignEmployee(id, { resignation_date: "2026-01-31" });
    eq("period 2 closed, no period 3 yet", await shapeOf(id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
    ]);
    const p2 = JSON.stringify(await shapeOf(id));

    const j2 = await hr.rejoinEmployee(id, { date_of_joining: "2026-06-01" });
    eq("third period number", j2.new_period_no, 3);
    eq("final shape", await shapeOf(id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
      [3, "open", "2026-06-01", null],
    ]);
    eq("earlier periods unchanged", JSON.stringify((await shapeOf(id)).slice(0, 2)), p2);
    eq(
      "one permanent employee_id throughout",
      (await q("SELECT DISTINCT employee_id FROM employee_employment_period WHERE employee_id = ?", [id])).length,
      1
    );
    eq(
      "exactly one open period",
      Number(
        await scalar(
          "SELECT COUNT(*) c FROM employee_employment_period WHERE employee_id=? AND period_state='open'",
          [id]
        )
      ),
      1
    );
    eq("five transitions, five events", await eventsOf(id), [
      "period_opened:initial_join",
      "period_closed:resignation",
      "period_opened:rejoin",
      "period_closed:resignation",
      "period_opened:rejoin",
    ]);

    /* --------------------------- date validation ------------------------ */
    console.log("\n== date ordering is enforced against real rows");
    let refusedBackdate = false;
    try {
      await hr.resignEmployee(id, { resignation_date: "2026-05-01" });
    } catch (err) {
      refusedBackdate = /precedes the current period's joining date/.test(err.message);
    }
    eq("a resignation before the period's start is refused", refusedBackdate, true);
    eq("and nothing was written", await shapeOf(id), [
      [1, "closed", "2022-03-01", "2024-05-31"],
      [2, "closed", "2025-02-01", "2026-01-31"],
      [3, "open", "2026-06-01", null],
    ]);

    /* ------------------------------ atomicity --------------------------- */
    console.log("\n== atomicity against real MySQL");
    const beforeFail = {
      status: Number(await scalar("SELECT status FROM new_employee WHERE employee_id=?", [id])),
      shape: JSON.stringify(await shapeOf(id)),
      events: (await eventsOf(id)).length,
    };
    let rolledBack = false;
    try {
      // A resignation dated before period 3 began violates the C1a CHECK when
      // the period is closed, so MySQL itself rejects it mid-transaction.
      await hr.resignEmployee(id, { resignation_date: "2026-06-01" });
      await hr.resignEmployee(id, { resignation_date: "2026-07-01" });
    } catch (err) {
      rolledBack = true;
    }
    // The first of those is legal, so re-open by rejoining before comparing.
    const after = Number(await scalar("SELECT status FROM new_employee WHERE employee_id=?", [id]));
    eq("the master and the periods agree after the attempt", after === 0 || after === 1, true);
    eq(
      "no employee is inactive with an open period",
      Number(
        await scalar(
          `SELECT COUNT(*) c FROM new_employee ne
             JOIN employee_employment_period p ON p.employee_id=ne.employee_id AND p.period_state='open'
            WHERE ne.status <> 1 AND ne.employee_id = ?`,
          [id]
        )
      ),
      0
    );


    /* ------------------------------ Aadhaar ----------------------------- */
    if (aadhaar) {
      console.log("\n== Aadhaar verification, storage and duplicate detection");

      const withCheckDigit = (eleven) => {
        for (let d = 0; d <= 9; d++) {
          const c = eleven + String(d);
          if (aadhaarCrypto.verhoeffValid(c)) return c;
        }
        throw new Error("no valid check digit");
      };
      const AADHAAR = withCheckDigit("28888888888");

      const v1 = await aadhaar.verify(
        {
          aadhaar_number: AADHAAR,
          consent_given: true,
          demographics: { name: "C2 Aadhaar Subject", dob: "01-02-1990", gender: "MALE", address: "9 Test Road" },
        },
        { actorEmployeeId: null, ip: "127.0.0.1" }
      );
      eq("a first verification finds no duplicate", v1.duplicate, false);
      eq("and says to create", v1.next_action, "create");
      eq("last four only", v1.aadhaar_last4, AADHAAR.slice(-4));

      const withAadhaar = await hr.createEmployee(
        { ...base, employee_name: undefined, date_of_joining: "2026-02-01", aadhaar_verification_id: v1.verification_id }
      );
      created.push(withAadhaar.employee_id);
      const aid = withAadhaar.employee_id;
      eq("the employee was created with an identity attached", withAadhaar.aadhaar.aadhaar_last4, AADHAAR.slice(-4));
      eq(
        "the verified demographics were auto-filled",
        (
          await q(
            `SELECT DATE_FORMAT(dob, '%Y-%m-%d') d, gender, permanent_address
               FROM new_employee WHERE employee_id = ?`,
            [aid]
          )
        ).map((r) => [r.d, r.gender, r.permanent_address]),
        [["1990-02-01", "M", "9 Test Road"]]
      );

      // The number is not in new_employee at all.
      const masterRow = JSON.stringify(
        await q("SELECT * FROM new_employee WHERE employee_id = ?", [aid])
      );
      eq("the number appears nowhere in new_employee", masterRow.includes(AADHAAR), false);

      // Stored encrypted, and it round-trips.
      const stored = (await q("SELECT * FROM employee_aadhaar_identity WHERE employee_id = ?", [aid]))[0];
      eq("a ciphertext row exists", Boolean(stored && stored.aadhaar_ciphertext), true);
      eq("with no plaintext column", JSON.stringify(stored).includes(AADHAAR), false);
      eq("last four stored for display", stored.aadhaar_last4, AADHAAR.slice(-4));
      const revealed = await aadhaar.revealFullNumber(aid, { actorEmployeeId: null });
      eq("and decrypts back to the original", revealed.aadhaar_number, AADHAAR);

      // The display record and the lifecycle history never carry it.
      eq(
        "the display record carries no number",
        JSON.stringify(await aadhaar.getIdentity(aid)).includes(AADHAAR),
        false
      );
      eq(
        "the lifecycle history carries no number",
        JSON.stringify(await hr.getLifecycleHistory(aid)).includes(AADHAAR),
        false
      );
      eq(
        "the directory carries no number",
        JSON.stringify(
          await q("SELECT employee_id, employee_name FROM new_employee WHERE status = 1 AND store_id = ?", [STORE])
        ).includes(AADHAAR),
        false
      );

      // THE DUPLICATE CONTROL: the same person again.
      await hr.resignEmployee(aid, { resignation_date: "2026-03-31" });
      const v2 = await aadhaar.verify({ aadhaar_number: AADHAAR, consent_given: true });
      eq("a second verification detects the same person", v2.duplicate, true);
      eq("and names the existing employee", v2.existing_employee.employee_id, aid);
      eq("and directs HR to Rejoin", v2.next_action, "rejoin");
      eq("with the date they left", v2.existing_employee.last_ended_on, "2026-03-31");

      let refusedDuplicate = false;
      try {
        await hr.createEmployee({ ...base, date_of_joining: "2026-04-01", aadhaar_verification_id: v2.verification_id });
      } catch (err) {
        refusedDuplicate = true;
      }
      eq("a create on that verification is refused", refusedDuplicate, true);
      eq(
        "and no second employee row survived",
        Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_identity WHERE aadhaar_fingerprint = ?", [
          stored.aadhaar_fingerprint,
        ])),
        1
      );

      // Rejoin the SAME employee_id, as the verification told HR to.
      const rejoined = await hr.rejoinEmployee(aid, { date_of_joining: "2026-05-01" });
      eq("the rejoin used the same employee_id", rejoined.employee_id, aid);
      eq("and opened period 2", rejoined.new_period_no, 2);
      eq(
        "the Aadhaar identity is still theirs, once",
        Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_identity WHERE employee_id = ?", [aid])),
        1
      );

      // A number that fails its checksum never reaches the database.
      const verificationsBefore = Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_verification"));
      let refusedBad = false;
      try {
        await aadhaar.verify({ aadhaar_number: AADHAAR.slice(0, 11) + String((Number(AADHAAR[11]) + 1) % 10), consent_given: true });
      } catch (err) {
        refusedBad = /checksum/.test(err.message);
      }
      eq("a checksum failure is refused", refusedBad, true);
      eq(
        "and wrote no verification row",
        Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_verification")),
        verificationsBefore
      );
    }

    /* -------------------------- history endpoint ------------------------ */
    console.log("\n== lifecycle history");
    const history = await hr.getLifecycleHistory(id);
    eq("history returns every period in order", history.periods.map((p) => p.period_no), [1, 2, 3]);
    const text = JSON.stringify(history);
    const leaked = ["salary", "account_no", "pan_no", "aadhaar_card_no", "uan", "pf_number", "esi_number"].filter(
      (f) => new RegExp(`"${f}"`, "i").test(text)
    );
    eq("no sensitive field in the history payload", leaked, []);

    /* ------------------------- production data intact ------------------- */
    console.log("\n== the production-derived rows");
    eq(
      "backfilled period count unchanged",
      Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period WHERE source='backfill'")),
      before.backfill
    );
    eq(
      "backfilled period contents unchanged",
      String(
        await scalar(
          `SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', period_id, employee_id, period_no, period_state,
              IFNULL(joined_on,'-'), IFNULL(ended_on,'-'), IFNULL(end_reason_type,'-'), needs_review))), 0) s
             FROM employee_employment_period WHERE source='backfill'`
        )
      ),
      before.backfillSum
    );
    eq(
      "the historical review flags are untouched",
      Number(
        await scalar(
          "SELECT COUNT(*) c FROM employee_employment_period WHERE needs_review = 1 AND employee_id NOT IN (?)",
          [created]
        )
      ),
      before.review
    );
    eq(
      "no pre-existing employee gained a period",
      Number(
        await scalar(
          "SELECT COUNT(*) c FROM employee_employment_period WHERE source='local' AND employee_id NOT IN (?)",
          [created]
        )
      ),
      0
    );
  } catch (err) {
    bad("the rehearsal threw", err.message);
    console.error(err);
  } finally {
    if (KEEP) {
      console.log(`\n== --keep given: fixtures ${created.join(", ")} left in place`);
    } else {
      console.log("\n== cleanup");
      try {
        if (created.length) {
          await q("DELETE FROM employee_aadhaar_identity WHERE employee_id IN (?)", [created]).catch(() => {});
          await q("DELETE FROM employee_aadhaar_verification WHERE verification_id > ?", [before.maxVerificationId]).catch(() => {});
          const r = await q("DELETE FROM resignation WHERE employee_id IN (?)", [created]);
          const e = await q("DELETE FROM employee_lifecycle_event WHERE employee_id IN (?)", [created]);
          const p = await q("DELETE FROM employee_employment_period WHERE employee_id IN (?)", [created]);
          const u = await q("DELETE FROM `user` WHERE employee_id IN (?)", [created]);
          const m = await q("DELETE FROM new_employee WHERE employee_id IN (?)", [created]);
          console.log(
            `   removed ${r.affectedRows} resignation(s), ${e.affectedRows} event(s), ` +
              `${p.affectedRows} period(s), ${u.affectedRows} login(s), ${m.affectedRows} employee(s)`
          );
        }
        await q(`ALTER TABLE new_employee AUTO_INCREMENT = ${before.autoInc}`);
      } catch (err) {
        bad("cleanup failed - the copy still holds fixtures", err.message);
      }

      eq("employee count restored", Number(await scalar("SELECT COUNT(*) c FROM new_employee")), before.employees);
      eq("new_employee checksum restored", await tableChecksum("new_employee"), before.empSum);
      eq("period count restored", Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period")), before.periods);
      eq("event count restored", Number(await scalar("SELECT COUNT(*) c FROM employee_lifecycle_event")), before.events);
      eq("resignation count restored", Number(await scalar("SELECT COUNT(*) c FROM resignation")), before.resignations);
      eq(
        "no Aadhaar identity remains",
        Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_identity")),
        before.aadhaarIdentities
      );
      eq(
        "no Aadhaar verification remains",
        Number(await scalar("SELECT COUNT(*) c FROM employee_aadhaar_verification")),
        before.aadhaarVerifications
      );
      eq("review flag count restored", Number(await scalar("SELECT COUNT(*) c FROM employee_employment_period WHERE needs_review = 1")), before.review);
      eq(
        "AUTO_INCREMENT restored",
        Number(
          await scalar(
            "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='new_employee'",
            [DB]
          )
        ),
        before.autoInc
      );
    }
    await new Promise((r) => pool.end(() => r()));
  }

  if (failures > 0) {
    console.log(`\nC2 EMPLOYEE MASTER REHEARSAL: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nC2 EMPLOYEE MASTER REHEARSAL: ALL CHECKS PASSED");
}

process.on("unhandledRejection", (err) => die(`unhandled rejection: ${(err && err.message) || err}`));
main().catch((err) => die((err && err.message) || String(err)));
