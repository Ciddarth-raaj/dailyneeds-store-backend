/**
 * The Phase 3B join-attempt migration: one table, additive, no permission.
 *
 *   node --test migrations/employee_telegram_group_join.test.js
 *
 * THE PROPERTIES THAT MATTER:
 *
 *   NO INVITE URL COLUMN - only a hash. The URL is a working credential.
 *   NO Telegram user id column - the identity table owns that, and a second
 *   copy would be a second thing to keep in step.
 *   A UNIQUE live marker, so two Generate clicks cannot leave two live links.
 *   No removal/reconciliation column anywhere - that is Phase 3C.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ATTEMPT_STATUS } = require("../constants/telegram_membership");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260916160000-employee-telegram-group-join";
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
    const stamp = NAME.split("-")[0];
    assert.deepEqual(all.filter((f) => f.startsWith(stamp)), [`${NAME}.js`]);
  });
});

describe("the table", () => {
  it("is the only table created", () => {
    assert.ok(createTable);
    assert.match(createTable, /CREATE TABLE IF NOT EXISTS `employee_telegram_group_join_attempt`/);
    assert.equal(upStatements.filter((s) => /^CREATE TABLE/i.test(s)).length, 1);
  });

  it("stores a HASH and NEVER the invite URL", () => {
    assert.match(createTable, /`invite_link_hash` CHAR\(64\) NOT NULL/);
    assert.ok(!/invite_link` (VARCHAR|TEXT)/.test(createTable), "no column could hold the URL");
    assert.ok(!/invite_url/i.test(createTable));
  });

  it("stores NO Telegram user id - the identity table owns that", () => {
    for (const column of ["telegram_user_id", "private_chat_id", "telegram_username", "mobile"]) {
      assert.ok(!new RegExp("`" + column + "`").test(createTable), `must not store ${column}`);
    }
  });

  it("carries exactly the seven attempt statuses the code uses", () => {
    const match = createTable.match(/`status` ENUM\(([^)]+)\)/);
    assert.ok(match, "status must be an ENUM");
    const values = match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(values.sort(), Object.values(ATTEMPT_STATUS).sort());
  });

  it("makes ONE LIVE ATTEMPT per employee per group a database rule", () => {
    // Not a hopeful pre-check: two Generate clicks milliseconds apart must
    // not both leave a working link.
    assert.match(createTable, /`live_marker` VARCHAR\(32\) AS/);
    assert.match(createTable, /CASE WHEN `status` = 'PENDING'/);
    assert.match(createTable, /UNIQUE KEY `uq_etgja_live` \(`live_marker`\)/);
    // NULL when concluded, so history piles up without colliding.
    assert.match(createTable, /ELSE NULL END\) STORED/);
  });

  it("makes the invite hash unique, so one link maps to one attempt", () => {
    assert.match(createTable, /UNIQUE KEY `uq_etgja_invite_hash` \(`invite_link_hash`\)/);
  });

  it("cascades from the registry group and from nothing else", () => {
    assert.match(
      createTable,
      /CONSTRAINT `fk_etgja_group` FOREIGN KEY \(`telegram_group_id`\) REFERENCES `telegram_group_registry`/
    );
    assert.equal((createTable.match(/FOREIGN KEY/g) || []).length, 1);
  });

  it("has NO Phase 3C column - nothing records a removal", () => {
    for (const column of ["removed_at", "banned_at", "reconciled_at", "left_at", "lifecycle"]) {
      assert.ok(!new RegExp(column, "i").test(createTable), `${column} is Phase 3C`);
    }
  });
});

describe("what the migration must NOT do", () => {
  it("creates no permission and touches no grant", () => {
    assert.ok(!/all_permissions|permission_key/i.test(upBody));
  });

  it("alters, drops or rewrites nothing that already exists", () => {
    for (const statement of upStatements) {
      assert.ok(
        !/^(ALTER|DROP|RENAME|TRUNCATE|UPDATE|DELETE|INSERT)\b/i.test(statement),
        `additive only, but found: ${statement.slice(0, 60)}`
      );
    }
  });

  it("does not touch the identity, registry, mapping or employee tables", () => {
    for (const table of [
      "employee_telegram_identity",
      "telegram_group_mapping",
      "new_employee",
    ]) {
      assert.ok(!new RegExp(`ALTER TABLE .${table}`, "i").test(upBody));
    }
  });
});

describe("the down migration", () => {
  it("drops the one table this task created, and only that", () => {
    assert.deepEqual(downStatements, [
      "DROP TABLE IF EXISTS `employee_telegram_group_join_attempt`",
    ]);
  });

  it("revokes nothing and drops no other table", () => {
    const down = downStatements.join(" ");
    for (const table of [
      "employee_telegram_identity",
      "telegram_group_registry",
      "telegram_group_mapping",
      "new_employee",
      "all_permissions",
    ]) {
      assert.ok(!new RegExp(table).test(down), `down must not touch ${table}`);
    }
  });
});
