/**
 * The Attendance Approver Setup migration: additive, guarded, no payroll
 * data, no Biomax table, no grant.
 *
 *   node --test migrations/attendance_approver_setup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const statements = (sql) =>
  sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
const withoutLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''");

const NAME = "20260923120000-attendance-approver-setup";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("creates the approver master and its audit, both guarded", () => {
    const creates = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.equal(creates.length, 2);
    creates.forEach((s) => assert.match(s, /^CREATE TABLE IF NOT EXISTS/i));
    assert.match(creates[0], /`attendance_approver_setup`/);
    assert.match(creates[1], /`attendance_approver_setup_audit`/);
  });

  it("the master stores employee IDS only, one row per employee, with who/when", () => {
    const master = up.find((s) => /`attendance_approver_setup` \(/.test(s));
    for (const col of ["employee_id", "first_level_approver_employee_id", "second_level_approver_employee_id", "final_approver_employee_id", "is_active", "created_by", "created_at", "updated_by", "updated_at"]) {
      assert.match(master, new RegExp(`\`${col}\``), col);
    }
    assert.match(master, /`first_level_approver_employee_id` INT NULL/);
    assert.match(master, /`second_level_approver_employee_id` INT NULL/);
    assert.match(master, /`final_approver_employee_id` INT NOT NULL/);
    assert.match(master, /UNIQUE KEY `uq_aas_employee` \(`employee_id`\)/);
    assert.ok(!/_name`/.test(master), "no name column");
  });

  it("the audit captures employee, level, old, new, action, who and when - and the reassigned step", () => {
    const audit = up.find((s) => /`attendance_approver_setup_audit` \(/.test(s));
    for (const col of ["employee_id", "approval_level", "old_approver_employee_id", "new_approver_employee_id", "action_type", "attendance_approval_request_id", "attendance_approval_step_id", "changed_by", "changed_at"]) {
      assert.match(audit, new RegExp(`\`${col}\``), col);
    }
    assert.match(audit, /ENUM\('FIRST','SECOND','FINAL'\)/);
    assert.match(audit, /ENUM\('SET','BULK_SET','REPLACE'\)/);
  });

  it("alters existing tables only by ADDING nullable columns, an index, and an appended ENUM value", () => {
    const alters = up.filter((s) => /^ALTER TABLE/i.test(s));
    assert.ok(alters.length >= 4);
    alters.forEach((s) => {
      assert.ok(!/\bDROP\b/i.test(s), s);
      assert.ok(!/\bRENAME\b/i.test(s), s);
      assert.ok(!/\bCHANGE\b/i.test(s), s);
      if (/ADD COLUMN/i.test(s)) assert.match(s, /NULL DEFAULT NULL/i, `must be nullable: ${s}`);
    });
    const modify = alters.filter((s) => /\bMODIFY\b/i.test(s));
    assert.equal(modify.length, 1, "exactly one MODIFY: the ENUM append");
    assert.match(modify[0], /`approver_role` ENUM\('STORE_MANAGER','OPERATIONS_MANAGER','HR','ADMIN','EMPLOYEE'\) NOT NULL/);
    assert.match(up.join(" "), /`attendance_approval_step` ADD COLUMN `approver_employee_id` INT NULL DEFAULT NULL/);
    assert.match(up.join(" "), /`attendance_approval_step` ADD COLUMN `approval_level` ENUM\('FIRST','SECOND','FINAL'\) NULL DEFAULT NULL/);
    assert.match(up.join(" "), /`attendance_approval_request` ADD COLUMN `chain_source` ENUM\('ROLE','EMPLOYEE'\) NULL DEFAULT NULL/);
  });

  it("declares manage_attendance_approvers and grants it to NOBODY", () => {
    const declares = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s));
    assert.equal(declares.length, 1);
    assert.match(declares[0], /'manage_attendance_approvers'/);
    assert.match(declares[0], /WHERE NOT EXISTS/);
    assert.equal(up.filter((s) => /^INSERT INTO `permissions`/i.test(s)).length, 0);
  });

  it("rewrites no existing row and touches no Biomax or payroll table", () => {
    up.forEach((s) => {
      assert.ok(!/^UPDATE\b/i.test(s) && !/^DELETE\b/i.test(s), s);
      assert.ok(!/biomax_punch|salary|payroll/i.test(withoutLiterals(s)), s);
    });
  });

  it("the down removes exactly what was added and drops no pre-existing table", () => {
    assert.ok(down.some((s) => /DROP TABLE IF EXISTS `attendance_approver_setup_audit`/.test(s)));
    assert.ok(down.some((s) => /DROP TABLE IF EXISTS `attendance_approver_setup`/.test(s)));
    down.filter((s) => /^DROP TABLE/i.test(s)).forEach((s) => assert.match(s, /attendance_approver_setup/));
    assert.ok(!/attendance_approval_request`$|DROP TABLE IF EXISTS `attendance_approval_step`/.test(down.join(";")));
    assert.ok(down.some((s) => /DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_approvers'/.test(s)));
  });
});
