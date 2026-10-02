#!/usr/bin/env node
/**
 * READ-ONLY post-deploy check for the Employee Master "Resigned" view
 * (include_resigned=1). Run on the production server after fdcb996 is live:
 *
 *   node resigned-view-postdeploy-check.js --backend ~/dailyneeds-store-backend \
 *     --env development --employee 1530 \
 *     [--hr <employee_id>] [--own-manager <employee_id>] [--other-manager <employee_id>]
 *
 * Viewers not named are picked automatically: an active HR (holder of
 * employee_scope_all_branches), an active `view_employees` holder at the
 * employee's outlet, and one at another outlet - each with an active login.
 *
 * WHAT IT RUNS is the DEPLOYED code, as `GET /employee/employees` and
 * `GET /hr/employees/status-summary` run it, minus HTTP and JWT: the real
 * permission middleware (`view_employees` check, live permissions table), the
 * real branch-scope middleware over the real branch repository
 * (`listFilters` -> `actorFor`), the real resignation and employee
 * repositories and `populationFromQuery`. It does not need anybody's password
 * or token, and prints none.
 *
 * WRITES NOTHING: session READ ONLY (verified first) and a client guard that
 * refuses any statement that is not a plain SELECT.
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
if (!arg("backend") || !fs.existsSync(path.join(BACKEND, "repository", "employee_scope.js"))) die("--backend must name the deployed checkout");
if (!ENV) die("--env is required");
if (!Number.isInteger(EMP) || EMP <= 0) die("--employee must be a positive integer");

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
const results = [];
const check = (name, pass, detail) => results.push({ check: name, result: pass ? "PASS" : "FAIL", detail });

(async () => {
  /* 0. connection and deployed code ---------------------------------------*/
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", BACKEND, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) { /* unknown */ }
  let ro = null;
  for (const v of ["@@transaction_read_only", "@@tx_read_only"]) {
    try { ro = Number((await select(`SELECT ${v} AS ro`))[0].ro); break; } catch (e) { /* other spelling */ }
  }
  const [srv] = await select("SELECT DATABASE() AS db");
  const scopeMod = require(path.join(BACKEND, "repository", "employee_scope.js"));
  out("0. CONNECTION AND DEPLOYED CODE", {
    env: ENV, database: srv.db, session_read_only: ro, deployed_commit: commit,
    include_resigned_code_present: Boolean(scopeMod.DIRECTORY_POPULATION && scopeMod.populationFromQuery),
  });
  if (ro !== 1) die("session is not READ ONLY");
  if (!scopeMod.populationFromQuery) die("the deployed checkout does not contain the include_resigned change");

  const P = require(path.join(BACKEND, "constants", "hr_permissions"));
  const permissions = require(path.join(BACKEND, "middlewares", "permissions"))(
    require(path.join(BACKEND, "repository", "designation"))(handle));
  const EBR = require(path.join(BACKEND, "repository", "employee_branch"));
  const branch = require(path.join(BACKEND, "middlewares", "employee_branch_scope"))(permissions, new EBR(handle));
  const employeeRepo = require(path.join(BACKEND, "repository", "employee"))(handle);
  const resignationRepo = require(path.join(BACKEND, "repository", "resignation"))(handle);
  const names = (await resignationRepo.getResignedEmployee()).map((r) => r.employee_name);

  /* 1. the employee ---------------------------------------------------------*/
  const [me] = await select(
    `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id, o.outlet_name, ne.resignation_date
       FROM new_employee ne LEFT JOIN outlets o ON o.outlet_id = ne.store_id WHERE ne.employee_id = ?`, [EMP]);
  if (!me) die(`no employee ${EMP}`);
  out(`1. EMPLOYEE ${EMP} (read only, unchanged)`, me);

  /* 2. the viewers ----------------------------------------------------------*/
  const viewerSql = (where) => `
    SELECT ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id, MAX(u.user_type) AS user_type
      FROM new_employee ne JOIN \`user\` u ON u.employee_id = ne.employee_id AND u.status = 1
     WHERE ne.status = 1 AND ${where}
     GROUP BY ne.employee_id, ne.employee_name, ne.store_id, ne.designation_id
     ORDER BY ne.employee_id LIMIT 1`;
  const holds = (key) => `EXISTS (SELECT 1 FROM permissions p WHERE p.designation_id = ne.designation_id
                                   AND p.is_active = 1 AND p.permission_key = '${key}')`;
  const pickViewer = async (id, where, params) => {
    if (id) {
      const rows = await select(viewerSql("ne.employee_id = ?"), [Number(id)]);
      return rows[0] || null;
    }
    const rows = await select(viewerSql(where), params);
    return rows[0] || null;
  };
  const hr = await pickViewer(arg("hr"), `${holds("employee_scope_all_branches")} AND ${holds("view_employees")}`, []);
  const own = await pickViewer(arg("own-manager"),
    `ne.store_id = ? AND ${holds("view_employees")} AND NOT ${holds("employee_scope_all_branches")} AND u.user_type <> 2`, [me.store_id]);
  const other = await pickViewer(arg("other-manager"),
    `ne.store_id <> ? AND ${holds("view_employees")} AND NOT ${holds("employee_scope_all_branches")} AND u.user_type <> 2`, [me.store_id]);
  out("2. VIEWERS (live employee records and permissions)", [
    { role: "HR", ...(hr || { missing: true }) },
    { role: "own-outlet manager", ...(own || { missing: true }) },
    { role: "other-outlet manager", ...(other || { missing: true }) },
  ]);

  const reqFor = (v, query) => ({
    decoded: { user_type: Number(v.user_type), designation_id: Number(v.designation_id), employee_id: Number(v.employee_id) },
    auth: { userType: Number(v.user_type), designationId: Number(v.designation_id), employeeId: Number(v.employee_id), userId: null },
    query,
  });

  /** GET /employee/employees, as routes/employee.js runs it. */
  const list = async (v, query) => {
    const req = reqFor(v, query);
    if (!(await permissions.has(req, P.VIEW_EMPLOYEES))) return { refused: "NO_VIEW_EMPLOYEES" };
    const scoped = await branch.listFilters(req, query.store_ids);
    if (!scoped.ok) return { refused: scoped.reason };
    const actor = await branch.actorFor(req);
    const rows = await employeeRepo.get(names, query, actor, {
      population: scopeMod.populationFromQuery(query.include_resigned),
    });
    return { rows };
  };
  /** The population GET /hr/employees/status-summary annotates. */
  const summaryIds = async (v, query) => {
    const req = reqFor(v, query);
    const scoped = await branch.listFilters(req, query.store_ids);
    if (!scoped.ok) return { refused: scoped.reason };
    const filters = scoped.store_ids === null ? query : { ...query, store_ids: scoped.store_ids };
    const pop = scopeMod.populationFromQuery(query.include_resigned);
    const rows = await employeeRepo.get(names, filters, null,
      pop === scopeMod.DIRECTORY_POPULATION.INCLUDE_RESIGNED ? { population: pop } : {});
    return { ids: rows.map((r) => Number(r.employee_id)).sort((a, b) => a - b) };
  };
  const idsOf = (r) => (r.rows || []).map((x) => Number(x.employee_id)).sort((a, b) => a - b);
  const active = (r) => (r.rows || []).filter((x) => Number(x.status) === 1).map((x) => Number(x.employee_id)).sort((a, b) => a - b);
  const resigned = (r) => (r.rows || []).filter((x) => Number(x.status) !== 1).map((x) => Number(x.employee_id)).sort((a, b) => a - b);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* 3. HR: population before / after -------------------------------------*/
  const [{ n: inactiveTotal }] = await select("SELECT COUNT(*) AS n FROM new_employee WHERE NOT (status <=> 1)");
  if (hr) {
    const before = await list(hr, {});
    const after = await list(hr, { include_resigned: "1" });
    const pop = {
      default_list_rows: idsOf(before).length,
      inclusive_list_rows: idsOf(after).length,
      resigned_view_before: resigned(before).length,
      resigned_view_after: resigned(after).length,
      inactive_employees_in_db: Number(inactiveTotal),
      active_view_before: active(before).length,
      active_view_after: active(after).length,
    };
    out("3. HR POPULATION - default vs include_resigned=1", pop);
    check("HR: include_resigned=1 accepted and returns a list", Array.isArray(after.rows), after.refused || "");
    check(`HR: ${EMP} returned with the flag`, idsOf(after).includes(EMP), "");
    const row = (after.rows || []).find((x) => Number(x.employee_id) === EMP);
    check(`HR: ${EMP} status is still 0`, row && Number(row.status) === 0, row ? `status=${row.status}` : "not returned");
    check(`HR: ${EMP} outlet / name / resignation date`, Boolean(row),
      row ? `${row.employee_id} | ${row.employee_name} | ${row.store_name} | ${me.resignation_date}` : "");
    check(`HR: ${EMP} is in the Resigned view`, resigned(after).includes(EMP), "");
    check(`HR: ${EMP} is NOT in the Active view`, !active(after).includes(EMP), "");
    check(`HR: ${EMP} is NOT in the default list (unchanged behaviour)`, !idsOf(before).includes(EMP), "");
    check("HR: Resigned view = every inactive employee", resigned(after).length === Number(inactiveTotal),
      `${resigned(after).length} of ${inactiveTotal}`);
    check("HR: Active view identical with and without the flag", same(active(before), active(after)),
      `${active(before).length} vs ${active(after).length}`);
    const sNo = await summaryIds(hr, {});
    const sYes = await summaryIds(hr, { include_resigned: "1" });
    check("HR: status-summary population = list, default", same(sNo.ids, idsOf(before)), "");
    check("HR: status-summary population = list, include_resigned", same(sYes.ids, idsOf(after)), "");
    const search = await employeeRepo.getEmployeeByFilter(String(me.employee_name).split(" ")[0], null);
    out("3b. EMPLOYEE SEARCH (unchanged; it lists status = 1 only)", search.map((s) => ({
      employee_id: s.employee_id, employee_name: s.employee_name, status: s.status, store_id: s.store_id })));
  } else {
    check("HR viewer found", false, "pass --hr <employee_id>");
  }

  /* 4. branch security ------------------------------------------------------*/
  if (own) {
    const r = await list(own, { include_resigned: "1" });
    check(`own-outlet manager ${own.employee_id}: sees ${EMP}`, idsOf(r).includes(EMP), r.refused || "");
    check("own-outlet manager: every row is their outlet",
      (r.rows || []).every((x) => Number(x.store_id) === Number(own.store_id)), "");
    const s = await summaryIds(own, { include_resigned: "1" });
    check("own-outlet manager: status-summary population = list", same(s.ids, idsOf(r)), "");
    const d = await list(own, {});
    check("own-outlet manager: Active view unchanged", same(active(d), active(r)), "");
  } else {
    check("own-outlet manager found", false, "pass --own-manager <employee_id>");
  }
  if (other) {
    const r = await list(other, { include_resigned: "1" });
    check(`other-outlet manager ${other.employee_id}: does NOT see ${EMP}`, !idsOf(r).includes(EMP), r.refused || "");
    check("other-outlet manager: no row from the employee's outlet",
      (r.rows || []).every((x) => Number(x.store_id) !== Number(me.store_id)), "");
    const asked = await list(other, { include_resigned: "1", store_ids: [String(me.store_id)] });
    check("other-outlet manager: requesting the employee's outlet is refused", Boolean(asked.refused), asked.refused || "NOT refused");
  } else {
    check("other-outlet manager found", false, "pass --other-manager <employee_id>");
  }

  /* 5. callers without the flag (pickers, onboarding) ----------------------*/
  if (hr) {
    const d = await list(hr, {});
    const [{ n: oldCount }] = names.length
      ? await select("SELECT COUNT(*) AS n FROM new_employee WHERE employee_name NOT IN (?)", [names])
      : await select("SELECT COUNT(*) AS n FROM new_employee");
    check("no flag: list equals the pre-fix rule (name NOT IN resignation)", idsOf(d).length === Number(oldCount),
      `${idsOf(d).length} vs ${oldCount}`);
  }

  out("RESULTS", results);
  const failed = results.filter((r) => r.result === "FAIL").length;
  out("SUMMARY", failed ? `${failed} check(s) FAILED` : `ALL ${results.length} CHECKS PASSED`);
})()
  .catch((err) => {
    console.error(`\nFAILED (nothing was written): ${err && err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end(() => {}));
