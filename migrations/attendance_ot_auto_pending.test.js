/**
 * Automatic pending OT migration: two NEW tables, nothing existing altered.
 *
 *   node --test migrations/attendance_ot_auto_pending.test.js
 *
 * Run against real SQL in repository/attendance_ot_auto_pending.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261124120000-attendance-ot-auto-pending";
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const statements = (sql) =>
  sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files and sorts after every existing migration", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.equal(all.filter((f) => f === `${NAME}.js`).length, 1);
  });

  it("is ADDITIVE: it creates two tables and seeds one row, and alters nothing", () => {
    assert.equal(up.length, 3);
    assert.match(up[0], /^CREATE TABLE IF NOT EXISTS `attendance_ot_auto_pending_setting`/);
    assert.match(up[1], /^INSERT INTO `attendance_ot_auto_pending_setting`/);
    assert.match(up[2], /^CREATE TABLE IF NOT EXISTS `attendance_ot_auto_pending_log`/);
    // `ON UPDATE CURRENT_TIMESTAMP(3)` is a column default, not a statement.
    up.forEach((s) => assert.ok(!/\b(ALTER|DROP|DELETE|RENAME|TRUNCATE)\b|(?<!ON )\bUPDATE\b/i.test(s), s));
  });

  it("never touches the OT record table, a punch table or a permission", () => {
    up.forEach((s) => assert.ok(!/attendance_approval_request`|attendance_approval_step`|biomax_punch|permissions/i.test(s), s));
  });

  it("seeds the cutover once, at the IST business date of the deploy", () => {
    assert.match(up[1], /DATE\(UTC_TIMESTAMP\(\) \+ INTERVAL 330 MINUTE\) FROM DUAL/);
    assert.doesNotMatch(up[1], /INTERVAL 5 DAY/, "ongoing automation starts at deploy");
    assert.match(up[1], /WHERE NOT EXISTS/);
  });

  it("logs only what the automation does; a human decision stays on attendance_approval_step", () => {
    assert.match(up[2], /`action` ENUM\('CREATED','MINUTES_CHANGED','WITHDRAWN'\)/);
  });

  it("the down drops exactly the two new tables", () => {
    assert.deepEqual(down, [
      "DROP TABLE IF EXISTS `attendance_ot_auto_pending_log`",
      "DROP TABLE IF EXISTS `attendance_ot_auto_pending_setting`",
    ]);
  });
});
