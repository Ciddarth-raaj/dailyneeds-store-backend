/**
 * The Payrun Adjustments migration is additive, re-runnable, and safe on
 * production data.
 *
 *   node --test migrations/payrun_adjustments.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `payrun_initialization.test.js` proves the migration it follows. That suits
 * what matters most about this one, which is what it must NOT do:
 *
 *   it must not alter, backfill or delete a row of any existing table
 *   it must not touch historical payroll data
 *   it must not make the duplicate rule an application-level promise - the
 *     unique key on month + employee + component has to be in the schema
 *   it must not declare a new permission key
 *   it must not offer a generic or custom component
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261022120000-payrun-adjustments";
const up = fs.readFileSync(path.join(dir, `${NAME}-up.sql`), "utf8");
const down = fs.readFileSync(path.join(dir, `${NAME}-down.sql`), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");

/** Comments may NAME something to explain why it is absent; statements may not. */
const statements = up.replace(/^\s*--.*$/gm, "");
/** `ON UPDATE CURRENT_TIMESTAMP` is a column definition, not an UPDATE. */
const dml = statements.replace(/ON UPDATE CURRENT_TIMESTAMP(\(3\))?/gi, "");

describe("it is additive and safe on existing production data", () => {
  it("alters no existing table and writes no existing row", () => {
    assert.ok(!/\bALTER\s+TABLE\b/i.test(dml), "no ALTER TABLE");
    assert.ok(!/\bUPDATE\s+/i.test(dml), "no UPDATE of anything");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(dml), "no DELETE");
    assert.ok(!/\bDROP\s+/i.test(dml), "nothing is dropped on the way up");
    assert.ok(!/\bTRUNCATE\b/i.test(dml), "nothing is truncated");
  });

  it("does not modify historical payroll or any table it does not own", () => {
    for (const table of [
      "new_employee",
      "employee_salary",
      "attendance_monthly_payroll",
      "attendance_approval_request",
      "payrun_employee",
      "payrun_period",
      "payrun_employee_pay_type_audit",
    ]) {
      assert.ok(
        !new RegExp(`(ALTER TABLE|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+\`?${table}\`?(?![_a-z])`, "i").test(dml),
        `the migration writes ${table}`
      );
    }
  });

  it("creates exactly the three tables the stage owns, all re-runnably", () => {
    const created = (statements.match(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(created, [
      "payrun_employee_adjustment",
      "payrun_employee_adjustment_state",
      "payrun_employee_adjustment_audit",
    ]);
    assert.equal(
      (statements.match(/CREATE TABLE\b/gi) || []).length,
      created.length,
      "a CREATE TABLE is not guarded by IF NOT EXISTS"
    );
  });

  it("DECLARES NO PERMISSION KEY - the stage reuses process_payroll", () => {
    assert.ok(!/INSERT\s+INTO\s+`?all_permissions`?/i.test(dml));
  });
});

describe("the constraints are in the DATABASE, not in a promise", () => {
  it("makes a duplicate month + employee + component impossible", () => {
    assert.match(
      statements,
      /UNIQUE KEY `uq_payrun_adjustment_component`\s*\n?\s*\(`period_year`, `period_month`, `employee_id`, `component`\)/
    );
  });

  it("makes a second state row for one employee's month impossible", () => {
    assert.match(
      statements,
      /UNIQUE KEY `uq_payrun_adjustment_state_month`\s*\n?\s*\(`period_year`, `period_month`, `employee_id`\)/
    );
  });

  it("hangs every table off an INITIALIZED payrun row by foreign key", () => {
    const keys = statements.match(/FOREIGN KEY \(`payrun_employee_id`\) REFERENCES `payrun_employee`/g) || [];
    assert.equal(keys.length, 3, "each of the three tables must reference payrun_employee");
  });

  it("refuses a negative amount at the column", () => {
    assert.match(statements, /CHECK \(`amount` >= 0\)/);
  });

  it("stores the confirmation with its actor and its timestamp", () => {
    for (const column of ["confirmed_no_adjustment", "confirmed_by", "confirmed_at"]) {
      assert.ok(new RegExp("`" + column + "`").test(statements), `${column} is missing`);
    }
    assert.match(statements, /`confirmed_no_adjustment` TINYINT\(1\) NOT NULL DEFAULT 0/);
  });
});

describe("V1 is closed in the schema too", () => {
  const enums = statements.match(/ENUM\(\s*\n?\s*'INCENTIVE'[^)]*\)/g) || [];

  it("declares exactly the six components, wherever a component appears", () => {
    assert.ok(enums.length >= 2, "the component enum should appear on the amounts and the audit");
    enums.forEach((declaration) => {
      ["INCENTIVE", "BONUS", "ARREARS", "ADVANCE_RECOVERY", "SHORTAGE_RECOVERY", "BALANCE_ADVANCE"].forEach(
        (key) => assert.ok(declaration.includes(`'${key}'`), `${key} is missing from a component enum`)
      );
    });
  });

  it("offers no generic or custom component", () => {
    for (const forbidden of ["LOAN_RECOVERY", "OTHER_ADDITION", "OTHER_DEDUCTION", "CUSTOM", "'OTHER'"]) {
      assert.ok(!statements.includes(forbidden), `${forbidden} must not be in the schema`);
    }
  });

  it("records where a change came from", () => {
    assert.match(statements, /`source` ENUM\('MANUAL','IMPORT'\)/);
  });
});

describe("the down migration", () => {
  it("drops only the three tables this migration created", () => {
    const dropped = (down.match(/DROP TABLE IF EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(dropped, [
      "payrun_employee_adjustment_audit",
      "payrun_employee_adjustment_state",
      "payrun_employee_adjustment",
    ]);
    assert.equal((down.match(/DROP TABLE/gi) || []).length, dropped.length);
  });

  it("deletes no permission key", () => {
    assert.ok(!/DELETE\s+FROM\s+`?all_permissions`?/i.test(down));
  });
});

describe("the runner", () => {
  it("points at this migration's own two files", () => {
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
  });

  it("sorts after the initialization migration it depends on", () => {
    assert.ok(NAME > "20261021120000-payrun-initialization", "it would run before the table it references");
  });
});
