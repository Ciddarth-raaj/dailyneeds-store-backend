/**
 * The Close Attendance for Payroll migration is additive, guarded, and writes
 * no attendance table.
 *
 *   node --test migrations/payrun_attendance_close.test.js
 *
 * Proven against the SQL text, as every other payrun migration test is. What
 * matters most about this one is what it must NOT do: a close is a PAYROLL
 * decision, and a migration that gave it the power to touch an attendance
 * table would be the first step to it quietly becoming an attendance one.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261026120000-payrun-attendance-close";
const up = fs.readFileSync(path.join(dir, `${NAME}-up.sql`), "utf8");
const down = fs.readFileSync(path.join(dir, `${NAME}-down.sql`), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");

/** Comments may NAME a table to explain why it is absent; statements may not. */
const statements = up.replace(/^\s*--.*$/gm, "");
const dml = statements.replace(/ON UPDATE CURRENT_TIMESTAMP(\(3\))?/gi, "");

describe("it never touches attendance", () => {
  it("writes no attendance table, by any verb", () => {
    for (const table of [
      "attendance_monthly_payroll",
      "attendance_day_calculation",
      "attendance_approval_request",
      "attendance_raw_punch",
    ]) {
      assert.ok(
        !new RegExp(`(ALTER TABLE|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM|DROP)\\s+\`?${table}\`?`, "i").test(dml),
        `the migration writes ${table}`
      );
    }
  });

  it("does not try to make the derived attendance finality a stored decision", () => {
    /* `attendance_monthly_payroll.is_final` is recomputed on every run as
       "no dates were held out". A close written there would be silently
       recalculated away, and would also be a lie about what attendance knows. */
    assert.ok(!/is_final/i.test(dml), "the migration touches an is_final column");
  });
});

describe("it is additive and safe on production data", () => {
  it("drops nothing, deletes nothing and rewrites no existing row", () => {
    assert.ok(!/\bDROP\b/i.test(dml), "nothing is dropped on the way up");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(dml), "no DELETE");
    assert.ok(!/\bTRUNCATE\b/i.test(dml), "no TRUNCATE");
    assert.ok(!/\bMODIFY\b|\bCHANGE\s+COLUMN\b/i.test(dml), "no column is retyped");
    /* The only UPDATE-shaped thing allowed is none at all: the close columns
       default to 0 and no existing month is retroactively closed. */
    assert.ok(!/\bUPDATE\s+`?payrun_employee`?/i.test(dml), "it back-fills a close");
  });

  it("adds its three columns to payrun_employee, each guarded and nullable-safe", () => {
    const adds = [...dml.matchAll(/ADD COLUMN `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(adds, [
      "attendance_closed_for_payroll",
      "attendance_closed_by",
      "attendance_closed_at",
    ]);

    const guards = dml.match(/information_schema`?\.`?COLUMNS/gi) || [];
    assert.equal(guards.length, adds.length, "every ADD COLUMN must be guarded");

    /* The flag defaults to NOT closed. A column that defaulted the other way
       would close every month that already exists, retroactively, silently. */
    assert.match(dml, /`attendance_closed_for_payroll` TINYINT\(1\) NOT NULL DEFAULT 0/);

    const tables = new Set((dml.match(/ALTER TABLE `([a-z_]+)`/g) || []).map((m) => m.slice(13, -1)));
    assert.deepEqual([...tables], ["payrun_employee"]);
  });

  it("creates the audit table re-runnably", () => {
    assert.match(dml, /CREATE TABLE IF NOT EXISTS `payrun_attendance_close_audit`/);
  });
});

describe("the audit preserves what payroll accepted", () => {
  it("stores the basis and not only a reference to it", () => {
    /*
     * `attendance_monthly_payroll` is upserted in place, so the row a
     * reference points at MUTATES. The reference answers "which row"; only
     * these columns answer "what did payroll actually accept".
     */
    for (const column of [
      "`salary_days`",
      "`extra_days`",
      "`shortage_minutes`",
      "`missing_minute_deduction`",
      "`approved_ot_minutes`",
      "`effective_nrm_minutes`",
      "`effective_nrm_source`",
      "`ot_groups`",
    ]) {
      assert.ok(statements.includes(column), `the audit does not store ${column}`);
    }
  });

  it("stores what was still unresolved at the moment of the close", () => {
    for (const column of [
      "`attendance_was_final`",
      "`held_dates`",
      "`pending_regularizations`",
      "`pending_ot`",
    ]) {
      assert.ok(statements.includes(column), `the audit does not store ${column}`);
    }
  });

  it("stores who decided and when", () => {
    assert.ok(statements.includes("`closed_by`"));
    assert.ok(statements.includes("`closed_at`"));
  });

  it("keeps the reference to the row the figures came from", () => {
    assert.ok(statements.includes("`attendance_monthly_payroll_id`"));
    assert.ok(statements.includes("`attendance_payroll_version`"));
    assert.ok(statements.includes("`attendance_calculated_at`"));
  });
});

describe("the permission", () => {
  it("declares exactly one key, guarded, and grants it to nobody", () => {
    const inserts = statements.match(/INSERT INTO `all_permissions`/g) || [];
    assert.equal(inserts.length, 1);
    assert.match(statements, /'close_payrun_attendance'/);
    assert.match(statements, /WHERE NOT EXISTS/);
    /* Declared, never granted: no write to `permissions` anywhere. */
    assert.ok(!/INSERT\s+INTO\s+`?permissions`?/i.test(dml), "the migration grants the key");
  });

  it("is not one of the keys that already exist", () => {
    for (const existing of ["'process_payroll'", "'approve_payrun'", "'change_payrun_pay_type'"]) {
      assert.ok(!statements.includes(existing), `it reuses ${existing}`);
    }
  });
});

describe("the down migration", () => {
  it("keeps the record of what was closed", () => {
    /* Dropping the columns would destroy which employees were paid on an
       accepted basis, for months that may already be approved and locked. */
    assert.ok(!/DROP COLUMN/i.test(down), "the down migration drops the close columns");
    assert.match(down, /DROP TABLE IF EXISTS `payrun_attendance_close_audit`/);
  });

  it("does not delete the permission key", () => {
    assert.ok(!/DELETE\s+FROM\s+`?all_permissions`?/i.test(down));
  });
});

describe("it is wired the way db-migrate reads it", () => {
  it("points at its own two sql files", () => {
    assert.ok(runner.includes(`${NAME}-up.sql`));
    assert.ok(runner.includes(`${NAME}-down.sql`));
  });

  it("sorts after every migration already applied in production", () => {
    const all = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith("-up.sql"))
      .map((f) => f.replace("-up.sql", ""))
      .sort();
    assert.equal(all[all.length - 1], NAME, "this migration must sort last");
  });
});
