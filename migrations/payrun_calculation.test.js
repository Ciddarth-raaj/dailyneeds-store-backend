/**
 * The Payrun Calculation & Review migration is additive, re-runnable, and safe
 * on production data.
 *
 *   node --test migrations/payrun_calculation.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `payrun_initialization.test.js` and `payrun_adjustments.test.js` prove the
 * migrations it follows. That suits what matters most about this one, which is
 * what it must NOT do:
 *
 *   it must not alter, backfill or delete a row of any existing table
 *   it must not touch historical payroll data
 *   it must not make "one calculation per employee per month" an
 *     application-level promise - the unique key has to be in the schema
 *   it must not lock a month, anywhere
 *   it must not close off the future controlled correction path
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261023120000-payrun-calculation";
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
      "attendance_day_calculation",
      "attendance_approval_request",
      "payrun_employee",
      "payrun_period",
      "payrun_employee_pay_type_audit",
      "payrun_employee_adjustment",
      "payrun_employee_adjustment_state",
    ]) {
      assert.ok(
        !new RegExp(
          `(ALTER TABLE|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+\`?${table}\`?(?![_a-z])`,
          "i"
        ).test(dml),
        `the migration writes ${table}`
      );
    }
  });

  /**
   * IN PARTICULAR, `payrun_employee.status` IS NOT WIDENED. The calculation
   * states live on the new table; a status on the snapshot would be a second
   * copy of the answer that can disagree with the figures beside it.
   */
  it("leaves the initialization snapshot's own status enum alone", () => {
    assert.ok(!/payrun_employee`?\s+(MODIFY|CHANGE|ADD)/i.test(dml));
  });

  it("creates exactly the two tables the stage owns, both re-runnably", () => {
    const created = (statements.match(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(created, [
      "payrun_employee_calculation",
      "payrun_employee_calculation_audit",
    ]);
    assert.equal(
      (statements.match(/CREATE TABLE\b/gi) || []).length,
      created.length,
      "every CREATE TABLE must be guarded with IF NOT EXISTS"
    );
  });
});

describe("the schema enforces the rules rather than trusting the application", () => {
  it("makes one calculation per employee per month a database guarantee", () => {
    assert.match(
      statements,
      /UNIQUE KEY `uq_payrun_calculation_month` \(`period_year`, `period_month`, `employee_id`\)/
    );
  });

  it("keeps the calculation hanging off an initialized month", () => {
    assert.match(
      statements,
      /FOREIGN KEY \(`payrun_employee_id`\) REFERENCES `payrun_employee` \(`payrun_employee_id`\)/
    );
  });

  /**
   * THE APPROVAL AUDIT THE SPECIFICATION ASKS FOR, column by column: who
   * approved, when, what calculation reference, who locked and when.
   */
  it("carries the whole approval and lock audit", () => {
    for (const column of [
      "`approved_by`",
      "`approved_at`",
      "`locked_by`",
      "`locked_at`",
      "`calculation_version`",
      "`calculation_revision`",
      "`calculation_hash`",
    ]) {
      assert.ok(statements.includes(column), `missing ${column}`);
    }
  });

  /**
   * EVERY FIGURE NEEDED TO REPRODUCE AND EXPLAIN THE MONTH. A payslip that can
   * only be explained by re-running an engine is a payslip nobody can defend
   * to the person it belongs to.
   */
  it("stores every value the payroll has to be explainable from", () => {
    for (const column of [
      "`daily_rate`", "`salary_days`", "`salary_earnings`",
      "`missing_hours_minutes`", "`missing_hours_deduction`",
      "`extra_days`", "`extra_day_amount`",
      "`approved_ot_hours`", "`effective_nrm_minutes`", "`effective_nrm_source`",
      "`ot_hourly_rate`", "`ot_amount`",
      "`incentive`", "`bonus`", "`arrears`",
      "`advance_recovery`", "`shortage_recovery`", "`balance_advance`",
      "`pf_wage`", "`employee_pf`", "`employer_epf`", "`employer_eps`",
      "`esi_wage`", "`employee_esi`", "`employer_esi`",
      "`total_earnings`", "`total_employee_deductions`", "`net_pay`", "`pay_type`",
    ]) {
      assert.ok(statements.includes(column), `missing ${column}`);
    }
  });

  /**
   * THE SOURCE MARKERS, so that "has anything moved since" is answerable from
   * the row rather than from a promise.
   */
  it("stores the identity of every source it consumed", () => {
    for (const column of [
      "`salary_id`", "`salary_effective_from`", "`monthly_gross`",
      "`attendance_monthly_payroll_id`", "`attendance_payroll_version`",
      "`attendance_calculated_at`", "`approved_ot_minutes`",
      "`effective_nrm_minutes`", "`pf_applicable`", "`esi_applicable`",
      "`source_hash`", "`inputs_hash`",
    ]) {
      assert.ok(statements.includes(column), `missing ${column}`);
    }
  });
});

describe("the lock is per employee, and the future correction path stays open", () => {
  /**
   * NOTHING HERE CAN LOCK A MONTH. `payrun_period` is not written by this
   * migration and the lock lives on a row keyed by (year, month, employee), so
   * one employee being approved says nothing about anybody else.
   */
  it("locks employees and never months", () => {
    assert.ok(!/payrun_period/i.test(dml), "this migration must not touch payrun_period");
    assert.match(statements, /`status` ENUM\('CALCULATED','APPROVED_LOCKED'\)/);
  });

  /**
   * UNLOCK IS NOT IMPLEMENTED AND MUST NOT BE MADE IMPOSSIBLE. The columns and
   * the audit verb exist so that the controlled path - Unpublish, Delete
   * Payslip, Unlock, Recalculate, Review, Approve & Lock, Generate, Publish -
   * costs a code change later rather than an ALTER on a table full of approved
   * payroll.
   */
  it("leaves room for a future employee-level unlock", () => {
    for (const column of ["`unlocked_by`", "`unlocked_at`", "`unlock_reason`"]) {
      assert.ok(statements.includes(column), `missing ${column}`);
    }
    assert.match(statements, /ENUM\('CALCULATE','RECALCULATE','APPROVE_LOCK','UNLOCK'\)/);
  });

  /**
   * APPROVAL AND LOCK ARE TWO PAIRS OF COLUMNS. After a future unlock the row
   * is no longer locked while the fact that it was once approved, by whom and
   * when, is exactly what an auditor asks for. One pair would have to be
   * overwritten to express that.
   */
  it("records approval and lock as separate facts", () => {
    assert.ok(statements.includes("`approved_by`") && statements.includes("`locked_by`"));
  });
});

describe("the permission key", () => {
  it("declares exactly one, guarded, and grants it to nobody", () => {
    const inserts = statements.match(/INSERT INTO `all_permissions`/g) || [];
    assert.equal(inserts.length, 1);
    assert.match(statements, /'approve_payrun'/);
    assert.match(statements, /WHERE NOT EXISTS/i);
    assert.ok(
      !/INSERT\s+INTO\s+`permissions`/i.test(statements),
      "the key is declared, never granted"
    );
  });

  it("adds no other key", () => {
    const keys = [...statements.matchAll(/SELECT '([a-z_]+)' AS `permission_key`/g)].map((m) => m[1]);
    assert.deepEqual(keys, ["approve_payrun"]);
  });
});

describe("the reversal", () => {
  it("drops only what this migration created, child table first", () => {
    const dropped = (down.match(/DROP TABLE IF EXISTS `([a-z_]+)`/g) || []).map((m) =>
      m.replace(/.*`([a-z_]+)`.*/, "$1")
    );
    assert.deepEqual(dropped, [
      "payrun_employee_calculation_audit",
      "payrun_employee_calculation",
    ]);
  });

  it("leaves the permission catalogue alone, as the payrun migrations before it do", () => {
    assert.ok(!/DELETE\s+FROM\s+`?all_permissions`?/i.test(down));
  });
});

describe("the migration is wired the way db-migrate reads it", () => {
  it("points at its own two SQL files and nothing else", () => {
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
    assert.ok(runner.includes("exports.up") && runner.includes("exports.down"));
  });
});
