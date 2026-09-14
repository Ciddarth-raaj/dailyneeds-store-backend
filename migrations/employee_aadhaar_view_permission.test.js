/**
 * The Aadhaar-status permission migration: additive, idempotent, reversible,
 * and granting exactly who it says it grants.
 *
 *   node --test migrations/employee_aadhaar_view_permission.test.js
 *
 * Proven against the SQL text; there is no database here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261004120000-employee-aadhaar-view-permission";
const KEY = "view_employee_aadhaar";

const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql).split(";").map((s) => s.trim()).filter(Boolean);

describe("up", () => {
  const sql = stripComments(read(`${NAME}-up.sql`));
  const stmts = statements(read(`${NAME}-up.sql`));

  it("declares the key and writes grants, and does nothing else", () => {
    assert.equal(stmts.length, 2, "one declaration, one grant");
    assert.match(stmts[0], /^INSERT INTO `all_permissions`/);
    assert.match(stmts[1], /^INSERT INTO `permissions`/);
    for (const forbidden of [/\bUPDATE\b/, /\bDELETE\b/, /\bDROP\b/, /\bALTER\b/, /\bTRUNCATE\b/]) {
      assert.ok(!forbidden.test(sql), `${forbidden} has no place in a permission migration`);
    }
  });

  it("declares exactly one key, and it is this one", () => {
    const declared = [...stmts[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(declared)], [KEY]);
  });

  it("GRANTS FOR CONTINUITY ONLY - today's lifecycle holders, plus HR by name", () => {
    // Set 1: exactly the designations that can read this status TODAY through
    // the lifecycle gate this migration replaces. Net effect on who can see
    // what is zero, so re-keying the route takes nothing away.
    assert.match(stmts[1], /'view_employee_lifecycle'/);
    assert.match(stmts[1], /`is_active` = TRUE/, "an inactive grant is not a grant");
    // Set 2: HR, by the one designation name this codebase relies on.
    assert.match(stmts[1], /UPPER\(TRIM\(`designation_name`\)\) = 'HR EXECUTIVE'/);
    assert.match(stmts[1], /\bUNION\b/, "a designation in both sets is inserted once");
  });

  it("DOES NOT INFER THE GRANT FROM employee_create OR employee_edit", () => {
    // The correction this version makes. Those keys are held well beyond
    // Store Manager, so inferring from them would hand Aadhaar visibility to
    // designations nobody decided to give it to.
    for (const inferred of ["employee_create", "employee_edit", "add_employees", "view_employees"]) {
      assert.ok(
        !sql.includes(`'${inferred}'`),
        `Aadhaar access must not be inferred from ${inferred}`
      );
    }
  });

  it("DOES NOT GUESS A STORE MANAGER DESIGNATION BY NAME", () => {
    // `20260919120000-attendance-v2-approvals` already records why: which
    // designations are the Store Managers is a business fact nobody has
    // written down, and a migration that guessed would assign access in the
    // one place it could never be reviewed. An administrator grants it.
    const names = [...sql.matchAll(/designation_name`\)\) = '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(names, ["HR EXECUTIVE"], "only the name this codebase already relies on");
    for (const guess of ["STORE MANAGER", "STORE_MANAGER", "MANAGER", "SUPERVISOR", "OPERATIONS"]) {
      assert.ok(!sql.toUpperCase().includes(`'${guess}'`), `${guess} must not be guessed`);
    }
  });

  it("GRANTS NO OTHER KEY - especially not lifecycle or the full number", () => {
    const granted = [...stmts[1].matchAll(/INSERT INTO `permissions`[\s\S]*?SELECT\s+'([a-z_]+)'/g)]
      .map((m) => m[1]);
    assert.deepEqual(granted, [KEY]);
    assert.ok(!sql.includes("view_aadhaar_full"), "the full number stays granted to nobody");
    assert.ok(!sql.includes("employee_scope_all_branches"), "no branch is widened here");
    assert.ok(!sql.includes("view_employee_sensitive"), "no sensitive-field access is granted");
  });

  it("is idempotent: both inserts are guarded on the key they write", () => {
    for (const stmt of stmts) {
      assert.match(stmt, /WHERE NOT EXISTS \(/);
      assert.match(stmt, new RegExp(`'${KEY}'`));
    }
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("removes the grants first, then the key, and nothing else", () => {
    assert.equal(stmts.length, 2);
    assert.match(stmts[0], /^DELETE FROM `permissions` WHERE `permission_key` IN \(/);
    assert.match(stmts[1], /^DELETE FROM `all_permissions` WHERE `permission_key` IN \(/);
    for (const stmt of stmts) {
      const listed = [...stmt.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      assert.deepEqual(listed, [KEY], "only the key this migration introduced");
    }
  });

  it("cannot revoke a pre-existing key", () => {
    const down = stripComments(read(`${NAME}-down.sql`));
    for (const survivor of [
      "view_employee_lifecycle", "employee_create", "employee_edit",
      "view_aadhaar_full", "view_employee_sensitive", "view_employees",
    ]) {
      assert.ok(!down.includes(`'${survivor}'`), `${survivor} must survive a rollback`);
    }
  });
});

describe("wiring and ordering", () => {
  it("the runner reads its own up and down files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    assert.equal((js.match(/exports\.up/g) || []).length, 1);
    assert.equal((js.match(/exports\.down/g) || []).length, 1);
  });

  it("has a unique identifier and sorts after the keys it reads", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, 14))
      .filter((id) => /^\d{14}$/.test(id));
    const mine = NAME.slice(0, 14);

    assert.equal(all.filter((id) => id === mine).length, 1, "the identifier is unique");
    // It reads `permissions` for the C2 lifecycle keys, so it must run after
    // the migration that declares them.
    assert.ok("20260907120000" < mine, "must sort after the B2 key declaration");
  });

  it("the key it declares is the one the code requires", () => {
    const P = require("../constants/hr_permissions");
    assert.equal(P.VIEW_EMPLOYEE_AADHAAR, KEY);
    const routes = fs.readFileSync(path.join(__dirname, "../routes/employee_master.js"), "utf8");
    assert.match(routes, /permissions\.require\(P\.VIEW_EMPLOYEE_AADHAAR\)/);
  });
});
