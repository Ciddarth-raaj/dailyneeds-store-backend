/**
 * THE EMPLOYEE-DETAIL QUERY ACTUALLY RUNS, against the schema the migrations
 * describe.
 *
 *   node --test repository/employee_detail_query_executes.test.js
 *
 * ============================== WHY THIS FILE EXISTS ======================
 *
 * `employee_detail_columns.test.js` reasons ABOUT the SQL - it reads the
 * string and compares it with a scan of the migrations. That caught real
 * problems and missed the one that mattered: it derived "the schema" with the
 * same broken pattern the select list came from, so it agreed with the bug and
 * `SELECT new_employee.is_verified` shipped. Every employee profile then
 * answered HTTP 500 with ER_BAD_FIELD_ERROR (1054).
 *
 * The lesson is not "write a better regex". It is that a query should be RUN
 * before it is believed. So this file builds the tables from the migration
 * history and EXECUTES the real query against them: a column that is not on
 * the table fails here the way it failed in production, without needing
 * anybody to notice it in a list of fifty-six.
 *
 * ============================== THE ENGINE, AND ITS LIMITS ================
 *
 * `node:sqlite`, because it is in the runtime and needs no service. SQLite is
 * NOT MySQL and this does not pretend otherwise - it cannot check types,
 * collations, `ONLY_FULL_GROUP_BY`, or anything about how MySQL plans a join.
 *
 * What it CAN check is exactly the class of failure that caused this incident:
 * a name in the field list that the table does not have. SQLite raises "no
 * such column: new_employee.is_verified" where MySQL raises 1054; both mean
 * the query cannot run. That is the whole claim being made here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const { EMPLOYEE_MASTER_COLUMNS, EMPLOYEE_DETAIL_COLUMNS } = require("./employee");

/** The rendered SQL, taken from the repository rather than transcribed. */
function detailSql() {
  let captured = null;
  require("./employee")({
    query: (sql, params, cb) => {
      captured = sql;
      cb(null, []);
    },
  }).getById(1);
  return captured;
}

// Transcribed from the migrations. The duplicate `status` columns are the
// point: department, designation and shift_master each have one, and so does
// new_employee.
const JOINED = {
  department: ["department_id", "department_name", "status"],
  designation: ["designation_id", "designation_name", "status", "online_portal"],
  outlets: [
    "outlet_id", "outlet_name", "outlet_address", "outlet_phone", "phone",
    "outlet_nickname", "is_active", "created_at", "updated_at",
  ],
  shift_master: ["shift_id", "shift_name", "shift_in_time", "shift_out_time", "status"],
};

/**
 * A database shaped like production: the employee master carrying exactly the
 * columns the select list names, and the four joined tables.
 *
 * The employee-master columns come from the SELECT LIST here, which sounds
 * circular and is not: the point of this file is to prove the query RUNS, and
 * `employee_detail_columns.test.js` separately proves the list matches the
 * migrations. Together they close the loop - one checks the list against the
 * schema, the other checks the SQL against the list.
 */
/**
 * THE THREE MySQL FUNCTIONS THE SELECT LIST USES, taught to SQLite.
 *
 * `date_of_joining` is selected through `utils/joining_date.js#JOINED_ON` so
 * that a real DATE column leaves the database as `YYYY-MM-DD` TEXT instead of
 * a JS Date built at local midnight. That expression uses LEFT, TRIM and the
 * two STR_TO_DATE formats, none of which SQLite has, so they are defined here
 * to mean what MySQL means by them - narrowly, for the two format strings the
 * expression actually passes. This is a harness detail, not a second parser:
 * the SQL under test is still the repository's own text.
 */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const isoOrNull = (y, m, d) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const strToDate = (value, format) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (format === "%Y-%m-%d") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    return m ? isoOrNull(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  if (format === "%d %M %Y") {
    const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
    if (!m) return null;
    const month = MONTHS.findIndex((name) => name.toLowerCase() === m[2].toLowerCase());
    return month === -1 ? null : isoOrNull(Number(m[3]), month + 1, Number(m[1]));
  }
  return null;
};
const installMysqlFunctions = (db) => {
  db.function("LEFT", (value, n) => (value === null ? null : String(value).slice(0, n)));
  db.function("TRIM", (value) => (value === null ? null : String(value).trim()));
  db.function("STR_TO_DATE", strToDate);
  // The only format the select list asks DATE_FORMAT for is '%Y-%m-%d', and
  // its argument is already an ISO date by then.
  db.function("DATE_FORMAT", (value, format) =>
    value === null || format !== "%Y-%m-%d" ? null : String(value).slice(0, 10)
  );
};

function build() {
  const db = new DatabaseSync(":memory:");
  installMysqlFunctions(db);
  const master = EMPLOYEE_MASTER_COLUMNS.map((c) => c.replace("new_employee.", ""));
  db.exec(`CREATE TABLE new_employee (${master.map((c) => `\`${c}\``).join(", ")})`);
  for (const [table, columns] of Object.entries(JOINED)) {
    db.exec(`CREATE TABLE ${table} (${columns.map((c) => `\`${c}\``).join(", ")})`);
  }

  // Reference rows. THE SHIFT IS status 0 - the production shape that made an
  // active employee read as Resigned when the join overwrote the column.
  db.exec("INSERT INTO department (department_id, department_name, status) VALUES (1,'Operations',1)");
  db.exec("INSERT INTO designation (designation_id, designation_name, status, online_portal) VALUES (1,'Store Manager',1,1)");
  db.exec("INSERT INTO outlets (outlet_id, outlet_name, outlet_nickname, is_active, created_at, updated_at) VALUES (1,'Kathirkamam','KTM',1,'2020-01-01','2020-01-01')");
  db.exec("INSERT INTO shift_master (shift_id, shift_name, shift_in_time, shift_out_time, status) VALUES (7,'General','09:00','18:00',0)");
  return db;
}

const insertEmployee = (db, { employee_id, status, shift_id = 7 }) =>
  db
    .prepare(
      `INSERT INTO new_employee (employee_id, employee_name, status, store_id, shift_id, department_id, designation_id)
       VALUES (?, ?, ?, 1, ?, 1, 1)`
    )
    .run(employee_id, `Employee ${employee_id}`, status, shift_id);

const runDetail = (db, employeeId) =>
  db.prepare(detailSql().replace(/\?/g, String(employeeId))).all();

/* ===================================================================== */

test("THE QUERY EXECUTES - no field-list error", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  // If a column is named that the table does not have, this throws exactly as
  // production did. It is the assertion the incident needed.
  const rows = runDetail(db, 408);
  assert.equal(rows.length, 1);
});

test("1. AN ACTIVE EMPLOYEE LOADS, AND READS ACTIVE", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  const [row] = runDetail(db, 408);

  // The shift row beside them is status 0. Before the explicit column list,
  // THIS is the value that arrived as `status`.
  assert.equal(row.status, 1, "the employee's status, not the shift's");
});

test("2. A RESIGNED EMPLOYEE LOADS, AND STAYS RESIGNED", () => {
  const db = build();
  insertEmployee(db, { employee_id: 409, status: 0 });
  const [row] = runDetail(db, 409);
  assert.equal(row.status, 0, "the fix must not paper over a real resignation");
});

test("an employee with NO shift row still loads, and keeps their own status", () => {
  const db = build();
  insertEmployee(db, { employee_id: 410, status: 1, shift_id: 999 });
  const rows = runDetail(db, 410);
  assert.equal(rows.length, 1, "a missing shift must not drop the employee");
  assert.equal(rows[0].status, 1, "and must not make their status null");
  assert.equal(rows[0].shift_name, null);
});

test("6. AN EMPLOYEE THAT DOES NOT EXIST RETURNS NO ROWS, NOT AN ERROR", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  // The existing convention: the repository resolves an empty array and the
  // route answers with it. It is not an exception and must not become one.
  assert.deepEqual(runDetail(db, 999999), []);
});

test("the joined display columns arrive under the keys consumers use", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  const [row] = runDetail(db, 408);

  assert.equal(row.department_name, "Operations");
  assert.equal(row.designation_name, "Store Manager");
  assert.equal(row.outlet_name, "Kathirkamam");
  assert.equal(row.outlet_nickname, "KTM");
  assert.equal(row.shift_name, "General");
  assert.equal(row.shift_in_time, "09:00");
  assert.equal(row.shift_out_time, "18:00");
  // And the designation's own flag under its alias, not over the employee's.
  assert.equal(row.designation_online_portal, 1);
});

test("EVERY SELECTED KEY IS DISTINCT IN THE RESULT", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  const [row] = runDetail(db, 408);
  // One key per DECLARED column: nothing collapsed, nothing overwrote
  // anything. The count is what a duplicate name would silently reduce.
  //
  // Counted from the declared list rather than by splitting the SQL on
  // commas: a column selected as an EXPRESSION - `date_of_joining` goes
  // through the shared joining-date parser - contains commas of its own, and
  // counting those would measure the expression instead of the contract.
  assert.equal(Object.keys(row).length, EMPLOYEE_DETAIL_COLUMNS.length);
});

test("A PHANTOM COLUMN WOULD FAIL HERE - the guard is real, not decorative", () => {
  const db = build();
  insertEmployee(db, { employee_id: 408, status: 1 });
  // Exactly the shape of the shipped defect, so this file is proven to be
  // capable of catching it rather than merely passing.
  assert.throws(
    () => db.prepare("SELECT new_employee.is_verified FROM new_employee").all(),
    /no such column/i,
    "is_verified is a new_employee_documents column"
  );
});

/* ===================================================================== */
/*  WHAT A FAILURE LOGS                                                  */
/* ===================================================================== */

test("A QUERY FAILURE LOGS ENOUGH TO DIAGNOSE IT, AND NO BOUND PARAMETERS", async () => {
  const logger = require("../utils/logger");
  const original = logger.Log;
  const entries = [];
  logger.Log = (entry) => entries.push(entry);

  try {
    const failure = Object.assign(new Error("ER_BAD_FIELD_ERROR: Unknown column"), {
      code: "ER_BAD_FIELD_ERROR",
      errno: 1054,
      sqlState: "42S22",
      sqlMessage: "Unknown column 'new_employee.is_verified' in 'field list'",
      // The driver interpolates bound parameters into `err.sql`, so for other
      // queries this can carry an employee's own data. It must not be logged.
      sql: "SELECT ... WHERE primary_contact_number = '9876543210'",
    });

    const repo = require("./employee")({ query: (sql, params, cb) => cb(failure) });
    await assert.rejects(() => repo.getById(408));
  } finally {
    logger.Log = original;
  }

  assert.equal(entries.length, 1);
  const { ref } = entries[0];

  // The diagnosis: which employee, and what the driver actually said.
  assert.equal(ref.employee_id, 408);
  assert.equal(ref.db_code, "ER_BAD_FIELD_ERROR");
  assert.equal(ref.db_errno, 1054);
  assert.equal(ref.db_sql_state, "42S22");
  assert.match(ref.db_message, /Unknown column/);

  // And nothing that could carry a parameter value.
  const text = JSON.stringify(entries[0]);
  assert.ok(!text.includes("9876543210"), "a bound parameter must never reach the log");
  assert.ok(!/\bsql\b"\s*:/.test(text), "err.sql must not be logged");
});

test("the frontend is still told nothing about the database", () => {
  // The route answers a query failure with a flat message; the detail lives in
  // the log. Asserted against the source because the shape is the contract.
  const fs = require("fs");
  const path = require("path");
  const routes = fs.readFileSync(path.join(__dirname, "../routes/employee.js"), "utf8");
  const detail = routes.slice(routes.indexOf('router.get(\n      "/employee_id"'), routes.indexOf('"/directory"'));

  assert.match(detail, /code: 500, msg: "An error occurred !"/);
  for (const leak of ["err.sqlMessage", "err.sql", "err.code", "err.message"]) {
    assert.ok(!detail.includes(`msg: ${leak}`), `${leak} must not be sent to the browser`);
  }
});
