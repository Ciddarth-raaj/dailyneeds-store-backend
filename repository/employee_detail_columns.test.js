/**
 * THE EMPLOYEE-DETAIL RESULT CONTRACT.
 *
 *   node --test repository/employee_detail_columns.test.js
 *
 * ============================== THE DEFECT THIS PINS ======================
 *
 * `GET /employee/employee_id` returned `SELECT *` across five joined tables.
 * The mysql driver keys each row by the BARE column name -
 * `RowDataPacket.prototype.parse` does `this[fieldPacket.name] = value` unless
 * `nestTables` is set, and this pool does not set it - so where two joined
 * tables share a name, the LAST one silently overwrites the first.
 *
 * `new_employee`, `department`, `designation` and `shift_master` all have a
 * `status` column, and the join ends at `shift_master`, whose `status`
 * DEFAULTS TO 0. So the profile's `status` was the shift's, and an employee
 * who works here was drawn as "Resigned". The list was always correct because
 * it names its columns.
 *
 * These tests are about the SQL text rather than a database, which is the
 * level the defect lived at: the query was valid, ran fine, and returned the
 * wrong column under the right name.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  EMPLOYEE_MASTER_COLUMNS,
  EMPLOYEE_DETAIL_JOINED_COLUMNS,
  EMPLOYEE_DETAIL_COLUMNS,
} = require("./employee");

/** The rendered SQL, captured from the repository rather than transcribed. */
function detailSql() {
  let captured = null;
  const repo = require("./employee")({
    query: (sql, params, cb) => {
      captured = sql;
      cb(null, []);
    },
  });
  repo.getById(1);
  return captured.replace(/\s+/g, " ");
}

/* ===================================== the columns that must not collide == */

/**
 * The four tables joined here and the columns they carry that `new_employee`
 * ALSO carries. Every one of these was, or could become, a silent overwrite.
 */
const COLLIDING = {
  department: ["status"],
  designation: ["status", "online_portal"],
  outlets: ["created_at", "updated_at"],
  shift_master: ["status"],
};

test("NO `SELECT *` ANYWHERE IN THE DETAIL QUERY", () => {
  const sql = detailSql();
  assert.ok(!/SELECT\s+\*/i.test(sql), "a star select is what let a join overwrite the employee");
  assert.ok(!/\bnew_employee\.\*/i.test(sql), "including a qualified star");
});

test("EVERY COLLIDING COLUMN IS TAKEN FROM new_employee, NOT FROM A JOIN", () => {
  const sql = detailSql();
  for (const [table, columns] of Object.entries(COLLIDING)) {
    for (const column of columns) {
      // The joined table's copy must never be selected under the bare name.
      assert.ok(
        !new RegExp(`\\b${table}\\.${column}\\b(?!\\s+AS)`, "i").test(sql),
        `${table}.${column} must not be selected unaliased - it would overwrite the employee's`
      );
      assert.ok(
        sql.includes(`new_employee.${column}`),
        `new_employee.${column} must be selected`
      );
    }
  }
});

test("status is the EMPLOYEE'S, which is the whole defect", () => {
  const sql = detailSql();
  assert.ok(sql.includes("new_employee.status"));
  assert.ok(!/shift_master\.status/i.test(sql), "shift_master.status defaults to 0");
});

test("the fields the task named cannot be overwritten", () => {
  const sql = detailSql();
  for (const field of [
    "employee_id",
    "status",
    "store_id",
    "department_id",
    "designation_id",
    "shift_id",
    "date_of_joining",
    "resignation_date",
    "employee_name",
  ]) {
    assert.ok(sql.includes(`new_employee.${field}`), `${field} must come from the employee master`);
  }
});

test("every selected column is qualified by a table", () => {
  for (const column of EMPLOYEE_DETAIL_COLUMNS) {
    assert.match(
      column,
      /^[a-z_]+\.[a-z_0-9]+( AS [a-z_0-9]+)?$/i,
      `${column} must name its table - an unqualified column is how this broke`
    );
  }
});

test("no two selected columns land on the same response key", () => {
  const keys = EMPLOYEE_DETAIL_COLUMNS.map((c) => {
    const aliased = /\sAS\s+([a-z_0-9]+)$/i.exec(c);
    return aliased ? aliased[1] : c.split(".")[1];
  });
  const seen = new Set();
  for (const key of keys) {
    assert.ok(!seen.has(key), `${key} is selected twice - the second would overwrite the first`);
    seen.add(key);
  }
});

/* ============================================ the contract stays complete = */

/**
 * EVERY `new_employee` COLUMN THE MIGRATIONS CREATE IS SELECTED.
 *
 * The one real cost of an explicit list is that a column added later is
 * silently missing from the profile. This reads the migrations - the CREATE
 * and every `ADD COLUMN`, ignoring the `-down` files that drop them - and
 * fails when the list falls behind. So the list can be explicit without
 * depending on anybody remembering it.
 */
/**
 * THE TABLE NAME MUST END WHERE IT ENDS.
 *
 * ================== THE INCIDENT THIS ANCHOR EXISTS TO PREVENT ============
 *
 * This scan first shipped as ``/ALTER TABLE\s+`?new_employee`?/`` - with the
 * closing backtick OPTIONAL and no boundary after the name. That happily
 * matched the first fourteen characters of
 *
 *     ALTER TABLE `new_employee_documents` ADD COLUMN `is_verified` ...
 *
 * leaving `_documents` to be swallowed by the following `([\s\S]*?)`. So
 * `is_verified` - a column on the DOCUMENTS table, because a document is
 * verified and an employee is not - was read as a `new_employee` column,
 * added to the select list, and shipped.
 *
 * `SELECT new_employee.is_verified` is ER_BAD_FIELD_ERROR (1054), so EVERY
 * employee profile answered HTTP 500 in production.
 *
 * THE TEST AGREED WITH THE BUG. It was written to catch the list falling
 * BEHIND the schema and it did that correctly, but it derived "the schema"
 * with the same broken pattern the list came from, so it confirmed the very
 * column that was wrong. A check that shares its input with the thing it
 * checks is not a check. Hence the anchor below, and hence
 * `columnsFromMigrations` is now asserted to EXCLUDE a known
 * `new_employee_documents` column as well as to include real ones.
 */
const NEW_EMPLOYEE_TABLE = "(?:`new_employee`|\\bnew_employee\\b(?!_))";

function columnsFromMigrations() {
  const dir = path.join(__dirname, "../migrations/mysql/migrations/sqls");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith("-up.sql"));
  const columns = [];

  for (const file of files.sort()) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/--[^\n]*/g, "");

    const created = new RegExp(`CREATE TABLE\\s+${NEW_EMPLOYEE_TABLE}\\s*\\(([\\s\\S]*?)\\);`).exec(sql);
    if (created) {
      for (const m of created[1].matchAll(/`([a-zA-Z_0-9]+)`\s+[a-zA-Z]/g)) columns.push(m[1]);
    }
    for (const alter of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+${NEW_EMPLOYEE_TABLE}([\\s\\S]*?);`, "g")
    )) {
      // ADD and DROP, in order: a column added by one migration and dropped
      // by a later one is not on the table either.
      //
      // Backticks are optional because `DROP COLUMN foo` is written bare, so
      // the structural forms - ADD INDEX, ADD CONSTRAINT, ADD UNIQUE KEY -
      // have to be excluded by name rather than by quoting.
      const NOT_A_COLUMN = /^(INDEX|KEY|CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|FULLTEXT|SPATIAL|CHECK)$/i;
      for (const m of alter[1].matchAll(/\b(ADD|DROP)\s+(?:COLUMN\s+)?`?([a-zA-Z_0-9]+)`?/gi)) {
        const [, verb, name] = m;
        if (NOT_A_COLUMN.test(name)) continue;
        if (/^add$/i.test(verb)) columns.push(name);
        else {
          const at = columns.lastIndexOf(name);
          if (at !== -1) columns.splice(at, 1);
        }
      }
    }
  }
  return [...new Set(columns)];
}

test("THE LIST DOES NOT FALL BEHIND THE SCHEMA", () => {
  const declared = new Set(
    EMPLOYEE_MASTER_COLUMNS.map((c) => c.replace("new_employee.", ""))
  );
  const inSchema = columnsFromMigrations();

  assert.ok(inSchema.length > 40, "the migration scan must actually find the table");
  assert.ok(inSchema.includes("status"), "sanity: the scan finds the column at issue");

  const missing = inSchema.filter((c) => !declared.has(c));
  assert.deepEqual(
    missing,
    [],
    `these new_employee columns are in the schema but not in EMPLOYEE_MASTER_COLUMNS: ${missing.join(", ")}`
  );
});

/**
 * THE INCIDENT ITSELF, pinned by name.
 *
 * `is_verified` is a `new_employee_documents` column. It reached the select
 * list because the migration scan matched `new_employee` as a PREFIX of
 * `new_employee_documents`, and every employee profile then answered HTTP 500
 * with ER_BAD_FIELD_ERROR (1054).
 */
test("7. THE PRODUCTION-INCOMPATIBLE FIELD IS NOT SELECTED", () => {
  const sql = detailSql();
  assert.ok(
    !/is_verified/.test(sql),
    "is_verified belongs to new_employee_documents; selecting it is a 1054 and a 500"
  );
  assert.ok(!EMPLOYEE_MASTER_COLUMNS.some((c) => c.includes("is_verified")));
});

test("THE SCAN CANNOT BE FOOLED BY A PREFIX TABLE AGAIN", () => {
  // The scan is what let the column in: it agreed with the bug because it
  // derived "the schema" the same broken way the list was derived. So it is
  // asserted here to EXCLUDE a column it would previously have swallowed.
  const found = columnsFromMigrations();

  assert.ok(
    !found.includes("is_verified"),
    "is_verified is added to new_employee_documents, never to new_employee"
  );
  // A real `new_employee_documents` column set, none of which is on the
  // employee master. If any appears, the table name is matching a prefix.
  for (const documentsColumn of ["card_type", "card_no", "card_name", "expiry_date"]) {
    assert.ok(
      !found.includes(documentsColumn),
      `${documentsColumn} is a new_employee_documents column, not an employee one`
    );
  }
  // And it still finds the real ones - the anchor must not have over-tightened.
  for (const real of ["employee_id", "status", "store_id", "attendance_required", "shift_code"]) {
    assert.ok(found.includes(real), `${real} is a real new_employee column and must be found`);
  }
});

test("and names nothing that is not a new_employee column", () => {
  const inSchema = new Set(columnsFromMigrations());
  for (const column of EMPLOYEE_MASTER_COLUMNS) {
    const name = column.replace("new_employee.", "");
    assert.ok(inSchema.has(name), `${name} is selected but no migration adds it to new_employee`);
  }
});

/* ================================================== B3 is not disturbed == */

test("EVERY SENSITIVE FIELD IS STILL SELECTED UNDER ITS OWN NAME", () => {
  // B3's `filterResponse` strips by KEY NAME. If this change had renamed or
  // dropped one of these, the field would stop being stripped - or stop being
  // shown to the people entitled to it - without any test of B3's own failing.
  const { SENSITIVE_EMPLOYEE_FIELDS } = require("../constants/sensitive_fields");
  const keys = new Set(
    EMPLOYEE_DETAIL_COLUMNS.map((c) => {
      const aliased = /\sAS\s+([a-z_0-9]+)$/i.exec(c);
      return (aliased ? aliased[1] : c.split(".")[1]).toLowerCase();
    })
  );

  // The B3 list is deliberately WIDER than this table: `aadhaar_number`,
  // `aadhaar_ciphertext` and `aadhaar_fingerprint` live on the Aadhaar
  // verification tables and are stripped from the endpoints that return
  // those. Only the ones that ARE `new_employee` columns can be asserted
  // here, and the intersection is computed from the schema rather than from a
  // hand-kept exclusion list, so a sensitive column added to `new_employee`
  // later is covered automatically.
  const inThisTable = new Set(columnsFromMigrations().map((c) => c.toLowerCase()));
  const applicable = SENSITIVE_EMPLOYEE_FIELDS.filter((f) =>
    inThisTable.has(String(f).toLowerCase())
  );

  assert.ok(applicable.length >= 15, "sanity: most sensitive fields do live on new_employee");
  for (const field of applicable) {
    assert.ok(
      keys.has(String(field).toLowerCase()),
      `${field} is a B3 sensitive field on new_employee and must still arrive under that exact key`
    );
  }

  // And the three that are NOT on this table must not have crept in.
  for (const field of SENSITIVE_EMPLOYEE_FIELDS.filter((f) => !inThisTable.has(String(f).toLowerCase()))) {
    assert.ok(!keys.has(String(field).toLowerCase()), `${field} does not belong in this payload`);
  }
});

test("the joined display columns keep the key names consumers already use", () => {
  const sql = detailSql();
  for (const key of [
    "department.department_name",
    "designation.designation_name",
    "outlets.outlet_name",
    "outlets.outlet_nickname",
    "shift_master.shift_name",
    "shift_master.shift_in_time",
    "shift_master.shift_out_time",
  ]) {
    assert.ok(sql.includes(key), `${key} was returned before and must still be`);
  }
  assert.ok(
    EMPLOYEE_DETAIL_JOINED_COLUMNS.includes("designation.online_portal AS designation_online_portal"),
    "the designation's own flag stays available, but under a name that cannot collide"
  );
});
