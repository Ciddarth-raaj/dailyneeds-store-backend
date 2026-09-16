/**
 * THE MASTER COLUMNS THE BULK EXPORT / IMPORT ACTUALLY DEPENDS ON.
 *
 *   node --test repository/employee_bulk_update.schema.test.js
 *
 * WHY THIS FILE EXISTS. A tech-lead review asked whether
 * `department.department_code` and `designation.designation_code` were real
 * columns or an assumption the unit tests' fakes had invented - because the
 * normal CRUD paths write neither. The unit tests could not answer that: they
 * run against hand-written master rows, so they would have passed just as
 * happily against columns that do not exist, and the failure would have been
 * an ER_BAD_FIELD_ERROR 1054 in production.
 *
 * So these tests read the MIGRATIONS and the repository's real SQL, and pin
 * the answer both ways round:
 *
 *   * the columns the feature DOES read are declared by a migration
 *   * the feature does NOT read the two code columns, whose values normal
 *     CRUD never writes
 *
 * `repository/employee.js` has the precedent for this kind of test - a
 * hand-maintained column list that once shipped `is_verified` from the wrong
 * table and 500ed in production.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SQL_DIR = path.join(__dirname, "..", "migrations", "mysql", "migrations", "sqls");
const REPO = fs.readFileSync(path.join(__dirname, "employee_bulk_update.js"), "utf8");
/** The repository with comments stripped, so prose about SQL is not read as SQL. */
const REPO_SQL = REPO.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every migration's up-SQL, concatenated, lower-cased. */
const ALL_UP_SQL = fs
  .readdirSync(SQL_DIR)
  .filter((f) => f.endsWith("-up.sql"))
  .map((f) => fs.readFileSync(path.join(SQL_DIR, f), "utf8"))
  .join("\n")
  .toLowerCase();

describe("the master columns the bulk feature reads are real", () => {
  /**
   * The id, name and active flag of each master - the three things
   * `getMasters` selects, and the whole basis of the `Name [ID]` label.
   *
   * `outlets` spells the flag `is_active`; the other two spell it `status`.
   * Reading the wrong one would mark every row inactive and refuse every
   * Location, Department and Designation in an uploaded file.
   */
  const CONTRACT = [
    { table: "outlets", id: "outlet_id", name: "outlet_name", active: "is_active" },
    { table: "department", id: "department_id", name: "department_name", active: "status" },
    { table: "designation", id: "designation_id", name: "designation_name", active: "status" },
  ];

  for (const master of CONTRACT) {
    it(`${master.table}: the repository selects id, name and the active flag it declares`, () => {
      assert.match(
        REPO_SQL.replace(/\s+/g, " "),
        new RegExp(
          `select ${master.id} as id, ${master.name} as name, ${master.active} as active from ${master.table}`,
          "i"
        ),
        `${master.table} is not selected with exactly id, name and ${master.active}`
      );
    });
  }

  it("every id the label is built from is an existing column, per the migrations", () => {
    /*
     * These three tables predate this repo's migration history, so their
     * CREATE TABLE is not here to read, and only `outlets` is a foreign-key
     * target (the HR posting columns are bare INTs with no FK - see
     * docs/hr-schema.md). The proof that the other two ids exist comes from
     * the same migration that added the code columns: it positions each new
     * column `AFTER` the id, which MySQL rejects if that column is absent.
     */
    const employeeImport = fs.readFileSync(
      path.join(SQL_DIR, "20251117080329-employee-import-up.sql"),
      "utf8"
    );
    assert.match(employeeImport, /`designation_code`[^;]*AFTER `designation_id`/i);
    assert.match(employeeImport, /`department_code`[^;]*AFTER `department_id`/i);
    assert.match(employeeImport, /`outlet_code`[^;]*AFTER `outlet_id`/i);

    // And `outlets.outlet_id` is a foreign-key target across the schema.
    assert.match(ALL_UP_SQL, /references\s+`?outlets`?\s*\(\s*`?outlet_id`?\s*\)/i);
  });
});

describe("the code columns exist, and the bulk feature deliberately does not use them", () => {
  /**
   * They ARE real - all three, added by `20251117080329-employee-import`,
   * each with a UNIQUE constraint. The review's literal doubt was misplaced.
   */
  it("all three _code columns are declared by 20251117080329-employee-import", () => {
    const sql = fs
      .readFileSync(path.join(SQL_DIR, "20251117080329-employee-import-up.sql"), "utf8")
      .toLowerCase();

    assert.match(sql, /alter table `designation` add `designation_code` varchar\(20\) null default null/);
    assert.match(sql, /alter table `designation` add unique\(`designation_code`\)/);
    assert.match(sql, /alter table `department` add `department_code` varchar\(20\) null default null/);
    assert.match(sql, /alter table `department` add unique\(`department_code`\)/);
    assert.match(sql, /alter table `outlets` add `outlet_code` varchar\(20\) not null/);
    assert.match(sql, /alter table `outlets` add unique\(`outlet_code`\)/);
  });

  /**
   * AND THAT IS EXACTLY WHY THEY ARE NOT THE LABEL. The two HR ones are
   * `NULL DEFAULT NULL`, and MySQL permits any number of NULLs in a UNIQUE
   * column - so UNIQUE guarantees nothing about rows that have no code. Only
   * `outlet_code` is NOT NULL, and it was seeded by that same migration.
   */
  it("department_code and designation_code are nullable; only outlet_code is NOT NULL", () => {
    const sql = fs
      .readFileSync(path.join(SQL_DIR, "20251117080329-employee-import-up.sql"), "utf8")
      .toLowerCase();

    assert.match(sql, /`designation_code` varchar\(20\) null default null/);
    assert.match(sql, /`department_code` varchar\(20\) null default null/);
    assert.match(sql, /`outlet_code` varchar\(20\) not null/);
  });

  /**
   * NOTHING POPULATES THE TWO HR ONES ANY MORE. Their only writer was the
   * Digisme sync, which upserted the masters on those codes and has been
   * removed (docs/digisme-employee-sync-removal.md). The CRUD that replaced
   * it writes a name and a status and no code at all, so every department and
   * designation created since has a NULL code.
   */
  it("normal Department and Designation CRUD writes no code column", () => {
    const department = fs.readFileSync(path.join(__dirname, "department.js"), "utf8");
    const designation = fs.readFileSync(path.join(__dirname, "designation.js"), "utf8");

    assert.match(department, /INSERT INTO department \(status, department_name\)/);
    assert.match(designation, /INSERT INTO designation \(status, designation_name, online_portal, login_access\)/);
    assert.ok(
      !/INSERT INTO department \([^)]*department_code/i.test(department),
      "department CRUD unexpectedly writes a code; the labelling decision should be revisited"
    );
    assert.ok(
      !/INSERT INTO designation \([^)]*designation_code/i.test(designation),
      "designation CRUD unexpectedly writes a code; the labelling decision should be revisited"
    );
  });

  it("so the bulk repository reads no _code column in any of its SQL", () => {
    for (const column of ["outlet_code", "department_code", "designation_code"]) {
      assert.ok(
        !REPO_SQL.includes(column),
        `${column} appears in the bulk repository's SQL; the spreadsheet label is Name [ID]`
      );
    }
  });

  it("and the label builder is fed only id, name and active", () => {
    const fields = fs.readFileSync(path.join(__dirname, "..", "utils", "employee_bulk_fields.js"), "utf8");
    const builder = fields.slice(fields.indexOf("function buildMasterIndex"));
    const body = builder.slice(0, builder.indexOf("\n}\n"));
    assert.ok(
      !/\bcode\b/.test(body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
      "buildMasterIndex still reads a code column"
    );
  });
});
