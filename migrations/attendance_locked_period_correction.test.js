/**
 * The locked-period correction migration: two tables, one permission granted
 * to nobody, no existing table altered.
 *
 *   node --test migrations/attendance_locked_period_correction.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261111120000-attendance-locked-period-correction";
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) => strip(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
const up = statements(fs.readFileSync(path.join(dir, `${NAME}-up.sql`), "utf8"));
const down = statements(fs.readFileSync(path.join(dir, `${NAME}-down.sql`), "utf8"));

describe(NAME, () => {
  it("has a js wrapper running both files, sorting after the break-pair migration", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
    assert.ok(NAME > "20261110120000-regularization-break-pair");
  });

  it("creates the two tables, guarded, and alters or deletes nothing that exists", () => {
    const creates = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.equal(creates.length, 2);
    assert.match(creates[0], /IF NOT EXISTS `attendance_locked_period_authorisation`/);
    assert.match(creates[1], /IF NOT EXISTS `attendance_locked_period_correction_event`/);
    assert.equal(up.filter((s) => /^(ALTER|DROP|UPDATE|DELETE|TRUNCATE)/i.test(s)).length, 0);
    assert.ok(!up.some((s) => /payrun_employee_calculation/.test(s)), "the frozen payrun is not touched");
  });

  it("one authorisation per request; events RESTRICT deletion; the audit and settlement columns exist", () => {
    const [auth, ev] = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.match(auth, /UNIQUE KEY `uq_alpa_request` \(`attendance_approval_request_id`\)/);
    assert.match(auth, /`status` ENUM\('REQUIRED','AUTHORISED','APPLIED','REVOKED'\)/);
    for (const c of ["authorised_by_employee_id", "authorisation_reason", "authorised_at"]) assert.match(auth, new RegExp(`\`${c}\``));
    for (const c of [
      "attendance_approval_request_id", "employee_id", "attendance_date", "event_type", "actor_employee_id", "event_reason",
      "occurred_at", "authorised_by_employee_id", "authorisation_reason", "authorised_at", "payrun_calculation_id",
      "old_calculation", "new_calculation", "payroll_difference", "net_difference", "direction", "adjustment_status",
      "applied_by", "applied_at", "applied_note", "applied_payroll_year", "applied_payroll_month",
    ]) assert.match(ev, new RegExp(`\`${c}\``), c);
    assert.match(ev, /`direction` ENUM\('PAYABLE_TO_EMPLOYEE','RECOVERABLE_FROM_EMPLOYEE','NO_DIFFERENCE'\)/);
    assert.match(ev, /`adjustment_status` ENUM\('PENDING_ADJUSTMENT','SETTLED','NOT_REQUIRED'\)/);
    assert.match(ev, /ON DELETE RESTRICT/);
  });

  it("declares correct_locked_attendance idempotently and grants it to NOBODY", () => {
    const declared = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s));
    assert.equal(declared.length, 1);
    assert.match(declared[0], /'correct_locked_attendance'/);
    assert.match(declared[0], /WHERE NOT EXISTS/);
    assert.equal(up.filter((s) => /INSERT INTO `permissions`/i.test(s)).length, 0);
  });

  it("down removes exactly what up added", () => {
    assert.ok(down.some((s) => /DROP TABLE IF EXISTS `attendance_locked_period_correction_event`/.test(s)));
    assert.ok(down.some((s) => /DROP TABLE IF EXISTS `attendance_locked_period_authorisation`/.test(s)));
    assert.ok(down.some((s) => /DELETE FROM `all_permissions`/.test(s) && /correct_locked_attendance/.test(s)));
  });
});
