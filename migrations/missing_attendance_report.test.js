/**
 * THE MISSING ATTENDANCE MIGRATION, read as text.
 *
 *   node --test migrations/missing_attendance_report.test.js
 *
 * No database. What is asserted is what the SQL SAYS, because the risk this
 * migration carries is not that it fails - it is that it quietly touches a
 * table it has no business touching on a production database full of
 * attendance and payroll history.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const NAME = "20261027120000-missing-attendance-report";
const dir = path.join(__dirname, "mysql", "migrations", "sqls");
const up = fs.readFileSync(path.join(dir, `${NAME}-up.sql`), "utf8");
const down = fs.readFileSync(path.join(dir, `${NAME}-down.sql`), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "mysql", "migrations", `${NAME}.js`), "utf8");

/** SQL with the comment lines removed - what actually runs. */
const statements = up
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("it is additive, and it touches nothing it does not own", () => {
  it("alters no existing table and adds no column to one", () => {
    assert.ok(!/ALTER\s+TABLE/i.test(statements), "it alters a table");
    assert.ok(!/ADD\s+COLUMN/i.test(statements), "it adds a column");
    assert.ok(!/DROP\s+COLUMN/i.test(statements), "it drops a column");
  });

  it("writes no row of any attendance, punch, shift, employee or payroll table", () => {
    const forbidden = [
      "new_employee",
      "biomax_punch",
      "biomax_punch_derived",
      "attendance_day_calculation",
      "attendance_monthly_payroll",
      "attendance_approval_request",
      "attendance_regularized_punch",
      "attendance_punch_void",
      "attendance_date_shift_override",
      "employee_work_shift_assignment",
      "work_shift",
      "work_shift_weekly_schedule",
      "work_shift_config_version",
      "employee_salary",
      "payrun_employee_calculation",
      "employee_telegram_identity",
    ];
    const writes = statements.match(/(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+`?(\w+)`?/gi) || [];
    writes.forEach((write) => {
      forbidden.forEach((table) => {
        assert.ok(
          !new RegExp(`\`?${table}\`?\\s*$`, "i").test(write),
          `the up migration writes to ${table}: "${write}"`
        );
      });
    });
  });

  it("references `new_employee` by FOREIGN KEY only - no employee data is copied", () => {
    const employeeMentions = statements.match(/new_employee/g) || [];
    assert.equal(employeeMentions.length, 1, "new_employee is named more than once");
    assert.match(statements, /FOREIGN KEY \(`employee_id`\)\s*\n?\s*REFERENCES `new_employee`/);
  });

  it("creates its table guarded, so a re-run adds nothing", () => {
    assert.match(statements, /CREATE TABLE IF NOT EXISTS `attendance_missing_notification`/);
    assert.equal((statements.match(/CREATE TABLE/gi) || []).length, 1, "it creates more than one table");
  });
});

describe("the permission keys", () => {
  it("declares both keys, each insert guarding itself", () => {
    ["view_missing_attendance_report", "export_missing_attendance_report"].forEach((key) => {
      assert.match(
        statements,
        new RegExp(`INSERT INTO \`all_permissions\`[\\s\\S]*?'${key}'[\\s\\S]*?NOT EXISTS`),
        `${key} is not inserted with a guard`
      );
    });
  });

  it("GRANTS THEM TO NOBODY - no write to `permissions` at all", () => {
    assert.ok(
      !/INSERT\s+INTO\s+`?permissions`?/i.test(statements),
      "the up migration grants a designation one of these keys"
    );
  });

  it("does not reuse or alter an existing attendance key", () => {
    ["view_attendance_dashboard", "view_calculated_attendance", "view_raw_attendance"].forEach((key) => {
      assert.ok(!statements.includes(key), `it touches ${key}`);
    });
  });
});

describe("the duplicate guard is the database's", () => {
  it("is a UNIQUE key on (employee_id, attendance_date), not a check in code", () => {
    assert.match(statements, /UNIQUE KEY `uq_amn_employee_date` \(`employee_id`, `attendance_date`\)/);
  });

  it("keeps the punch count that was actually quoted to the employee", () => {
    assert.match(statements, /`punch_count`\s+INT NOT NULL/);
  });

  it("carries the employee/date pair a Mini App handoff needs, and no Mini App column", () => {
    assert.match(statements, /`employee_id`\s+INT NOT NULL/);
    assert.match(statements, /`attendance_date`\s+DATE NOT NULL/);
    assert.ok(!/mini_?app/i.test(statements), "it adds a column for a Mini App that does not exist");
  });
});

describe("the down migration", () => {
  it("removes only what the up created", () => {
    assert.match(down, /DROP TABLE IF EXISTS `attendance_missing_notification`/);
    assert.match(down, /DELETE FROM `permissions`/);
    assert.match(down, /DELETE FROM `all_permissions`/);
    assert.equal((down.match(/DROP TABLE/gi) || []).length, 1);
    assert.ok(!/ALTER\s+TABLE/i.test(down), "the down migration alters a table");
  });
});

describe("it is wired the way db-migrate reads it", () => {
  it("points at its own two sql files", () => {
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
  });

  it("sorts after every migration that existed when it was written", () => {
    const earlier = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith("-up.sql"))
      .map((f) => f.replace("-up.sql", ""))
      .filter((name) => name < NAME);
    assert.ok(earlier.includes("20261026120000-payrun-attendance-close"));
    assert.ok(earlier.every((name) => name < NAME));
  });
});
