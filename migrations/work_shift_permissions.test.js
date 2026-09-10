/**
 * The Work Shift permission migration declares five keys, grants them to one
 * named designation, and touches nothing else.
 *
 *   node --test migrations/work_shift_permissions.test.js
 *
 * Proven against the SQL text - there is no database here - the same way
 * `hr_permission_keys_b2.test.js` and `employee_default_work_shift.test.js`
 * prove theirs. That suits what matters most about this one: what it must NOT
 * do. It must not derive its grants from `view_shift`, because reproducing
 * the access of the key this change exists to stop trusting would undo the
 * change. It must not grant employee-master keys as a side effect. It must
 * not revoke anything, and it must not touch a table or a column.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260910160000-work-shift-permissions";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

/** The five keys, as the routes name them. */
const KEYS = [
  P.VIEW_WORK_SHIFTS,
  P.MANAGE_WORK_SHIFTS,
  P.VIEW_SHIFT_ASSIGNMENTS,
  P.ASSIGN_EMPLOYEE_SHIFT,
  P.BULK_ASSIGN_EMPLOYEE_SHIFT,
];

describe("up", () => {
  const stmts = statements(read(`${NAME}-up.sql`));
  const declarations = stmts.filter((s) => /^INSERT INTO `all_permissions`/.test(s));
  const grants = stmts.filter((s) => /^INSERT INTO `permissions`/.test(s));

  it("is inserts only - no table, column or employee row is touched", () => {
    for (const stmt of stmts) {
      assert.match(stmt, /^INSERT INTO/, `unexpected statement: ${stmt}`);
    }
    assert.equal(stmts.length, declarations.length + grants.length);
  });

  it("declares all five keys, each guarded so a re-run adds nothing", () => {
    assert.equal(declarations.length, 5);
    for (const key of KEYS) {
      const stmt = declarations.find((s) => s.includes(`'${key}'`));
      assert.ok(stmt, `${key} is declared`);
      assert.match(stmt, /WHERE NOT EXISTS \(SELECT 1 FROM `all_permissions`/);
    }
  });

  it("grants all five, to HR EXECUTIVE and to nobody else", () => {
    assert.equal(grants.length, 1);
    const [grant] = grants;
    for (const key of KEYS) {
      assert.ok(grant.includes(`'${key}'`), `${key} is granted`);
    }
    assert.match(grant, /FROM `designation` WHERE UPPER\(TRIM\(`designation_name`\)\) = 'HR EXECUTIVE'/);
  });

  it("names the designation rather than hard-coding an id", () => {
    // Ids differ between production and any restored copy; a literal one
    // would grant these to whatever designation held that number.
    assert.ok(
      !/`designation_id`\s*=\s*\d/.test(grants[0]),
      "no literal designation_id in the grant"
    );
  });

  it("does NOT derive the grant from the legacy shift keys", () => {
    // The whole point: `view_shift` is held by designations with no payroll
    // role, so granting from it would reproduce the access being withdrawn.
    for (const stmt of stmts) {
      assert.ok(!stmt.includes("'view_shift'"), "no grant is derived from view_shift");
      assert.ok(!stmt.includes("'add_shifts'"), "no grant is derived from add_shifts");
    }
  });

  it("does not hand out employee-master keys as a side effect", () => {
    for (const key of [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.ADD_EMPLOYEES]) {
      for (const stmt of stmts) {
        assert.ok(!stmt.includes(`'${key}'`), `${key} is not granted here`);
      }
    }
  });

  it("is guarded on (permission_key, designation_id) so a re-run adds nothing", () => {
    assert.match(grants[0], /WHERE NOT EXISTS \( SELECT 1 FROM `permissions` p/);
    assert.match(grants[0], /p\.`permission_key` = k\.`permission_key`/);
    assert.match(grants[0], /p\.`designation_id` = d\.`designation_id`/);
  });

  it("revokes nothing", () => {
    const sql = read(`${NAME}-up.sql`);
    for (const word of ["DELETE", "UPDATE", "DROP", "ALTER", "TRUNCATE"]) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(stripComments(sql)), `no ${word}`);
    }
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("removes exactly the five keys this migration introduced", () => {
    assert.equal(stmts.length, 2);
    for (const stmt of stmts) {
      assert.match(stmt, /^DELETE FROM `(permissions|all_permissions)` WHERE `permission_key` IN/);
      for (const key of KEYS) assert.ok(stmt.includes(`'${key}'`), `${key} is removed`);
    }
  });

  it("leaves every other permission alone", () => {
    const sql = stripComments(read(`${NAME}-down.sql`));
    for (const key of [P.VIEW_SHIFT, P.ADD_SHIFTS, P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT]) {
      assert.ok(!sql.includes(`'${key}'`), `${key} is untouched`);
    }
    assert.ok(!/\bDROP\b|\bALTER\b|\bTRUNCATE\b/.test(sql));
  });
});
