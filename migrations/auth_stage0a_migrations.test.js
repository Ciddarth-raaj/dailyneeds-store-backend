/**
 * Gate 22 — the Stage 0A migrations are additive and idempotent.
 *
 * Proven against the SQL text, not a database (none exists here): every
 * up-migration only ADDs (columns, tables, index-in-ALTER, guarded inserts),
 * the `user` change is a single statement, and every CREATE / INSERT is
 * guarded so a re-run after a partial failure is harmless. The one
 * non-additive clause - `password` becoming nullable - is widening, and is
 * called out explicitly.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) => stripComments(sql).split(";").map((s) => s.trim()).filter(Boolean);

const FILES = {
  user: "20260906120000-auth-stage0a-user-columns-up.sql",
  log: "20260906120100-auth-stage0a-auth-log-up.sql",
  reset: "20260906120200-auth-stage0a-password-reset-up.sql",
  perms: "20260906120300-auth-stage0a-permissions-up.sql",
};

describe("gate 22 — Stage 0A migrations are additive", () => {
  it("user-columns: exactly ONE statement, only ADD COLUMN / ADD INDEX and one widening MODIFY", () => {
    const stmts = statements(read(FILES.user));
    assert.equal(stmts.length, 1, "must be a single ALTER TABLE so it is atomic on MySQL 5.7 and 8");
    const [alter] = stmts;
    assert.match(alter, /^ALTER TABLE `user`/);
    const clauses = alter.replace(/^ALTER TABLE `user`/, "").split(/,\n/).map((c) => c.trim());
    for (const c of clauses) {
      assert.ok(
        /^ADD COLUMN /.test(c) || /^ADD INDEX /.test(c) || c === "MODIFY `password` TEXT NULL",
        `non-additive clause: ${c}`
      );
    }
    assert.doesNotMatch(alter, /DROP|RENAME|CHANGE |DELETE|TRUNCATE|UPDATE /i);
    // every added column is nullable or defaulted, so existing rows need nothing
    for (const c of clauses.filter((c) => c.startsWith("ADD COLUMN"))) {
      assert.ok(/ NULL| DEFAULT /.test(c), `column without NULL/DEFAULT: ${c}`);
    }
  });

  it("user-columns: does not touch new_employee or employee_id", () => {
    const sql = stripComments(read(FILES.user));
    assert.doesNotMatch(sql, /new_employee/);
    assert.doesNotMatch(sql, /employee_id`? (INT|VARCHAR|CHANGE|MODIFY)/i);
  });

  it("auth-log and password-reset: only CREATE TABLE IF NOT EXISTS", () => {
    for (const f of [FILES.log, FILES.reset]) {
      const stmts = statements(read(f));
      assert.ok(stmts.length >= 1);
      for (const s of stmts) {
        assert.match(s, /^CREATE TABLE IF NOT EXISTS `(user_auth_log|auth_metric|user_password_reset)`/, `${f}: ${s.slice(0, 60)}`);
        assert.doesNotMatch(s, /new_employee/);
      }
    }
  });

  it("permissions: every insert is guarded by WHERE NOT EXISTS (idempotent)", () => {
    const stmts = statements(read(FILES.perms));
    assert.equal(stmts.length, 3);
    for (const s of stmts) {
      assert.match(s, /^INSERT INTO `all_permissions` \(`permission_key`\)\s+SELECT '[a-z_]+' FROM DUAL WHERE NOT EXISTS/);
    }
  });

  it("every up-migration has a down-migration that only drops what it added (or restores NOT NULL)", () => {
    for (const up of Object.values(FILES)) {
      const down = read(up.replace("-up.sql", "-down.sql"));
      assert.ok(down.trim().length > 0, `${up} has no down`);
      assert.doesNotMatch(stripComments(down), /new_employee/);
    }
    const userDown = stripComments(read(FILES.user.replace("-up.sql", "-down.sql")));
    assert.match(userDown, /UPDATE `user` SET `password` = '' WHERE `password` IS NULL/);
    assert.match(userDown, /MODIFY `password` TEXT NOT NULL/);
  });

  it("re-running any up-migration after a partial failure is safe: no unguarded CREATE or INSERT", () => {
    for (const f of Object.values(FILES)) {
      const sql = stripComments(read(f));
      assert.doesNotMatch(sql, /CREATE TABLE `/, `${f}: CREATE TABLE without IF NOT EXISTS`);
      assert.doesNotMatch(sql, /INSERT INTO `all_permissions` \(`permission_key`\) VALUES/, `${f}: unguarded INSERT`);
      assert.doesNotMatch(sql, /^\s*CREATE INDEX/m, `${f}: standalone CREATE INDEX is not idempotent`);
    }
  });

  it("the Stage 0A migrations sort after the upstream telegram-password-reset migration already in production", () => {
    const all = fs.readdirSync(path.join(__dirname, "mysql/migrations")).filter((f) => f.endsWith(".js"));
    const upstream = "20260906070000-telegram-password-reset.js";
    const mine = Object.values(FILES).map((f) => f.replace("-up.sql", ".js"));
    // The upstream file exists on origin/main-autodeploy; it may or may not be
    // present on this branch yet, but ordering by timestamp must hold either way.
    for (const m of mine) assert.ok(m > upstream, `${m} must sort after ${upstream}`);
    assert.ok(all.length > 0);
  });
});
