/**
 * The single-date shift override migration: additive, guarded, re-runnable.
 *
 *   node --test migrations/attendance_v2_date_shift_override.test.js
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

const NAME = "20260920120000-attendance-v2-date-shift-override";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("creates ONE table, guarded, and alters nothing", () => {
    const creates = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.equal(creates.length, 1);
    assert.match(creates[0], /^CREATE TABLE IF NOT EXISTS `attendance_date_shift_override`/);
    assert.equal(up.filter((s) => /^ALTER/i.test(s)).length, 0);
    assert.equal(up.filter((s) => /^(DROP|TRUNCATE|UPDATE)/i.test(s)).length, 0);
  });

  it("the table carries the whole audit line and no unique key, so a second edit appends", () => {
    const [create] = up.filter((s) => /^CREATE TABLE/i.test(s));
    for (const column of [
      "employee_id", "attendance_date", "work_shift_id", "previous_work_shift_id", "changed_by", "created_at",
    ]) {
      assert.match(create, new RegExp(`\`${column}\``), column);
    }
    assert.ok(!/UNIQUE KEY/i.test(create), "append-only: no unique key on (employee, date)");
    assert.match(create, /KEY `idx_adso_employee_date` \(`employee_id`, `attendance_date`\)/);
    assert.match(create, /FOREIGN KEY \(`work_shift_id`\) REFERENCES `work_shift`/);
  });

  it("it is a ONE-DATE table: no effective_from, no effective_to", () => {
    const [create] = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.ok(!/effective_from|effective_to/i.test(create));
  });

  it("declares edit_attendance_date_shift and grants it to NOBODY", () => {
    const declared = up.filter((s) => /^INSERT INTO `all_permissions`/i.test(s));
    assert.equal(declared.length, 1);
    assert.match(declared[0], /'edit_attendance_date_shift'/);
    assert.match(declared[0], /WHERE NOT EXISTS/);
    assert.equal(up.filter((s) => /^INSERT INTO `permissions`/i.test(s)).length, 0);
  });

  it("never writes to a Biomax punch table and revokes nothing on the way up", () => {
    up.forEach((s) => {
      assert.ok(!/biomax_punch/i.test(s), s);
      assert.ok(!/^DELETE/i.test(s), s);
    });
  });

  it("the down reverses exactly the up", () => {
    assert.ok(down.some((s) => /^DROP TABLE IF EXISTS `attendance_date_shift_override`$/i.test(s)));
    assert.ok(down.some((s) => /^DELETE FROM `all_permissions` WHERE `permission_key` IN \('edit_attendance_date_shift'\)$/i.test(s)));
    assert.equal(down.filter((s) => /^DROP TABLE/i.test(s)).length, 1);
  });

  it("the permission constant matches the key the migration declares", () => {
    const P = require("../constants/hr_permissions");
    assert.equal(P.EDIT_ATTENDANCE_DATE_SHIFT, "edit_attendance_date_shift");
  });
});
