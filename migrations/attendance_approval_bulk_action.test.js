/**
 * The attendance-approval-bulk-action migration: additive, reversible, and
 * granting nothing.
 *
 *   node --test migrations/attendance_approval_bulk_action.test.js
 *
 * Proven against the SQL text. The table's behaviour - one row per selected
 * request, written by the production repository - is the MariaDB suite's
 * (`repository/attendance_approval_bulk.mysql.test.js`), which builds the
 * table from THIS file.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261105120000-attendance-approval-bulk-action";
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const body = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

describe("up", () => {
  const sql = body(read(`${NAME}-up.sql`));

  it("creates exactly one table, and alters, inserts, updates or deletes nothing", () => {
    assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)].map((m) => m[1]), ["attendance_approval_bulk_action_item"]);
    assert.ok(!/\bALTER TABLE\b/i.test(sql));
    assert.ok(!/\bINSERT INTO\b/i.test(sql), "no permission key");
    assert.ok(!/\bUPDATE\b\s+`?\w+`?\s+SET\b/i.test(sql));
    assert.ok(!/\bDELETE FROM\b/i.test(sql));
  });

  it("holds one record's request, employee, statuses, action, outcome, reason, actor, time and operation id", () => {
    for (const col of [
      "bulk_operation_id", "action", "attendance_approval_request_id", "request_type", "requested_for_employee_id",
      "attendance_date", "previous_status", "new_status", "outcome", "outcome_reason", "reason",
      "acted_by_employee_id", "acted_by_user_id", "acted_at",
    ]) {
      assert.match(sql, new RegExp("`" + col + "`"), col);
    }
    assert.match(sql, /`action` ENUM\('APPROVE','REJECT','REVOKE'\) NOT NULL/);
    assert.match(sql, /`outcome` ENUM\('SUCCEEDED','SKIPPED','FAILED'\) NOT NULL/);
    assert.match(sql, /KEY `idx_aabulk_operation` \(`bulk_operation_id`\)/);
  });
});

describe("down", () => {
  it("drops the one table the up created, and nothing else", () => {
    const stmts = body(read(`${NAME}-down.sql`)).split(";").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(stmts, ["DROP TABLE IF EXISTS `attendance_approval_bulk_action_item`"]);
  });
});

describe("the db-migrate wrapper", () => {
  it("runs this migration's own up and down files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`'${NAME}-up.sql'`));
    assert.match(js, new RegExp(`'${NAME}-down.sql'`));
  });
});
