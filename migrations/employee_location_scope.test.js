/**
 * The DN-EMPLOYEE-LOCATION-SCOPE migration: additive, reversible, and
 * asserting nothing about anybody.
 *
 *   node --test migrations/employee_location_scope.test.js
 *
 * Proven against the SQL text, the way every other migration here is. What
 * matters most is what it must NOT do: it must not set the new flag on any
 * row, must not name an employee or a designation, and must not touch
 * `store_id`, which every branch authorization scope reads.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261028120000-employee-location-scope";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const stmts = statements(sql);
  const body = stripComments(sql).replace(/\s+/g, " ");

  it("adds one column, NOT NULL DEFAULT 0", () => {
    const add = stmts.find((s) => /ALTER TABLE `new_employee`/.test(s));
    assert.match(add, /ADD COLUMN `works_all_locations` TINYINT\(1\) NOT NULL DEFAULT 0/);
  });

  /**
   * THE DEFAULT IS THE WHOLE BACKFILL. Every employee who exists today is
   * expected at their own outlet, which is what the column says about them the
   * moment it appears. Nobody is marked roaming by a schema change: who roams
   * is an operational decision recorded per person.
   */
  it("sets the flag on NO row - there is no UPDATE at all", () => {
    assert.ok(!/UPDATE\s+`?new_employee`?/i.test(body), "no row is rewritten");
    assert.ok(!/works_all_locations`?\s*=\s*1/i.test(body), "nobody is marked roaming");
  });

  it("does not touch store_id, which every authorization scope reads", () => {
    // It is NAMED in the column comment, which is the point of the comment.
    // What must not exist is a statement that writes it.
    assert.ok(!/SET\s+`?store_id`?/i.test(body), "no statement assigns store_id");
    assert.ok(!/DROP COLUMN `store_id`/i.test(body));
  });

  it("names no employee and no designation", () => {
    assert.ok(!/kumaraguru/i.test(sql), "not even in a comment");
    assert.ok(!/designation/i.test(body), "the rule is a column, not a job title");
  });

  it("declares the view permission once, and idempotently", () => {
    const ins = stmts.find((s) => /INSERT INTO `all_permissions`/.test(s));
    assert.match(ins, /'view_employee_location_scope'/);
    assert.match(ins, /WHERE NOT EXISTS/, "re-running must not duplicate the key");
  });

  /**
   * CHANGING IT HAS NO GRANTABLE KEY ON PURPOSE - `middlewares/admin_only.js`
   * checks `user_type = 2` directly, exactly as `attendance_required` does.
   */
  it("declares no key for CHANGING it", () => {
    assert.ok(!/edit_employee_location_scope|set_employee_location_scope/i.test(body));
  });

  it("touches only new_employee and all_permissions", () => {
    const tables = [...body.matchAll(/(?:ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM)\s+`(\w+)`/gi)].map(
      (m) => m[1]
    );
    assert.deepEqual([...new Set(tables)].sort(), ["all_permissions", "new_employee"]);
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("drops exactly what the up added, and nothing else", () => {
    assert.deepEqual(stmts, [
      "ALTER TABLE `new_employee` DROP COLUMN `works_all_locations`",
      "DELETE FROM `all_permissions` WHERE `permission_key` = 'view_employee_location_scope'",
    ]);
  });
});

describe("the runner", () => {
  it("points at both SQL files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`${NAME}-up\\.sql`));
    assert.match(js, new RegExp(`${NAME}-down\\.sql`));
  });

  it("both SQL files exist", () => {
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-up.sql`)));
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-down.sql`)));
  });
});
