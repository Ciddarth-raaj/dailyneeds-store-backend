#!/usr/bin/env node
/**
 * READ-ONLY: why is an ACTIVE employee missing from Employee Master / HR
 * Onboarding / the employee pickers? First case: 1530 - Sathiya Priya.
 *
 *   node employee-directory-visibility.js \
 *     --backend ~/dailyneeds-store-backend --env development --employee 1530
 *
 * DESIGNED TO RUN FROM A COPY OUTSIDE THE DEPLOYED CHECKOUT (for example
 * ~/dnds-diag/), so nothing is added to the directory production deploys
 * from. `--backend` names that checkout: its `config.json` supplies the
 * connection (the password is never printed), its `node_modules/mysql` is the
 * driver, and its DEPLOYED `repository/employee.js` + `repository/resignation.js`
 * are what decide `listed_before_fix` - so the "before" answer is the
 * production code's own answer, not a transcription of it.
 *
 * `--env` IS REQUIRED. `server.js` reads `config.db.mysql[NODE_ENV]`, and
 * `docs/auth-stage0a-preproduction-readiness.md` records that the live PM2
 * process runs with NODE_ENV UNSET - i.e. the "development" block is the live
 * database. Confirm the live process's value first and pass the same one.
 *
 * WRITES NOTHING. Two independent locks, as in `lib/read_only_db.js`:
 *   1. every pooled connection runs `SET SESSION TRANSACTION READ ONLY`
 *      before anything else, so the SERVER refuses a write - and block 0
 *      reads the session flag back and aborts if it is not set;
 *   2. every statement is inspected before it is sent; anything that is not a
 *      plain SELECT is refused here and never reaches MySQL.
 * No transaction, no temporary table, no user variable, no lock.
 *
 * PRINTS no password, no Aadhaar, PAN, bank, salary or phone VALUE. Where a
 * sensitive column is the evidence (a shared phone or Aadhaar), only the
 * matching employee ids are shown.
 */
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

/* ------------------------------------------------------------- arguments */
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const die = (msg) => {
  console.error(`ABORTED: ${msg}`);
  process.exit(2);
};

const BACKEND = path.resolve((arg("backend") || "").replace(/^~(?=$|\/)/, process.env.HOME || "~"));
const ENV = arg("env");
const EMP = Number(arg("employee"));
if (!arg("backend") || !fs.existsSync(path.join(BACKEND, "repository", "employee.js"))) {
  die("--backend must name the deployed dailyneeds-store-backend checkout");
}
if (!ENV) die("--env is required (the live process's NODE_ENV; 'development' when it is unset)");
if (!Number.isInteger(EMP) || EMP <= 0) die("--employee must be a positive integer");

/* ------------------------------------------------------- read-only handle */
const mysql = require(path.join(BACKEND, "node_modules", "mysql"));
const config = JSON.parse(fs.readFileSync(path.join(BACKEND, "config.json"), "utf8"));
const dbc = config && config.db && config.db.mysql && config.db.mysql[ENV];
if (!dbc) die(`config.db.mysql["${ENV}"] not found in ${BACKEND}/config.json`);

const pool = mysql.createPool({
  connectionLimit: 1,
  host: dbc.host,
  user: dbc.username,
  password: dbc.password,
  database: dbc.database,
  port: dbc.port,
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
});
pool.on("connection", (c) => c.query("SET SESSION TRANSACTION READ ONLY"));

const isRead = (sql) => {
  const text = String(sql && typeof sql === "object" ? sql.sql : sql)
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "")
    .trim();
  return (
    /^(SELECT|\(\s*SELECT)\b/i.test(text) &&
    !/\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(text)
  );
};
const handle = {
  query(sql, params, cb) {
    const callback = typeof params === "function" ? params : cb;
    const values = typeof params === "function" ? [] : params;
    if (!isRead(sql)) {
      callback(new Error(`READ-ONLY refused a non-SELECT statement: ${String(sql).trim().slice(0, 80)}`));
      return;
    }
    pool.query(sql, values, callback);
  },
  getConnection() {
    throw new Error("READ-ONLY: transactions are not available");
  },
};
const select = (sql, params = []) =>
  new Promise((resolve, reject) => handle.query(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));

/* ----------------------------------------------------------------- output */
const out = (label, value) => {
  console.log(`\n=== ${label}`);
  if (Array.isArray(value) && value.length && typeof value[0] === "object") console.table(value);
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const yn = (b) => (b === null || b === undefined ? "unknown" : b ? 1 : 0);

/* ----------------------------------------------- schema-tolerant helpers */
const colCache = new Map();
async function columns(table) {
  if (colCache.has(table)) return colCache.get(table);
  const rows = await select(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table]
  );
  const set = new Set(rows.map((r) => r.c));
  colCache.set(table, set);
  return set;
}
const pick = async (table, wanted, alias = null) => {
  const have = await columns(table);
  return wanted.filter((c) => have.has(c)).map((c) => (alias ? `${alias}.\`${c}\`` : `\`${c}\``));
};
const exists = async (table) => (await columns(table)).size > 0;

/** `resignation.resignation_date` is a VARCHAR; read the formats it holds. */
function parseLooseDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/* =================================================================== run */
(async () => {
  const summary = {};

  /* 0. CONNECTION ---------------------------------------------------------*/
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", BACKEND, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    /* not a git checkout - reported as unknown */
  }
  const [srv] = await select("SELECT DATABASE() AS db, @@version AS version, @@hostname AS server_host");
  let ro = null;
  for (const v of ["@@transaction_read_only", "@@tx_read_only"]) {
    try {
      const [r] = await select(`SELECT ${v} AS ro`);
      ro = Number(r.ro);
      break;
    } catch (e) {
      /* try the other spelling (MySQL 8 vs MariaDB) */
    }
  }
  out("0. CONNECTION (no password shown)", {
    env: ENV,
    config_host: dbc.host,
    config_port: dbc.port,
    config_user: dbc.username,
    database: srv.db,
    server_version: srv.version,
    session_read_only: ro,
    deployed_commit: commit,
  });
  if (ro !== 1) die("the session did not report READ ONLY; nothing further was run");

  /* 1. EMPLOYEE RECORD ----------------------------------------------------*/
  const pk = await select(
    `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'new_employee' AND CONSTRAINT_NAME = 'PRIMARY'`
  );
  const empCols = await pick(
    "new_employee",
    [
      "employee_id", "employee_name", "status", "resignation_date", "date_of_joining",
      "store_id", "designation_id", "department_id", "shift_id", "default_work_shift_id",
      "employment_type", "grade", "payment_type", "pf_applicable", "esi_applicable",
      "attendance_required", "works_all_locations", "online_portal", "created_at", "updated_at",
    ],
    "ne"
  );
  const empRows = await select(
    `SELECT ${empCols.join(", ")},
            CHAR_LENGTH(ne.employee_name) AS name_length, HEX(ne.employee_name) AS name_hex,
            o.outlet_id AS outlet_found, o.outlet_name, d.designation_name
       FROM new_employee ne
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
       LEFT JOIN designation d ON d.designation_id = ne.designation_id
      WHERE ne.employee_id = ?`,
    [EMP]
  );
  out(`1. EMPLOYEE RECORD - new_employee primary key = ${pk.map((r) => r.c).join(",") || "?"}`, empRows);
  if (empRows.length !== 1) {
    out("CLASSIFICATION", `NO new_employee ROW FOR ${EMP} (rows: ${empRows.length}). Not the resignation-name bug.`);
    return;
  }
  const me = empRows[0];
  summary.employee = {
    employee_id: me.employee_id,
    employee_name: me.employee_name,
    status: me.status,
    store_id: me.store_id,
    outlet: me.outlet_name,
    outlet_exists: yn(me.outlet_found !== null),
    date_of_joining: me.date_of_joining,
    resignation_date: me.resignation_date,
  };

  /* 2. SAME / SIMILAR NAMES -----------------------------------------------*/
  const tokens = String(me.employee_name).toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
  const likeArms = tokens.map(() => "LOWER(ne.employee_name) LIKE ?").join(" AND ") || "1 = 0";
  const sameNames = await select(
    `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id, o.outlet_name,
            ne.date_of_joining, ne.resignation_date, ne.created_at,
            (ne.employee_name = ?) AS exact_collation_match
       FROM new_employee ne
       LEFT JOIN outlets o ON o.outlet_id = ne.store_id
      WHERE ne.employee_id <> ? AND (ne.employee_name = ? OR (${likeArms}))
      ORDER BY ne.employee_id`,
    [me.employee_name, EMP, me.employee_name, ...tokens.map((t) => `%${t}%`)]
  );
  out("2. OTHER EMPLOYEES WITH THE SAME OR SIMILAR NAME", sameNames.length ? sameNames : "none");

  /* 3. MATCHING RESIGNATION ROWS, AND WHOSE THEY ARE ----------------------*/
  const resCols = await pick("resignation", [
    "resignation_id", "employee_id", "period_id", "employee_name", "reason_type",
    "resignation_date", "voided_at", "voided_by",
  ], "r");
  const resRows = await select(
    `SELECT ${resCols.join(", ")}, (r.employee_name = ?) AS exact_collation_match
       FROM resignation r
      WHERE r.employee_name = ? OR (${likeArms.replace(/ne\.employee_name/g, "r.employee_name")})
      ORDER BY r.resignation_id`,
    [me.employee_name, me.employee_name, ...tokens.map((t) => `%${t}%`)]
  );
  const exactNamesakes = sameNames.filter((s) => Number(s.exact_collation_match) === 1);
  const myJoin = parseLooseDate(me.date_of_joining);
  const owned = resRows.map((r) => {
    const rd = parseLooseDate(r.resignation_date);
    let owner;
    if (r.voided_at) owner = "VOIDED resignation (still matched by name)";
    else if (r.employee_id !== undefined && r.employee_id !== null && Number(r.employee_id) === EMP)
      owner = myJoin && rd && myJoin > rd
        ? "HERSELF - an EARLIER spell; she was rejoined after it"
        : "HERSELF - and no later rejoin is visible: REVIEW";
    else if (r.employee_id !== undefined && r.employee_id !== null)
      owner = `ANOTHER EMPLOYEE (employee_id ${r.employee_id})`;
    else {
      const inactive = exactNamesakes.filter((s) => Number(s.status) !== 1);
      if (inactive.length === 1) owner = `legacy name-only row - most likely ANOTHER EMPLOYEE (${inactive[0].employee_id}, inactive)`;
      else if (inactive.length > 1) owner = `legacy name-only row - ANOTHER EMPLOYEE, one of ${inactive.map((s) => s.employee_id).join(", ")}`;
      else if (myJoin && rd && myJoin > rd) owner = "legacy name-only row - HERSELF, an earlier spell (joined after it)";
      else owner = "legacy name-only row - NO inactive namesake and no later joining: REVIEW";
    }
    return {
      ...r,
      exact_collation_match: Number(r.exact_collation_match),
      parsed_resignation_date: rd,
      employee_current_joining: myJoin,
      belongs_to: owner,
    };
  });
  out("3. RESIGNATION ROWS MATCHING THE NAME (exact_collation_match = 1 is what the directory uses)",
    owned.length ? owned : "none");
  summary.matching_resignations = owned
    .filter((r) => r.exact_collation_match === 1)
    .map((r) => ({ resignation_id: r.resignation_id, belongs_to: r.belongs_to }));

  /* 4. THE DIRECTORY, AS THE DEPLOYED CODE BUILDS IT ----------------------*/
  // EmployeeUsecase.get() is exactly these two calls (usecase/employee.js);
  // the usecase itself is not loaded because its module pulls in auth config.
  const resignationRepo = require(path.join(BACKEND, "repository", "resignation"))(handle);
  const employeeRepo = require(path.join(BACKEND, "repository", "employee"))(handle);
  const resigned = await resignationRepo.getResignedEmployee();
  const names = resigned.map((r) => r.employee_name);
  const nullNames = names.filter((n) => n === null).length;

  const everyone = await employeeRepo.get(names, {}, null); // HR / admin population
  const ownOutlet = me.store_id === null ? [] : await employeeRepo.get(names, { store_ids: [Number(me.store_id)] }, null);
  const listedBefore = everyone.some((e) => Number(e.employee_id) === EMP);
  const listedBeforeOutlet = ownOutlet.some((e) => Number(e.employee_id) === EMP);

  let listedAfter;
  if (names.length === 0) listedAfter = true;
  else {
    const [a] = await select(
      `SELECT COUNT(*) AS n FROM new_employee
        WHERE employee_id = ? AND (new_employee.employee_name NOT IN (?) OR new_employee.status = 1)`,
      [EMP, names]
    );
    listedAfter = Number(a.n) === 1;
  }
  const search = await employeeRepo.getEmployeeByFilter(String(EMP), null);
  const foundBySearch = search.some((e) => Number(e.employee_id) === EMP);

  const dir = {
    resignation_names_loaded: names.length,
    resignation_names_null: nullNames,
    directory_rows_returned_unscoped: everyone.length,
    listed_before_fix: yn(listedBefore),
    listed_before_fix_her_outlet_filter: yn(listedBeforeOutlet),
    listed_after_fix: yn(listedAfter),
    found_by_search_deployed: yn(foundBySearch),
    hr_screen_default_active_filter_passes: yn(Number(me.status) === 1),
  };
  out("4. DIRECTORY VISIBILITY - deployed repository code vs fixed predicate", dir);
  summary.directory = dir;

  /* 5. LIFECYCLE ----------------------------------------------------------*/
  if (await exists("employee_employment_period")) {
    out("5a. EMPLOYMENT PERIODS", await select(
      `SELECT ${(await pick("employee_employment_period", ["period_id", "period_no", "period_state", "joined_on", "ended_on", "end_reason_type", "source", "needs_review", "created_at"])).join(", ")}
         FROM employee_employment_period WHERE employee_id = ? ORDER BY period_no`, [EMP]));
  }
  if (await exists("employee_lifecycle_event")) {
    out("5b. LIFECYCLE EVENTS", await select(
      `SELECT event_id, period_id, event_type, actor_employee_id, created_at
         FROM employee_lifecycle_event WHERE employee_id = ? ORDER BY event_id`, [EMP]));
  }

  /* 6. ONBOARDING / AADHAAR (a badge - never removes a row from the list) */
  const onboarding = {};
  if (await exists("employee_aadhaar_identity")) {
    const [r] = await select(
      "SELECT COUNT(*) AS n, MAX(verified_at) AS verified_at FROM employee_aadhaar_identity WHERE employee_id = ?", [EMP]);
    onboarding.aadhaar_identity_attached = Number(r.n);
    onboarding.aadhaar_verified_at = r.verified_at;
  }
  if (await exists("employee_aadhaar_verification")) {
    const [r] = await select("SELECT COUNT(*) AS n FROM employee_aadhaar_verification WHERE employee_id = ?", [EMP]);
    onboarding.aadhaar_verification_attempts = Number(r.n);
  }
  if (await exists("employee_bank_verification") && (await columns("employee_bank_verification")).has("status")) {
    const rows = await select("SELECT status FROM employee_bank_verification WHERE employee_id = ?", [EMP]);
    onboarding.bank_verification_status = rows.map((r) => r.status).join(",") || "none";
  }
  if (await exists("employee_salary")) {
    const [r] = await select("SELECT COUNT(*) AS n FROM employee_salary WHERE employee_id = ?", [EMP]);
    onboarding.salary_rows = Number(r.n);
  }
  onboarding.pf_applicable = me.pf_applicable === undefined ? "column absent" : me.pf_applicable;
  onboarding.esi_applicable = me.esi_applicable === undefined ? "column absent" : me.esi_applicable;
  out("6. ONBOARDING / AADHAAR / PAYROLL SET-UP", onboarding);

  /* 7. PAYROLL AND ATTENDANCE --------------------------------------------*/
  if (await exists("payrun_employee")) {
    out("7a. PAYRUN ROWS (latest 6)", await select(
      `SELECT ${(await pick("payrun_employee", ["period_year", "period_month", "employee_name", "store_id", "store_name", "designation_name"])).join(", ")}
         FROM payrun_employee WHERE employee_id = ? ORDER BY period_year DESC, period_month DESC LIMIT 6`, [EMP]));
  }
  if (await exists("attendance_day_calculation")) {
    out("7b. CALCULATED ATTENDANCE DAYS", await select(
      `SELECT COUNT(*) AS days, MIN(attendance_date) AS first_day, MAX(attendance_date) AS last_day
         FROM attendance_day_calculation WHERE employee_id = ?`, [EMP]));
  }
  if (await exists("biomax_punch")) {
    const bc = await columns("biomax_punch");
    const src = bc.has("ingest_source") ? "ingest_source" : "'unknown'";
    out("7c. BIOMAX / DIGISME PUNCHES BY EMPLOYEE CODE (any leading zeros)", await select(
      `SELECT user_id, ${src} AS ingest_source, dev_id, COUNT(*) AS punches,
              MIN(punch_date) AS first_punch, MAX(punch_date) AS last_punch
         FROM biomax_punch
        WHERE user_id IN (?)
        GROUP BY user_id, ${src}, dev_id ORDER BY last_punch DESC`,
      [[String(EMP), `0${EMP}`, `00${EMP}`, `000${EMP}`]]));
  }

  /* 8. DUPLICATE / MAPPING CHECKS -----------------------------------------*/
  const userCols = await pick("user", ["user_id", "username", "employee_id", "user_type", "status", "is_system_account", "is_service_account", "last_login_at"], "u");
  out("8a. LOGIN ACCOUNTS LINKED TO THIS EMPLOYEE", await select(
    `SELECT ${userCols.join(", ")} FROM \`user\` u WHERE u.employee_id = ?`, [EMP]));
  out("8b. OTHER EMPLOYEES SHARING HER MOBILE NUMBER (ids only)", await select(
    `SELECT o.employee_id, o.employee_name, o.status, o.store_id
       FROM new_employee o JOIN new_employee me ON me.employee_id = ?
      WHERE o.employee_id <> me.employee_id AND me.primary_contact_number IS NOT NULL
        AND me.primary_contact_number <> '' AND o.primary_contact_number = me.primary_contact_number`, [EMP]));
  if (await exists("employee_aadhaar_identity") && (await columns("employee_aadhaar_identity")).has("aadhaar_fingerprint")) {
    out("8c. OTHER EMPLOYEES SHARING HER AADHAAR IDENTITY (ids only)", await select(
      `SELECT o.employee_id FROM employee_aadhaar_identity o
         JOIN employee_aadhaar_identity me ON me.employee_id = ?
        WHERE o.employee_id <> me.employee_id AND o.aadhaar_fingerprint = me.aadhaar_fingerprint`, [EMP]));
  }

  /* 9. BRANCH SCOPE - who may see her, under the deployed rule ------------*/
  // Admin (user_type 2) -> all; `employee_scope_all_branches` -> all;
  // otherwise view_employees AND the user's own active employee record is at
  // her store_id. (middlewares/employee_branch_scope.js)
  const scopeRows = await select(
    `SELECT u.user_id, u.username, u.user_type, ne.employee_id, ne.employee_name,
            ne.store_id, d.designation_name,
            CASE
              WHEN u.user_type = 2 THEN 'ADMIN - all branches'
              WHEN EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id
                            AND p.is_active = 1 AND p.permission_key = 'employee_scope_all_branches')
                   THEN 'HR KEY - all branches'
              ELSE 'OWN BRANCH'
            END AS scope_path
       FROM \`user\` u
       JOIN new_employee ne ON ne.employee_id = u.employee_id
       LEFT JOIN designation d ON d.designation_id = ne.designation_id
      WHERE u.status = 1 AND ne.status = 1
        AND ( u.user_type = 2
           OR EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id
                       AND p.is_active = 1 AND p.permission_key = 'employee_scope_all_branches')
           OR ( ne.store_id = ?
                AND EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id
                             AND p.is_active = 1 AND p.permission_key = 'view_employees') ) )
      ORDER BY scope_path, ne.employee_id`,
    [me.store_id === null ? -1 : me.store_id]
  );
  out("9. USERS WHOSE BRANCH SCOPE COVERS HER (before the name filter is applied)", scopeRows);
  summary.branch_scope = {
    her_store_id: me.store_id,
    outlet_exists: yn(me.outlet_found !== null),
    users_in_scope: scopeRows.length,
    own_branch_users: scopeRows.filter((r) => r.scope_path === "OWN BRANCH").length,
    note: "scope decides WHO may see her; block 4 decides whether the list query returns her at all",
  };

  /* 10. NEARBY WORKING EMPLOYEE -------------------------------------------*/
  const nearby = await select(
    `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id, ne.designation_id,
            ne.date_of_joining, ne.resignation_date, ne.created_at
       FROM new_employee ne
      WHERE ne.store_id <=> ? AND ne.designation_id <=> ? AND ne.status = 1 AND ne.employee_id <> ?
      ORDER BY ABS(ne.employee_id - ?) LIMIT 3`,
    [me.store_id, me.designation_id, EMP, EMP]
  );
  const everyoneIds = new Set(everyone.map((e) => Number(e.employee_id)));
  out("10. NEARBY WORKING EMPLOYEES - same outlet and designation",
    nearby.map((n) => ({ ...n, listed_by_deployed_directory: yn(everyoneIds.has(Number(n.employee_id))) })));

  /* 11. BLAST RADIUS + SAFETY OF THE FIX ----------------------------------*/
  // Every ACTIVE employee the deployed directory drops. These, and only these,
  // are what `f363085` makes visible. Each is classified by why its name is
  // in `resignation`, so one meant to stay hidden is called out as REVIEW.
  const hiddenActive = (await select(
    `SELECT employee_id, employee_name, store_id, date_of_joining, resignation_date
       FROM new_employee WHERE status = 1 ORDER BY employee_id`
  )).filter((e) => !everyoneIds.has(Number(e.employee_id)));

  const allByName = new Map();
  if (hiddenActive.length) {
    const sameNameRows = await select(
      `SELECT employee_id, employee_name, status, date_of_joining, resignation_date
         FROM new_employee WHERE employee_name IN (?)`, [hiddenActive.map((h) => h.employee_name)]);
    for (const r of sameNameRows) {
      const k = normName(r.employee_name);
      if (!allByName.has(k)) allByName.set(k, []);
      allByName.get(k).push(r);
    }
  }
  const resByName = new Map();
  if (hiddenActive.length) {
    const rr = await select(
      `SELECT ${resCols.join(", ")} FROM resignation r WHERE r.employee_name IN (?)`,
      [hiddenActive.map((h) => h.employee_name)]);
    for (const r of rr) {
      const k = normName(r.employee_name);
      if (!resByName.has(k)) resByName.set(k, []);
      resByName.get(k).push(r);
    }
  }
  const radius = hiddenActive.map((h) => {
    const id = Number(h.employee_id);
    const joined = parseLooseDate(h.date_of_joining);
    const rows = resByName.get(normName(h.employee_name)) || [];
    const others = (allByName.get(normName(h.employee_name)) || []).filter((o) => Number(o.employee_id) !== id);
    const inactiveOthers = others.filter((o) => Number(o.status) !== 1);
    const reasons = rows.map((r) => {
      const rd = parseLooseDate(r.resignation_date);
      if (r.voided_at) return "SAFE:voided";
      if (r.employee_id !== null && r.employee_id !== undefined && Number(r.employee_id) !== id) return "SAFE:namesake";
      if (r.employee_id !== null && r.employee_id !== undefined) {
        return joined && rd && joined > rd ? "SAFE:rejoined-after" : "REVIEW:own-row-no-later-joining";
      }
      if (inactiveOthers.length) return "SAFE:namesake(legacy)";
      if (joined && rd && joined > rd) return "SAFE:rejoined-after(legacy)";
      return "REVIEW:legacy-row-no-inactive-namesake";
    });
    const flags = [];
    if (h.resignation_date) flags.push("REVIEW:status=1-but-resignation_date-set");
    const all = [...reasons, ...flags];
    return {
      employee_id: h.employee_id,
      employee_name: h.employee_name,
      store_id: h.store_id,
      date_of_joining: h.date_of_joining,
      matching_rows: rows.map((r) => `${r.resignation_id}:${r.employee_id === null || r.employee_id === undefined ? "name-only" : r.employee_id}:${r.resignation_date}`).join(" | "),
      other_same_name_ids: others.map((o) => `${o.employee_id}/s${o.status}`).join(",") || "-",
      verdict: all.some((x) => x.startsWith("REVIEW")) ? "REVIEW" : "SAFE",
      reasons: [...new Set(all)].join(", "),
    };
  });
  out(`11. ACTIVE EMPLOYEES HIDDEN BY THE DEPLOYED DIRECTORY (${radius.length}) - what the fix would expose`,
    radius.length ? radius : "none");
  summary.fix_exposure = {
    active_employees_hidden_now: radius.length,
    safe_to_show: radius.filter((r) => r.verdict === "SAFE").length,
    needs_hr_review_before_merge: radius.filter((r) => r.verdict === "REVIEW").map((r) => r.employee_id),
  };

  /* 12. LEGACY RESIGN-BY-NAME INTEGRITY (separate bug) --------------------*/
  // The legacy Resign screen (usecase/resignation.js) deactivates
  // `getEmployeeIdByName(name)` = the FIRST row with that name, and its undo
  // re-activates through a name join. With several employees on one name the
  // wrong person can be switched off or on.
  const groups = await select(
    `SELECT ne.employee_name,
            COUNT(DISTINCT ne.employee_id) AS employees,
            GROUP_CONCAT(DISTINCT CONCAT(ne.employee_id, '/s', ne.status, '/j', IFNULL(ne.date_of_joining, '-'),
                         '/r', IFNULL(ne.resignation_date, '-')) ORDER BY ne.employee_id SEPARATOR '  ') AS employees_detail,
            (SELECT GROUP_CONCAT(CONCAT(r.resignation_id, ':', IFNULL(r.employee_id, 'name-only'), ':', IFNULL(r.resignation_date, '-'))
                     ORDER BY r.resignation_id SEPARATOR '  ')
               FROM resignation r WHERE r.employee_name = ne.employee_name) AS resignation_rows
       FROM new_employee ne
      WHERE ne.employee_name IN (SELECT employee_name FROM resignation)
      GROUP BY ne.employee_name
     HAVING COUNT(DISTINCT ne.employee_id) > 1
      ORDER BY employees DESC, ne.employee_name`
  );
  out(`12. LEGACY RESIGN-BY-NAME: names shared by several employees AND a resignation (${groups.length})`,
    groups.length ? groups : "none");
  summary.legacy_name_collisions = groups.length;

  /* CLASSIFICATION --------------------------------------------------------*/
  let verdict;
  if (!listedBefore && listedAfter) {
    verdict =
      "CASE A - PROVEN: the resignation-name filter is hiding this employee. " +
      `listed_before_fix = 0 (deployed code), listed_after_fix = 1, found_by_search = ${yn(foundBySearch)}.`;
  } else if (listedBefore) {
    verdict =
      "CASE B - listed_before_fix = 1: the deployed list DOES return this employee. " +
      "Do NOT ship f363085 as the fix for her; continue with blocks 1 (status, outlet), 9 (branch scope of the viewer) and 8.";
  } else {
    verdict = "OTHER - not listed before AND not after: something besides the name filter excludes her. Do not ship as her fix.";
  }
  summary.classification = verdict;
  out("SUMMARY", summary);
})()
  .catch((err) => {
    console.error(`\nFAILED (nothing was written): ${err && err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end(() => {}));
