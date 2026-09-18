/**
 * The Payrun Initialization migration is additive, re-runnable, and asserts
 * nothing about anybody's pay.
 *
 *   node --test migrations/payrun_initialization.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `m4_salary_revision_approval.test.js` proves the migration it follows. That
 * suits what matters most about this one, which is what it must NOT do:
 *
 *   it must not alter, backfill or delete a row of any existing table
 *   it must not make the payrun's idempotency an application-level promise -
 *     the unique key has to be in the schema
 *   it must not grant its permission key to anybody
 *   it must not offer HOLD as a pay type
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261021120000-payrun-initialization";
const up = fs.readFileSync(path.join(dir, `${NAME}-up.sql`), "utf8");
const down = fs.readFileSync(path.join(dir, `${NAME}-down.sql`), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");

/** Comments may NAME something to explain why it is absent; statements may not. */
const statements = up.replace(/^\s*--.*$/gm, "");
/**
 * The same text with `ON UPDATE CURRENT_TIMESTAMP` removed, for the assertions
 * that look for an UPDATE STATEMENT. That clause is a column definition and
 * updates nothing by itself; leaving it in would make "there is no UPDATE here"
 * unprovable on any table with an `updated_at`.
 */
const dml = statements.replace(/ON UPDATE CURRENT_TIMESTAMP(\(3\))?/gi, "");

describe("it is additive", () => {
  it("alters no existing table and writes no existing row", () => {
    assert.ok(!/\bALTER\s+TABLE\b/i.test(dml), "no ALTER TABLE");
    assert.ok(!/\bUPDATE\s+/i.test(dml), "no UPDATE of anything");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(dml), "no DELETE");
    assert.ok(!/\bDROP\s+/i.test(dml), "nothing is dropped on the way up");
  });

  it("touches neither the employee master nor the salary or attendance tables", () => {
    for (const table of ["new_employee", "employee_salary", "attendance_monthly_payroll", "attendance_approval_request"]) {
      assert.ok(
        !new RegExp(`(ALTER TABLE|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+\`?${table}\`?`, "i").test(dml),
        `the migration writes ${table}`
      );
    }
  });

  it("creates exactly the three tables the feature owns, all re-runnably", () => {
    const created = (statements.match(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(created, ["payrun_period", "payrun_employee", "payrun_employee_pay_type_audit"]);
    assert.equal(
      (statements.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || []).length,
      0,
      "an unguarded CREATE TABLE cannot be re-run"
    );
  });
});

describe("the schema is what the rules depend on", () => {
  it("one snapshot per employee per month, enforced by the DATABASE", () => {
    assert.match(
      statements,
      /UNIQUE KEY `uq_payrun_employee_month` \(`period_year`, `period_month`, `employee_id`\)/,
      "idempotency must be a constraint, not an application-level promise"
    );
  });

  it("the pay type is BANK or CASH, and HOLD is not a value anywhere", () => {
    assert.match(statements, /`pay_type` ENUM\('BANK','CASH'\) NOT NULL/);
    assert.ok(!/HOLD/.test(statements), "hold is a payroll status, never a pay route");
  });

  it("a pay type comes from the master or from a person - there is no third source", () => {
    assert.match(statements, /`pay_type_source` ENUM\('EMPLOYEE_MASTER','MANUAL'\) NOT NULL/);
    assert.ok(
      !/RESIGNED/.test(statements),
      "initialization does not default a leaver to CASH; HR moves them, which is MANUAL"
    );
  });

  it("the month can be locked, and a month with no row is open", () => {
    assert.match(statements, /`status` ENUM\('OPEN','LOCKED'\) NOT NULL DEFAULT 'OPEN'/);
    assert.ok(
      !/INSERT\s+INTO\s+`payrun_period`/i.test(statements),
      "backfilling a row per historical month would be inventing history"
    );
  });

  it("the audit records BOTH values, and who and when", () => {
    ["old_pay_type", "new_pay_type", "changed_by", "changed_at"].forEach((column) =>
      assert.ok(statements.includes(`\`${column}\``), `the audit has no ${column}`)
    );
  });

  it("the snapshot carries the attendance REFERENCE and its version markers", () => {
    ["attendance_monthly_payroll_id", "attendance_payroll_version", "attendance_calculated_at"].forEach(
      (column) => assert.ok(statements.includes(`\`${column}\``), `the snapshot has no ${column}`)
    );
    // And not a copy of the attendance numbers themselves.
    ["attendance_days", "salary_days", "shortage_minutes", "approved_ot_minutes"].forEach((column) =>
      assert.ok(!statements.includes(`\`${column}\``), `the snapshot duplicates ${column} from attendance`)
    );
  });

  it("it snapshots who they were, what they were paid and their statutory setup", () => {
    [
      "employee_name", "store_id", "store_name", "designation_id", "designation_name",
      "date_of_joining", "resignation_date",
      "salary_id", "salary_effective_from", "monthly_gross", "basic",
      "pf_applicable", "esi_applicable", "uan", "pf_number", "esi_number",
      "initialized_at", "initialized_by", "status",
    ].forEach((column) => assert.ok(statements.includes(`\`${column}\``), `the snapshot has no ${column}`));
  });
});

describe("the permission", () => {
  it("declares exactly one key and grants it to nobody", () => {
    const keys = (statements.match(/SELECT '([a-z_]+)' AS `permission_key`/g) || []).map((m) =>
      m.replace(/.*'([a-z_]+)'.*/, "$1")
    );
    assert.deepEqual(keys, ["change_payrun_pay_type"]);
    assert.ok(
      !/INSERT\s+INTO\s+`permissions`/i.test(statements),
      "a key granted by migration is a capability nobody decided to give"
    );
    assert.match(statements, /WHERE NOT EXISTS/, "the declaration must be re-runnable");
  });
});

describe("the down migration", () => {
  it("drops the child table before its parent, and leaves the catalogue alone", () => {
    const dropped = (down.match(/DROP TABLE IF EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(dropped, [
      "payrun_employee_pay_type_audit",
      "payrun_employee",
      "payrun_period",
    ], "the child table's foreign key means it has to go first");
    assert.ok(
      !/DELETE\s+FROM\s+`all_permissions`/i.test(down),
      "deleting the key would orphan any designation already granted it"
    );
  });
});

describe("the runner", () => {
  it("reads the two sql files beside it", () => {
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
  });
});
