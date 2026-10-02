#!/usr/bin/env node
/**
 * READ-ONLY: why is a RESIGNED employee missing from the Resigned list?
 * First case: 1530 - Sathiya Priya (status 0, resignation row 14, period 102).
 *
 *   node resigned-list-trace.js --backend ~/dailyneeds-store-backend \
 *     --env development --employee 1530 [--viewer <employee_id of the HR user>]
 *
 * THE LIST. HR -> Employee Master -> Employees, status dropdown "Resigned"
 * (`pages/hr/employees/index.jsx`, value `inactive`). The page loads
 * `GET /employee/employees` ONCE with no parameters and filters in the
 * browser: `Number(e.status) === 1` rows are dropped for "Resigned". The old
 * `/resignation` page is no longer in the navigation.
 *
 * THE QUERY is built by the DEPLOYED code and captured here, not retyped:
 * `repository/employee.js#get` is handed a recording handle, which yields the
 * exact FROM/JOIN text and the exact WHERE parts from the deployed
 * `repository/employee_scope.js`. Each stage is then run on its own for the
 * target, so the first stage that loses the row is measured, not inferred.
 *
 * WRITES NOTHING - the same two locks as employee-directory-visibility.js:
 * session `READ ONLY` (verified before anything runs) and a client guard that
 * refuses any statement that is not a plain SELECT. No password is printed.
 */
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const die = (m) => {
  console.error(`ABORTED: ${m}`);
  process.exit(2);
};
const BACKEND = path.resolve((arg("backend") || "").replace(/^~(?=$|\/)/, process.env.HOME || "~"));
const ENV = arg("env");
const EMP = Number(arg("employee"));
const VIEWER = arg("viewer") === null ? null : Number(arg("viewer"));
if (!arg("backend") || !fs.existsSync(path.join(BACKEND, "repository", "employee_scope.js"))) {
  die("--backend must name the deployed dailyneeds-store-backend checkout");
}
if (!ENV) die("--env is required (the live process's NODE_ENV; 'development' when it is unset)");
if (!Number.isInteger(EMP) || EMP <= 0) die("--employee must be a positive integer");
if (VIEWER !== null && (!Number.isInteger(VIEWER) || VIEWER <= 0)) die("--viewer must be an employee id");

/* ------------------------------------------------------- read-only handle */
const mysql = require(path.join(BACKEND, "node_modules", "mysql"));
const config = JSON.parse(fs.readFileSync(path.join(BACKEND, "config.json"), "utf8"));
const dbc = config && config.db && config.db.mysql && config.db.mysql[ENV];
if (!dbc) die(`config.db.mysql["${ENV}"] not found`);
const pool = mysql.createPool({
  connectionLimit: 1, host: dbc.host, user: dbc.username, password: dbc.password,
  database: dbc.database, port: dbc.port, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
});
pool.on("connection", (c) => c.query("SET SESSION TRANSACTION READ ONLY"));
const isRead = (sql) => {
  const t = String(sql && typeof sql === "object" ? sql.sql : sql).replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "").trim();
  return /^(SELECT|\(\s*SELECT)\b/i.test(t) &&
    !/\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(t);
};
const handle = {
  query(sql, params, cb) {
    const callback = typeof params === "function" ? params : cb;
    const values = typeof params === "function" ? [] : params;
    if (!isRead(sql)) return callback(new Error(`READ-ONLY refused: ${String(sql).trim().slice(0, 80)}`));
    pool.query(sql, values, callback);
  },
  getConnection() {
    throw new Error("READ-ONLY: transactions are not available");
  },
};
const select = (sql, params = []) =>
  new Promise((res, rej) => handle.query(sql, params, (e, rows) => (e ? rej(e) : res(rows))));

const out = (label, v) => {
  console.log(`\n=== ${label}`);
  if (Array.isArray(v) && v.length && typeof v[0] === "object") console.table(v);
  else console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
};
const colCache = new Map();
const columns = async (t) => {
  if (!colCache.has(t)) {
    const r = await select("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]);
    colCache.set(t, new Set(r.map((x) => x.c)));
  }
  return colCache.get(t);
};
const exists = async (t) => (await columns(t)).size > 0;
const pick = async (t, want, a) => want.filter((c) => colCache.get(t).has(c)).map((c) => `${a}.\`${c}\``);

/* =================================================================== run */
(async () => {
  /* 0. CONNECTION ---------------------------------------------------------*/
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", BACKEND, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) { /* reported as unknown */ }
  const [srv] = await select("SELECT DATABASE() AS db, @@version AS version");
  let ro = null;
  for (const v of ["@@transaction_read_only", "@@tx_read_only"]) {
    try { ro = Number((await select(`SELECT ${v} AS ro`))[0].ro); break; } catch (e) { /* other spelling */ }
  }
  out("0. CONNECTION (no password shown)", {
    env: ENV, config_host: dbc.host, config_user: dbc.username, database: srv.db,
    server_version: srv.version, session_read_only: ro, deployed_commit: commit,
  });
  if (ro !== 1) die("the session did not report READ ONLY; nothing further was run");

  const scope = require(path.join(BACKEND, "repository", "employee_scope.js"));
  const employeeRepoFor = (db) => require(path.join(BACKEND, "repository", "employee"))(db);
  const resignationRepo = require(path.join(BACKEND, "repository", "resignation"))(handle);

  /* 1. THE DEPLOYED QUERY, CAPTURED ---------------------------------------*/
  let captured = null;
  employeeRepoFor({ query: (sql, params) => { captured = { sql, params }; } }).get([], {}, null).catch(() => {});
  if (!captured) die("could not capture the deployed directory query");
  const BASE = captured.sql.trim(); // no WHERE: names [], filters {}, actor null
  if (/\bWHERE\b/i.test(BASE.replace(/\([^()]*\)/g, ""))) die("captured base query unexpectedly has a WHERE");
  out("1. DEPLOYED DIRECTORY QUERY (GET /employee/employees) - FROM/JOIN part", BASE.replace(/\s+/g, " "));

  /* 2. STAGE 1 - the raw resignation repository ---------------------------*/
  const resignedNames = (await resignationRepo.getResignedEmployee()).map((r) => r.employee_name);
  const meRows = await select("SELECT employee_id, employee_name, status, store_id, resignation_date FROM new_employee WHERE employee_id = ?", [EMP]);
  if (meRows.length !== 1) die(`new_employee has ${meRows.length} rows for ${EMP}`);
  const me = meRows[0];
  await columns("resignation");
  const resCols = await pick("resignation", ["resignation_id", "employee_id", "period_id", "employee_name", "reason_type", "resignation_date", "voided_at"], "r");
  const myRes = await select(
    `SELECT ${resCols.join(", ")}, (r.employee_name = ?) AS name_matches_employee
       FROM resignation r WHERE r.employee_id = ? OR r.employee_name = ? ORDER BY r.resignation_id`,
    [me.employee_name, EMP, me.employee_name]);
  out("2. STAGE 1 - resignation rows for the employee (by employee_id OR by name)", myRes.length ? myRes : "none");

  /* 3. STAGES - one row per filter, in the order the request applies them --*/
  const stages = [];
  const run = async (label, where, params) => {
    const rows = await select(`SELECT COUNT(*) AS n FROM (${BASE} WHERE new_employee.employee_id = ?${where ? ` AND ${where}` : ""}) x`, [EMP, ...params]);
    stages.push({ stage: label, condition: where || "(none)", returns_employee: Number(rows[0].n) > 0 ? 1 : 0, rows: Number(rows[0].n) });
  };
  const base = await select("SELECT COUNT(*) AS n FROM new_employee WHERE employee_id = ?", [EMP]);
  stages.push({ stage: "S0 new_employee row", condition: "employee_id = ?", returns_employee: Number(base[0].n) > 0 ? 1 : 0, rows: Number(base[0].n) });
  await run("S1 after all deployed JOINs (designation, department, outlets, shift_master, resignation-by-name)", "", []);

  // Branch scope, for each kind of viewer, rendered by the DEPLOYED accessScope.
  const scopes = [
    ["S2a branch scope - HR / admin (ALL_BRANCHES)", { branch_scope: { kind: "ALL_BRANCHES", store_ids: null } }],
    [`S2b branch scope - manager of her outlet (store ${me.store_id})`, { branch_scope: { kind: "OWN_BRANCHES", store_ids: [Number(me.store_id)] } }],
  ];
  if (VIEWER !== null) {
    const [v] = await select(
      `SELECT ne.employee_id, ne.store_id, ne.status, ne.designation_id,
              (SELECT MAX(u.user_type) FROM \`user\` u WHERE u.employee_id = ne.employee_id AND u.status = 1) AS user_type,
              EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id AND p.is_active = 1
                       AND p.permission_key = 'employee_scope_all_branches') AS has_all
         FROM new_employee ne WHERE ne.employee_id = ?`, [VIEWER]);
    let bs;
    if (!v) bs = { kind: "NONE", store_ids: [] };
    else if (Number(v.user_type) === 2 || Number(v.has_all) === 1) bs = { kind: "ALL_BRANCHES", store_ids: null };
    else if (Number(v.status) !== 1 || v.store_id === null) bs = { kind: "NONE", store_ids: [] };
    else bs = { kind: "OWN_BRANCHES", store_ids: [Number(v.store_id)] };
    scopes.push([`S2c branch scope - the actual viewer ${VIEWER} (${bs.kind}${bs.store_ids ? ` ${bs.store_ids}` : ""})`, { branch_scope: bs }]);
  }
  for (const [label, actor] of scopes) {
    const a = scope.accessScope(actor);
    await run(label, a.conditions.join(" AND "), a.params);
  }

  const pop = scope.directoryPopulation(resignedNames);
  await run("S3 directory population - resigned-name exclusion", pop.conditions.join(" AND "), pop.params);

  const lf = scope.lookupFilters({});
  await run("S4 lookup filters (the page sends none)", lf.conditions.join(" AND "), lf.params);

  // S5: the final API query, run through the deployed repository itself.
  const finalRows = await employeeRepoFor(handle).get(resignedNames, {}, { branch_scope: { kind: "ALL_BRANCHES", store_ids: null } });
  const inFinal = finalRows.some((e) => Number(e.employee_id) === EMP);
  stages.push({ stage: "S5 final API query (deployed repository, HR viewer)", condition: "all of the above", returns_employee: inFinal ? 1 : 0, rows: finalRows.length });

  // S6: the browser's "Resigned" filter (pages/hr/employees/index.jsx).
  const passesUi = Number(me.status) !== 1;
  stages.push({ stage: "S6 frontend 'Resigned' filter: Number(status) !== 1", condition: `status = ${me.status}`, returns_employee: inFinal && passesUi ? 1 : 0, rows: null });
  out(`3. STAGE BY STAGE FOR ${EMP}`, stages);

  const firstDrop = stages.find((s) => s.returns_employee === 0 && !/S2[bc]/.test(s.stage));
  out("FIRST STAGE THAT LOSES THE EMPLOYEE (HR viewer)", firstDrop
    ? `${firstDrop.stage}  ->  ${firstDrop.condition}`
    : "none - the employee survives every stage; look at the viewer's scope (S2c) or the browser");

  /* 4. COMPARISON - resigned employees who DO appear ----------------------*/
  const shown = new Set(finalRows.map((e) => Number(e.employee_id)));
  const periodView = await exists("v_employee_current_period");
  const inactive = await select(
    `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id, ne.resignation_date
       FROM new_employee ne WHERE ne.status <> 1 OR ne.status IS NULL`);
  const nameSet = new Set(resignedNames.map((n) => String(n)));
  const withRow = inactive.filter((e) => nameSet.has(String(e.employee_name)));
  const stats = {
    inactive_employees: inactive.length,
    inactive_shown_in_resigned_list: inactive.filter((e) => shown.has(Number(e.employee_id))).length,
    inactive_hidden_from_resigned_list: inactive.filter((e) => !shown.has(Number(e.employee_id))).length,
    inactive_whose_name_is_in_resignation: withRow.length,
    of_those_shown: withRow.filter((e) => shown.has(Number(e.employee_id))).length,
  };
  out("4a. WHOLE RESIGNED LIST - who is shown and who is not", stats);

  const sample = (rows) => rows
    .sort((a, b) => (Number(b.store_id) === Number(me.store_id)) - (Number(a.store_id) === Number(me.store_id)) ||
      String(b.resignation_date || "").localeCompare(String(a.resignation_date || "")))
    .slice(0, 3);
  const working = sample(inactive.filter((e) => shown.has(Number(e.employee_id))));
  const compareIds = [EMP, ...working.map((w) => Number(w.employee_id))];
  const compare = [];
  for (const id of compareIds) {
    const [e] = await select("SELECT employee_id, employee_name, status, store_id, resignation_date FROM new_employee WHERE employee_id = ?", [id]);
    const rr = await select(
      `SELECT ${resCols.join(", ")} FROM resignation r WHERE r.employee_id = ? OR r.employee_name = ? ORDER BY r.resignation_id`,
      [id, e.employee_name]);
    let period = {};
    if (periodView) {
      const [p] = await select("SELECT period_id, period_state, ended_on, end_reason_type FROM v_employee_current_period WHERE employee_id = ?", [id]);
      period = p || {};
    }
    compare.push({
      employee_id: id,
      in_resigned_list: shown.has(id) ? 1 : 0,
      status: e.status,
      store_id: e.store_id,
      ne_resignation_date: e.resignation_date,
      resignation_rows: rr.map((r) => `${r.resignation_id}${r.employee_id ? `(emp ${r.employee_id})` : "(name-only)"}${r.voided_at ? "(voided)" : ""}`).join(",") || "none",
      name_in_resignation_names: nameSet.has(String(e.employee_name)) ? 1 : 0,
      period_id: period.period_id === undefined ? "-" : period.period_id,
      period_state: period.period_state || "-",
      end_reason_type: period.end_reason_type || "-",
    });
  }
  out("4b. 1530 vs RESIGNED EMPLOYEES WHO DO APPEAR (same outlet first)", compare);

  const diff = compare.slice(1).every((c) => c.name_in_resignation_names === 0) && compare[0].name_in_resignation_names === 1;
  out("VERDICT", diff
    ? "PROVEN: every resigned employee who appears has NO resignation row by name; 1530 has one (row " +
      `${myRes.map((r) => r.resignation_id).join(",")}), and S3 - the directory's resigned-name exclusion - drops her.`
    : "NOT the resigned-name exclusion alone - read section 3 for the first stage that loses her.");
})()
  .catch((err) => {
    console.error(`\nFAILED (nothing was written): ${err && err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end(() => {}));
