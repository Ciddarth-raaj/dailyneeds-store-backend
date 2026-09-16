/**
 * The verification-cache migration: one table, additive, identity-bound.
 *
 *   node --test migrations/employee_telegram_group_verification.test.js
 *
 * THE PROPERTY THAT MATTERS MOST is the foreign key to
 * `employee_telegram_identity`. A reconnect INSERTS a new identity row
 * rather than updating the old one, so a verification bound to the row stops
 * matching automatically when somebody connects a different Telegram
 * account. Bound to the EMPLOYEE instead, a verification taken against an
 * account they no longer use would keep them looking Complete forever.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { VERIFIED_MEMBERSHIP } = require("../constants/telegram_membership");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260916180000-employee-telegram-group-verification";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  strip(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const upSql = read(`${NAME}-up.sql`);
const upBody = strip(upSql);
const upStatements = statements(upSql);
const downStatements = statements(read(`${NAME}-down.sql`));
const createTable = upStatements.find((s) => /^CREATE TABLE/i.test(s));

describe("the migration file", () => {
  it("reads its own two SQL files and holds a unique timestamp", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`${NAME}-up\\.sql`));
    assert.match(js, new RegExp(`${NAME}-down\\.sql`));
    const all = fs.readdirSync(path.join(__dirname, "mysql/migrations")).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.split("-")[0])), [`${NAME}.js`]);
  });
});

describe("the table", () => {
  it("is the only table created", () => {
    assert.ok(createTable);
    assert.match(createTable, /CREATE TABLE IF NOT EXISTS `employee_telegram_group_verification`/);
    assert.equal(upStatements.filter((s) => /^CREATE TABLE/i.test(s)).length, 1);
  });

  it("IS BOUND TO THE IDENTITY ROW, which is what makes a reconnect invalidate it", () => {
    assert.match(createTable, /`employee_telegram_id` INT NOT NULL/);
    assert.match(
      createTable,
      /CONSTRAINT `fk_etgv_identity` FOREIGN KEY \(`employee_telegram_id`\) REFERENCES `employee_telegram_identity` \(`employee_telegram_id`\) ON DELETE CASCADE/
    );
    // Unique per identity AND group - not per employee and group, which
    // would let a new identity collide with the old one's rows.
    assert.match(
      createTable,
      /UNIQUE KEY `uq_etgv_identity_group` \(`employee_telegram_id`, `telegram_group_id`\)/
    );
  });

  it("records only a verdict and a time", () => {
    const match = createTable.match(/`membership` ENUM\(([^)]+)\)/);
    assert.ok(match, "membership must be an ENUM");
    const values = match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(values.sort(), Object.values(VERIFIED_MEMBERSHIP).sort());
    assert.match(createTable, /`readiness_status` VARCHAR\(32\) NOT NULL/);
    assert.match(createTable, /`verified_at` DATETIME NOT NULL/);
  });

  it("stores NO private identifier of any kind", () => {
    for (const column of [
      "telegram_user_id",
      "private_chat_id",
      "telegram_username",
      "mobile",
      "invite_link",
      "invite_link_hash",
      "token",
    ]) {
      assert.ok(!new RegExp("`" + column + "`").test(createTable), `must not store ${column}`);
    }
  });

  it("documents that TELEGRAM_UNAVAILABLE is never written", () => {
    // The rule the whole cache's trustworthiness rests on: "we could not
    // ask" must never overwrite a real answer.
    assert.match(upBody, /TELEGRAM_UNAVAILABLE is never stored/i);
  });

  it("has no Phase 3C column", () => {
    for (const column of ["removed_at", "banned_at", "reconciled_at", "lifecycle"]) {
      assert.ok(!new RegExp(column, "i").test(createTable), `${column} is Phase 3C`);
    }
  });
});

describe("what the migration must NOT do", () => {
  it("creates no permission and alters nothing existing", () => {
    assert.ok(!/all_permissions|permission_key/i.test(upBody));
    for (const statement of upStatements) {
      assert.ok(
        !/^(ALTER|DROP|RENAME|TRUNCATE|UPDATE|DELETE|INSERT)\b/i.test(statement),
        `additive only, but found: ${statement.slice(0, 60)}`
      );
    }
  });
});

describe("the down migration", () => {
  it("drops only this table", () => {
    assert.deepEqual(downStatements, [
      "DROP TABLE IF EXISTS `employee_telegram_group_verification`",
    ]);
  });

  it("touches no other table", () => {
    const down = downStatements.join(" ");
    for (const table of [
      "employee_telegram_identity",
      "telegram_group_registry",
      "employee_telegram_group_join_attempt",
      "new_employee",
      "all_permissions",
    ]) {
      assert.ok(!new RegExp(table).test(down), `down must not touch ${table}`);
    }
  });
});
