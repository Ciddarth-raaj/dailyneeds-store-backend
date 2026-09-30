/**
 * The attendance-permission migration: additive, reversible, granting nobody.
 *
 *   node --test migrations/attendance_permission.test.js
 *
 * Proven against the SQL text. The tables' behaviour is the MariaDB suite's
 * (`repository/attendance_permission.mysql.test.js`), which builds them from
 * THIS file.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const NAME = "20261107120000-attendance-permission";
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const body = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

const KEYS = [
  "view_attendance_permissions",
  "raise_attendance_permission_request",
  "raise_attendance_permission_for_others",
  "approve_attendance_permission",
  "grant_attendance_permission",
  "grant_attendance_permission_bulk",
  "revoke_attendance_permission",
];

describe("identity", () => {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
  it("is unique and sorts after every attendance migration it builds on", () => {
    assert.equal(all.filter((f) => f.slice(0, 14) === NAME.slice(0, 14)).length, 1);
    for (const earlier of [
      "20261029120000-shift-change-request",
      "20261103120000-attendance-approval-revocation",
      "20261106120000-attendance-approval-revocation-outcome",
    ]) {
      assert.ok(all.includes(earlier), earlier);
      assert.ok(earlier < NAME, `${earlier} runs first`);
    }
  });
  it("the wrapper runs this migration's own files", () => {
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`'${NAME}-up.sql'`));
    assert.match(js, new RegExp(`'${NAME}-down.sql'`));
  });
});

describe("up", () => {
  const sql = body(read(`${NAME}-up.sql`));

  it("PERMISSION joins the existing request type, beside the four that are there", () => {
    assert.match(
      sql,
      /MODIFY COLUMN `request_type` ENUM\('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE','PERMISSION'\) NOT NULL/
    );
  });

  it("a pending permission has its own open-request group, so it never blocks a correction or OT claim", () => {
    assert.match(sql, /`open_request_group` ENUM\('ATT','SHIFT','PERM'\) GENERATED ALWAYS AS/);
    assert.match(sql, /WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT' WHEN `request_type` = 'PERMISSION' THEN 'PERM' ELSE 'ATT'/);
    assert.match(
      sql,
      /ADD UNIQUE KEY `uq_aareq_open_per_employee_date` \(`requested_for_employee_id`, `open_attendance_date`, `open_request_group`\)/
    );
  });

  it("creates exactly the three new tables", () => {
    assert.deepEqual(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)].map((m) => m[1]),
      ["attendance_permission_bulk_operation", "attendance_permission", "attendance_permission_bulk_item"]
    );
  });

  it("the permission row answers who, what period, why, which origin, which bulk, who revoked and when", () => {
    const table = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS `attendance_permission` "));
    for (const col of [
      "employee_id", "attendance_date", "permission_from", "permission_to", "to_shift_end", "permission_minutes",
      "reason", "remarks", "source", "attendance_approval_request_id", "bulk_operation_id", "outlet_id",
      "created_by_employee_id", "created_by_user_id", "created_at", "revoked_by_employee_id",
      "revoked_by_user_id", "revoked_at", "revoke_reason", "revoke_bulk_operation_id", "updated_at",
    ]) {
      assert.match(table, new RegExp("`" + col + "`"), col);
    }
    assert.match(table, /`source` ENUM\('REQUEST','DIRECT'\) NOT NULL/);
    assert.match(table, /`permission_from` DATETIME NOT NULL/);
    assert.ok(!/`status`/.test(table.slice(0, table.indexOf("ENGINE"))), "status is derived, never stored");
  });

  it("the stored day records what the permission did, with no guessed history", () => {
    assert.match(sql, /ADD COLUMN `permission_minutes` INT NOT NULL DEFAULT 0/);
    assert.match(sql, /ADD COLUMN `shortage_before_permission_minutes` INT NULL DEFAULT NULL/);
    assert.match(sql, /ADD COLUMN `payable_minutes` INT NULL DEFAULT NULL/);
    for (const col of ["permission_ids", "permission_window_minutes", "permission_late_minutes", "permission_early_minutes", "permission_away_minutes"]) {
      assert.match(sql, new RegExp("ADD COLUMN `" + col + "`"), col);
    }
  });

  it("the monthly summary records the day rows it was made from, NULL on older summaries", () => {
    assert.match(sql, /ADD COLUMN `day_rows_fingerprint` CHAR\(64\) NULL DEFAULT NULL/);
  });

  it("declares every key and grants none of them", () => {
    for (const key of KEYS) {
      assert.match(sql, new RegExp(`INSERT INTO \`all_permissions\` \\(\`permission_key\`\\) SELECT '${key}' FROM DUAL WHERE NOT EXISTS`), key);
    }
    assert.ok(!/INSERT INTO `permissions`/.test(sql), "no designation is granted anything");
  });

  it("rewrites no existing row", () => {
    assert.ok(!/\bUPDATE\b\s+`?\w+`?\s+SET\b/i.test(sql));
    assert.ok(!/\bDELETE FROM\b/i.test(sql));
  });
});

describe("down", () => {
  const sql = body(read(`${NAME}-down.sql`));
  it("drops what up created and restores the two-group key and the four-type enum", () => {
    for (const t of ["attendance_permission_bulk_item", "attendance_permission", "attendance_permission_bulk_operation"]) {
      assert.match(sql, new RegExp(`DROP TABLE IF EXISTS \`${t}\``));
    }
    assert.match(sql, /`open_request_group` ENUM\('ATT','SHIFT'\) GENERATED ALWAYS AS/);
    assert.match(sql, /ENUM\('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE'\) NOT NULL/);
    assert.match(sql, /ALTER TABLE `attendance_monthly_payroll` DROP COLUMN `day_rows_fingerprint`, DROP COLUMN `permission_minutes`/);
  });
  it("removes a key only while nobody holds it", () => {
    assert.match(sql, /AND NOT EXISTS \( SELECT 1 FROM `permissions` `p`/);
  });
});
