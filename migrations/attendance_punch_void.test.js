/**
 * The punch-void migration: additive, guarded, re-runnable, and the
 * permission granted to nobody.
 *
 *   node --test migrations/attendance_punch_void.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NAME = "20260924120000-attendance-punch-void";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files, and sorts after the approver-setup migration", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    assert.ok(NAME > "20260923120000-attendance-approver-setup");
  });

  it("creates ONE table, guarded, and alters, drops, updates or deletes nothing", () => {
    const creates = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.equal(creates.length, 1);
    assert.match(creates[0], /^CREATE TABLE IF NOT EXISTS `attendance_punch_void`/);
    assert.equal(up.filter((s) => /^(ALTER|DROP|TRUNCATE|UPDATE|DELETE)/i.test(s)).length, 0);
  });

  it("the table identifies the raw punch by its globally unique id, once, and snapshots the audit line", () => {
    const [create] = up.filter((s) => /^CREATE TABLE/i.test(s));
    for (const column of [
      "biomax_punch_id", "punch_source", "employee_id", "punch_io_time", "attendance_date",
      "reason", "voided_by_employee_id", "voided_by_user_id", "voided_at",
    ]) {
      assert.match(create, new RegExp(`\`${column}\``), column);
    }
    assert.match(create, /UNIQUE KEY `uq_apv_punch` \(`biomax_punch_id`\)/, "no two voids for one raw punch");
    assert.match(create, /FOREIGN KEY \(`biomax_punch_id`\) REFERENCES `biomax_punch` \(`biomax_punch_id`\)/);
    assert.match(create, /`punch_source` ENUM\('BIOMAX','IMPORT'\) NOT NULL/, "raw sources only - no REGULARIZED");
    assert.match(create, /`reason` VARCHAR\(500\) NOT NULL/);
    assert.ok(!/is_active|restored|unvoid/i.test(create), "no un-void in this release");
  });

  it("40. declares void_attendance_punch and grants it to NOBODY", () => {
    const declared = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s));
    assert.equal(declared.length, 1);
    assert.match(declared[0], /'void_attendance_punch'/);
    assert.match(declared[0], /WHERE NOT EXISTS/);
    assert.equal(up.filter((s) => /^INSERT INTO `permissions`/i.test(s)).length, 0);
    assert.equal(up.filter((s) => /designation/i.test(s)).length, 0);
  });

  it("never writes to a Biomax punch table: the only reference is the foreign key", () => {
    up.forEach((s) => {
      // Column comments describe the raw punch; the SQL itself must only
      // NAME biomax_punch in the foreign key.
      const withoutLiterals = s.replace(/'[^']*'/g, "''");
      const withoutFk = withoutLiterals.replace(/REFERENCES `biomax_punch` \(`biomax_punch_id`\)/g, "");
      assert.ok(!/biomax_punch\b/i.test(withoutFk.replace(/`biomax_punch_id`/g, "")), s);
      assert.ok(!/^(INSERT INTO|UPDATE|DELETE FROM) `?biomax_punch/i.test(withoutLiterals), s);
    });
  });

  it("does not recalculate or backfill anything", () => {
    up.forEach((s) => assert.ok(!/attendance_day_calculation|attendance_monthly_payroll/i.test(s), s));
  });

  it("the down reverses exactly the up and touches biomax_punch not at all", () => {
    assert.ok(down.some((s) => /^DROP TABLE IF EXISTS `attendance_punch_void`$/i.test(s)));
    assert.ok(down.some((s) => /^DELETE FROM `all_permissions` WHERE `permission_key` IN \('void_attendance_punch'\)$/i.test(s)));
    assert.equal(down.filter((s) => /^DROP TABLE/i.test(s)).length, 1);
    down.forEach((s) => assert.ok(!/biomax_punch/i.test(s), s));
  });

  it("the permission constant matches the key the migration declares", () => {
    const P = require("../constants/hr_permissions");
    assert.equal(P.VOID_ATTENDANCE_PUNCH, "void_attendance_punch");
  });
});
