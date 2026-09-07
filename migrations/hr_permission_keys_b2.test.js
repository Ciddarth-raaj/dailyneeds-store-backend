/**
 * Stage 0B / B2 — the permission-key migration is additive, idempotent and
 * exactly reversible.
 *
 * Proven against the SQL text (there is no database here). The point of the
 * migration is narrow: declare four keys so an administrator can grant them.
 * It must not grant anything, must not touch any other key, and running it
 * twice must be the same as running it once.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260907120000-hr-permission-keys-b2";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

const KEYS = ["view_employee_sensitive", "edit_employee_sensitive", "add_documents", "add_stores"];

describe("B2 migration — up", () => {
  const stmts = statements(read(`${NAME}-up.sql`));

  it("is four guarded inserts into all_permissions and nothing else", () => {
    assert.equal(stmts.length, 4);
    for (const s of stmts) {
      assert.match(s, /^INSERT INTO `all_permissions` \(`permission_key`\)/);
      assert.match(s, /WHERE NOT EXISTS \(SELECT 1 FROM `all_permissions` WHERE `permission_key` = '[a-z_]+'\)$/);
    }
  });

  it("declares exactly the four B2 keys, once each", () => {
    const declared = stmts.map((s) => s.match(/SELECT '([a-z_]+)' FROM DUAL/)[1]);
    assert.deepEqual(declared.slice().sort(), KEYS.slice().sort());
    assert.equal(new Set(declared).size, 4, "no key declared twice");
  });

  it("grants nothing: it never writes to the permissions table", () => {
    const sql = stripComments(read(`${NAME}-up.sql`));
    assert.equal(/INSERT INTO `permissions`/.test(sql), false, "a migration must not grant a designation anything");
    assert.equal(/\bUPDATE\b/.test(sql), false);
    assert.equal(/\bDELETE\b/.test(sql), false);
    assert.equal(/\bDROP\b|\bALTER\b/.test(sql), false);
  });

  it("is idempotent: each insert is guarded by its own NOT EXISTS on the same key", () => {
    for (const s of stmts) {
      const inserted = s.match(/SELECT '([a-z_]+)' FROM DUAL/)[1];
      const guarded = s.match(/WHERE `permission_key` = '([a-z_]+)'\)$/)[1];
      assert.equal(inserted, guarded, "the guard must name the key being inserted");
    }
  });
});

describe("B2 migration — down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("removes the grants first, then the keys, and touches nothing else", () => {
    assert.equal(stmts.length, 2);
    assert.match(stmts[0], /^DELETE FROM `permissions` WHERE `permission_key` IN \(/);
    assert.match(stmts[1], /^DELETE FROM `all_permissions` WHERE `permission_key` IN \(/);
    for (const s of stmts) {
      const listed = [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      assert.deepEqual(listed.slice().sort(), KEYS.slice().sort(), "down must name exactly the four keys");
    }
  });

  it("is exactly the inverse of up — no other key can be affected", () => {
    const down = stripComments(read(`${NAME}-down.sql`));
    for (const k of ["view_employees", "add_employees", "view_banks", "view_documents", "view_stores"]) {
      assert.equal(down.includes(`'${k}'`), false, `${k} is a pre-existing key and must survive a rollback`);
    }
  });

  it("re-running down is harmless (DELETE of absent rows is a no-op)", () => {
    const down = stripComments(read(`${NAME}-down.sql`));
    assert.equal(/DROP|TRUNCATE/.test(down), false);
  });
});

describe("B2 migration — ordering and boilerplate", () => {
  it("sorts after every Stage 0A migration, so db-migrate runs it after them", () => {
    const files = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, ""))
      .sort();
    // This used to assert B2 was the LAST migration in the directory, which
    // was true the day it was written and false the moment another migration
    // was added (Stage 0C / C1a). The property that actually matters is the
    // one below: B2 runs after the Stage 0A migrations it depends on.
    assert.ok(files.includes(NAME), "the B2 migration must be present");
    for (const stage0a of [
      "20260906120000-auth-stage0a-user-columns",
      "20260906120300-auth-stage0a-permissions",
    ]) {
      assert.ok(NAME > stage0a, `${NAME} must sort after ${stage0a}`);
    }
  });

  it("the runner reads its own up and down files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
    assert.equal((js.match(/exports\.up/g) || []).length, 1);
    assert.equal((js.match(/exports\.down/g) || []).length, 1);
  });

  it("every key the B2 mapping uses either already exists or is declared here", () => {
    const P = require("../constants/hr_permissions");
    const declared = new Set(KEYS);
    const preexisting = new Set(
      fs
        .readdirSync(dir)
        .filter((f) => f.includes("permission") && f.endsWith("-up.sql"))
        .flatMap((f) => [...read(f).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
    );
    for (const key of Object.values(P)) {
      assert.ok(
        declared.has(key) || preexisting.has(key),
        `${key} is used by the B2 mapping but is declared by no migration`
      );
    }
  });
});
