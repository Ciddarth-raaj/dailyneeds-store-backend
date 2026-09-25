/**
 * The device time correction migration: additive, guarded, no permission key,
 * and the raw punch never written.
 *
 *   node --test migrations/attendance_device_time_correction.test.js
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

const NAME = "20261104120000-attendance-device-time-correction";
const up = statements(read(`${NAME}-up.sql`));
const down = statements(read(`${NAME}-down.sql`));

describe(NAME, () => {
  it("has a js wrapper that runs both files, and sorts after every existing migration", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    const others = fs.readdirSync(path.join(__dirname, "mysql/migrations")).filter((f) => /^\d{14}-.*\.js$/.test(f));
    // Sorts after every migration that existed when it was written; the only
    // ones after it are the ones added since, named here so a new one is a
    // deliberate addition to this list.
    const LATER = ["20261105120000-attendance-approval-bulk-action.js"];
    assert.deepEqual(others.filter((f) => f > `${NAME}.js`).sort(), LATER);
  });

  it("creates exactly two guarded tables and alters, drops, updates or deletes nothing", () => {
    const creates = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.deepEqual(
      creates.map((s) => /`([a-z_]+)`/.exec(s)[1]),
      ["attendance_device_time_correction", "attendance_device_time_correction_punch"]
    );
    creates.forEach((s) => assert.match(s, /^CREATE TABLE IF NOT EXISTS/));
    assert.equal(up.filter((s) => /^(ALTER|DROP|TRUNCATE|UPDATE|DELETE|INSERT)/i.test(s)).length, 0);
  });

  it("keeps the audit line: original and corrected time, offset, reason, who and when, batch id, revert fields", () => {
    const [batch, punch] = up.filter((s) => /^CREATE TABLE/i.test(s));
    for (const c of ["batch_ref", "correction_date", "biomax_device_id", "dev_id", "outlet_id", "window_from", "window_to",
      "offset_minutes", "reason_code", "remarks", "status", "applied_by_employee_id", "applied_at",
      "reverted_by_employee_id", "reverted_at", "revert_reason"]) {
      assert.match(batch, new RegExp(`\`${c}\``), c);
    }
    assert.match(batch, /`status` ENUM\('APPLIED','REVERTED'\)/);
    assert.match(batch, /UNIQUE KEY `uq_adtc_batch_ref` \(`batch_ref`\)/, "one preview, one apply");
    for (const c of ["biomax_punch_id", "original_io_time", "corrected_io_time", "offset_minutes", "is_active"]) {
      assert.match(punch, new RegExp(`\`${c}\``), c);
    }
  });

  it("the database refuses a second ACTIVE correction of one punch", () => {
    const [, punch] = up.filter((s) => /^CREATE TABLE/i.test(s));
    assert.match(punch, /`active_biomax_punch_id` BIGINT UNSIGNED GENERATED ALWAYS AS \(CASE WHEN `is_active` = 1 THEN `biomax_punch_id` ELSE NULL END\) STORED/);
    assert.match(punch, /UNIQUE KEY `uq_adtcp_active_punch` \(`active_biomax_punch_id`\)/);
  });

  it("declares and grants no permission - administrators only, by user_type", () => {
    up.forEach((s) => assert.ok(!/permissions/i.test(s), s));
  });

  it("never writes a Biomax punch table: the only reference is the foreign key", () => {
    up.forEach((s) => {
      const withoutLiterals = s.replace(/'[^']*'/g, "''");
      assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM) `?biomax_punch/i.test(withoutLiterals), s);
    });
  });

  it("the down drops exactly the two tables, children first, and nothing else", () => {
    assert.deepEqual(down, [
      "DROP TABLE IF EXISTS `attendance_device_time_correction_punch`",
      "DROP TABLE IF EXISTS `attendance_device_time_correction`",
    ]);
  });
});
