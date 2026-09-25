/**
 * The attendance-approval-revocation migration: additive, reversible, and
 * granting nothing.
 *
 *   node --test migrations/attendance_approval_revocation.test.js
 *
 * Proven against the SQL text, the way every other migration here is. The
 * table's behaviour - that a revocation writes it in the same transaction as
 * the reset - is the MariaDB suite's
 * (`repository/attendance_approval_revoke.mysql.test.js`), which builds the
 * table from THIS file.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261103120000-attendance-approval-revocation";
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const body = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

describe("up", () => {
  const sql = body(read(`${NAME}-up.sql`));

  it("creates exactly one table, and alters, inserts, updates or deletes nothing", () => {
    assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)].map((m) => m[1]), ["attendance_approval_revocation"]);
    assert.ok(!/\bALTER TABLE\b/i.test(sql));
    assert.ok(!/\bINSERT INTO\b/i.test(sql), "no permission key: revoking is for user_type 2 only");
    assert.ok(!/\bUPDATE\b\s+`?\w+`?\s+SET\b/i.test(sql));
    assert.ok(!/\bDELETE FROM\b/i.test(sql));
  });

  it("keeps the original decision, the original request state and every reset step", () => {
    for (const col of [
      "attendance_approval_request_id", "request_type", "revoked_stage_no",
      "original_decision", "original_decided_by_employee_id", "original_decided_at", "original_remarks",
      "original_request_status", "original_approved_ot_minutes", "reset_steps",
      "revoked_by_employee_id", "revoked_at", "reason",
    ]) {
      assert.match(sql, new RegExp("`" + col + "`"), col);
    }
    assert.match(sql, /`reason` VARCHAR\(500\) NOT NULL/, "the reason is mandatory");
  });

  it("cannot outlive, or be orphaned from, its request", () => {
    assert.match(sql, /FOREIGN KEY \(`attendance_approval_request_id`\) REFERENCES `attendance_approval_request` \(`attendance_approval_request_id`\) ON DELETE RESTRICT/);
  });
});

describe("down", () => {
  it("drops the one table the up created, and nothing else", () => {
    const stmts = body(read(`${NAME}-down.sql`)).split(";").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(stmts, ["DROP TABLE IF EXISTS `attendance_approval_revocation`"]);
  });
});

describe("the db-migrate wrapper", () => {
  it("runs this migration's own up and down files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`'${NAME}-up.sql'`));
    assert.match(js, new RegExp(`'${NAME}-down.sql'`));
  });
});
