/**
 * The existing-employee Aadhaar VERIFICATION permission migration: additive,
 * idempotent, reversible, and granting exactly who it says it grants.
 *
 *   node --test migrations/employee_aadhaar_verify_permission.test.js
 *
 * Proven against the SQL text; there is no database here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261010120000-employee-aadhaar-verify-permission";
const KEY = "verify_employee_aadhaar";

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

  it("GRANTS IT TO HR EXECUTIVE ONLY, by the name this codebase relies on", () => {
    assert.match(stmts[1], /UPPER\(TRIM\(d\.`designation_name`\)\) = 'HR EXECUTIVE'/);
    const names = [...sql.matchAll(/designation_name`\)\) = '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(names, ["HR EXECUTIVE"], "only the name this codebase already relies on");
  });

  it("DOES NOT INFER THE GRANT FROM ANY EXISTING KEY", () => {
    // The approved rule: an administrator must deliberately tick it. Inferring
    // from a key held well beyond Store Manager would hand Aadhaar
    // verification to designations nobody decided to give it to.
    for (const inferred of [
      "employee_create",
      "employee_edit",
      "view_employees",
      "view_employee_aadhaar",
      "add_employees",
      "view_employee_lifecycle",
    ]) {
      assert.ok(
        !sql.includes(`'${inferred}'`),
        `Aadhaar verification must not be inferred from ${inferred}`
      );
    }
  });

  it("DOES NOT GUESS A STORE MANAGER DESIGNATION BY NAME", () => {
    for (const guess of ["STORE MANAGER", "STORE_MANAGER", "MANAGER", "SUPERVISOR", "OPERATIONS"]) {
      assert.ok(!sql.toUpperCase().includes(`'${guess}'`), `${guess} must not be guessed`);
    }
  });

  it("GRANTS NO OTHER KEY - no sensitive edit, no full number, no branch", () => {
    const granted = [...stmts[1].matchAll(/INSERT INTO `permissions`[\s\S]*?SELECT\s+'([a-z_]+)'/g)]
      .map((m) => m[1]);
    assert.deepEqual(granted, [KEY]);
    assert.ok(!sql.includes("'edit_employee_sensitive'"), "B3's write key is not granted here");
    assert.ok(!sql.includes("'view_employee_sensitive'"), "no sensitive-field read is granted");
    assert.ok(!sql.includes("'view_aadhaar_full'"), "the full number stays granted to nobody");
    assert.ok(!sql.includes("'employee_scope_all_branches'"), "no branch is widened here");
  });

  it("is idempotent: both inserts are guarded on the key they write", () => {
    for (const stmt of stmts) {
      assert.match(stmt, /NOT EXISTS \(/);
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
      "view_employee_aadhaar", "employee_create", "employee_edit",
      "edit_employee_sensitive", "view_aadhaar_full", "view_employees",
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
    assert.ok("20260907120000" < mine, "must sort after the B2 key declaration");
  });

  it("the key it declares is the one the code requires", () => {
    const P = require("../constants/hr_permissions");
    assert.equal(P.VERIFY_EMPLOYEE_AADHAAR, KEY);
    const routes = fs.readFileSync(
      path.join(__dirname, "../routes/employee_aadhaar_verification.js"),
      "utf8"
    );
    assert.match(routes, /permissions\.require\(P\.VERIFY_EMPLOYEE_AADHAAR\)/);
  });

  it("THE ONBOARDING ROUTES DO NOT REQUIRE IT", () => {
    // Creating a new employee must not start needing this key: it is
    // specifically for an employee who already exists.
    const master = fs.readFileSync(path.join(__dirname, "../routes/employee_master.js"), "utf8");
    assert.ok(
      !master.includes("VERIFY_EMPLOYEE_AADHAAR"),
      "the employee-master router, which carries Add Employee's Aadhaar flow, must not check it"
    );
  });
});
