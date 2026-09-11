/**
 * The M2 salary migration is additive, re-runnable, and decides nothing about
 * anybody's pay or statutory history.
 *
 *   node --test migrations/m2_salary_engine.test.js
 *
 * Proven against the SQL text - there is no database here - the same way
 * `c3_bank_name_review_and_statutory_flags.test.js` proves its migration.
 * That suits what matters most about this one, which is what it must NOT do:
 *
 *   it must not copy the legacy `new_employee.salary` into the new table
 *   it must not backfill a previous-PF-membership nobody has stated
 *   it must not grant the salary rights to any designation
 *   it must not leave two current salaries possible for one employee
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260915120000-m2-salary-engine";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const SALARY_KEYS = [
  "view_salary",
  "add_salary",
  "edit_salary",
  "manual_salary_component_override",
  "approve_salary_revision",
  "view_payroll",
  "process_payroll",
  "hr_reports",
];

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const body = stripComments(sql);
  const stmts = statements(sql);

  it("NEVER COPIES THE LEGACY SALARY COLUMN", () => {
    // The rule this file exists to keep. `new_employee.salary` is an undated
    // free-text number; seeding a salary HISTORY from it would manufacture an
    // effective date and an approval that nobody ever gave.
    assert.ok(
      !/INSERT\s+INTO\s+`?employee_salary`?/i.test(body),
      "not one salary row is written by the migration"
    );
    assert.ok(
      !/\bFROM\s+`?new_employee`?/i.test(body),
      "nothing is selected out of the employee master"
    );
    assert.ok(!/\bsalary\b\s*=/i.test(body), "the legacy column is not read or written");
  });

  it("never backfills the previous-PF-member flag", () => {
    // An UPDATE *statement* - not the `ON UPDATE CURRENT_TIMESTAMP` clause on
    // the new table's `updated_at`, which is a column definition and writes
    // nothing that exists today.
    assert.ok(
      !stmts.some((s) => /^UPDATE\s/i.test(s)),
      "no employee row is written on the way up"
    );
    assert.ok(
      !/previous_pf_member`?\s+TINYINT\(1\)\s+NOT NULL/i.test(body),
      "the column is nullable - NULL means nobody has said"
    );
    assert.match(body, /previous_pf_member` TINYINT\(1\) NULL DEFAULT NULL/);
  });

  it("adds the tri-state column guarded, so the file can be re-run", () => {
    assert.match(body, /COLUMN_NAME. = 'previous_pf_member'/, "the column is checked for first");
    assert.match(body, /PREPARE add_stmt FROM @add_previous_pf_member/);
  });

  it("keeps the new field separate from PF applicable, UAN and PF number", () => {
    const alter = stmts.find((s) => /ADD COLUMN `previous_pf_member`/.test(s));
    assert.ok(alter, "the column is added");
    for (const other of ["pf_applicable", "`uan`", "pf_number", "`pf`"]) {
      assert.ok(!alter.includes(other), `${other} is not touched by the same statement`);
    }
  });

  it("creates the salary table without dropping anything", () => {
    assert.match(body, /CREATE TABLE IF NOT EXISTS `employee_salary`/);
    assert.ok(!/\bDROP\b|\bTRUNCATE\b/i.test(body), "nothing is removed on the way up");
  });

  it("carries every column the approved schema requires", () => {
    const create = stmts.find((s) => /CREATE TABLE IF NOT EXISTS `employee_salary`/.test(s));
    for (const column of [
      "employee_id",
      "monthly_gross",
      "daily_salary",
      "basic",
      "conveyance",
      "hra",
      "special_allowance",
      "manual_override",
      "override_reason",
      "employee_pf",
      "employer_epf",
      "employer_eps",
      "edli",
      "pf_admin_charge",
      "employee_esi",
      "employer_esi",
      "monthly_ctc",
      "effective_from",
      "status",
      "source",
      "created_by",
      "created_at",
      "approved_by",
      "approved_at",
      "rejected_by",
      "rejected_at",
      "updated_at",
      "statutory_snapshot",
    ]) {
      assert.ok(create.includes(`\`${column}\``), `${column} is on the table`);
    }
  });

  it("has no DA component", () => {
    assert.ok(!/`(da|dearness_allowance)`/i.test(body), "there is no DA in this structure");
  });

  it("models the three lifecycle states and the opening source", () => {
    assert.match(body, /`status` ENUM\('PENDING','APPROVED','REJECTED'\) NOT NULL DEFAULT 'PENDING'/);
    assert.match(body, /`source` ENUM\('OPENING_SALARY','REVISION','CORRECTION','IMPORT'\) NOT NULL/);
  });

  it("allows exactly ONE non-rejected revision per employee and effective date", () => {
    // The constraint that stops two current salaries existing. REJECTED rows
    // generate NULL, and MySQL treats NULLs in a unique index as distinct, so
    // a rejected proposal never blocks the date it was rejected at.
    assert.match(
      body,
      /`active_effective_from` DATE GENERATED ALWAYS AS\s*\(CASE WHEN `status` = 'REJECTED' THEN NULL ELSE `effective_from` END\) STORED/
    );
    assert.match(body, /UNIQUE KEY `uq_salary_active_revision` \(`employee_id`, `active_effective_from`\)/);
  });

  it("indexes the current-salary resolver's query", () => {
    assert.match(body, /KEY `idx_salary_current` \(`employee_id`, `status`, `effective_from`\)/);
  });

  it("ties a salary to a real employee", () => {
    assert.match(body, /FOREIGN KEY \(`employee_id`\) REFERENCES `new_employee` \(`employee_id`\)/);
  });

  it("declares all eight permission keys", () => {
    const insert = stmts.find((s) => /INSERT INTO `all_permissions`/.test(s));
    assert.ok(insert, "the keys are declared");
    for (const key of SALARY_KEYS) {
      assert.ok(insert.includes(`'${key}'`), `${key} is declared`);
    }
  });

  it("GRANTS THEM TO NOBODY", () => {
    // The approved task is explicit: do not broadly auto-grant powerful
    // payroll rights. An INSERT INTO `permissions` here would hand the right
    // to see and change everybody's pay to whichever designations happened to
    // hold some other key on the day this deployed.
    assert.ok(
      !/INSERT INTO `permissions`/i.test(body),
      "no designation is granted a salary right by the migration"
    );
  });

  it("creates no per-user permission override", () => {
    assert.ok(!/user_id/i.test(body), "permissions in this system are per designation");
  });
});

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const body = stripComments(sql);

  it("removes the keys from both permission tables, by name", () => {
    for (const key of SALARY_KEYS) {
      assert.ok(body.includes(`'${key}'`), `${key} is reversed`);
    }
    assert.match(body, /DELETE FROM `permissions` WHERE `permission_key` IN/);
    assert.match(body, /DELETE FROM `all_permissions` WHERE `permission_key` IN/);
  });

  it("drops the column guarded, and the table last", () => {
    assert.match(body, /COLUMN_NAME. = 'previous_pf_member'/);
    const dropColumn = body.indexOf("DROP COLUMN");
    const dropTable = body.indexOf("DROP TABLE");
    assert.ok(dropTable > dropColumn, "the table goes last, so an earlier failure leaves data intact");
  });

  it("leaves the legacy salary column alone", () => {
    assert.ok(!/new_employee` DROP COLUMN `salary`/i.test(body));
  });
});

describe("the migration wrapper", () => {
  it("points at this migration's own SQL files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });
});
