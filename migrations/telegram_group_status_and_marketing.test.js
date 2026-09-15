/**
 * The Status + Marketing migration: one new column, one appended ENUM value,
 * and nothing else touched.
 *
 *   node --test migrations/telegram_group_status_and_marketing.test.js
 *
 * THE PROPERTY THAT MATTERS MOST. This runs against a table that is ALREADY
 * LIVE and holds real rows, so it must not rewrite any of them:
 *
 *   is_active has a DEFAULT of 1, so existing groups stay active rather than
 *   vanishing from a list that filters on status
 *
 *   'Marketing' is APPENDED to the ENUM. Appending is metadata-only;
 *   reordering existing members renumbers them and rewrites every row's
 *   stored ordinal, which is a data migration wearing a display tweak's
 *   clothes.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  TELEGRAM_GROUP_CATEGORIES,
  ORIGINAL_TELEGRAM_GROUP_CATEGORIES,
} = require("../constants/telegram_group_registry");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261015120000-telegram-group-status-and-marketing";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const upSql = read(`${NAME}-up.sql`);
const upBody = stripComments(upSql);
const upStatements = statements(upSql);

describe("the runner file", () => {
  it("exists and reads its own two SQL files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`${NAME}-up\\.sql`));
    assert.match(js, new RegExp(`${NAME}-down\\.sql`));
  });

  it("has a unique identifier and sorts AFTER the migration that created the table", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, 14))
      .filter((id) => /^\d{14}$/.test(id));
    const mine = NAME.slice(0, 14);
    assert.equal(all.filter((id) => id === mine).length, 1, "the identifier is unique");
    assert.ok("20261014120000" < mine, "the table must exist before it is altered");
  });
});

describe("status", () => {
  const addColumn = upStatements.find((s) => /ADD COLUMN `is_active`/.test(s));

  it("adds is_active as a NOT NULL flag", () => {
    assert.ok(addColumn, "the column is added");
    assert.match(addColumn, /ALTER TABLE `telegram_group_registry`/);
    assert.match(addColumn, /`is_active` TINYINT\(1\) NOT NULL/);
  });

  it("DEFAULTS TO 1, so every group that already exists stays Active", () => {
    // Without the default, a NOT NULL column on a populated table either
    // fails or silently marks every existing group inactive - and a list
    // filtered on status would then show nothing anybody registered.
    assert.match(addColumn, /DEFAULT 1/);
  });

  it("is indexed, because the list filters on it", () => {
    assert.ok(upStatements.some((s) => /ADD INDEX `idx_tgr_is_active` \(`is_active`\)/.test(s)));
  });
});

describe("the Marketing category", () => {
  const modify = upStatements.find((s) => /MODIFY COLUMN `category`/.test(s));

  it("APPENDS Marketing and keeps the original four in their original order", () => {
    assert.ok(modify, "the ENUM is modified");
    const values = /ENUM\(([^)]*)\)/.exec(modify)[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(
      values.slice(0, ORIGINAL_TELEGRAM_GROUP_CATEGORIES.length),
      ORIGINAL_TELEGRAM_GROUP_CATEGORIES,
      "the existing members keep their ordinals - nothing is renumbered"
    );
    assert.deepEqual(values, [...ORIGINAL_TELEGRAM_GROUP_CATEGORIES, "Marketing"]);
  });

  it("stays NOT NULL - widening the list does not make the field optional", () => {
    assert.match(modify, /NOT NULL/);
  });

  it("matches the code's list as a SET, even though the order differs", () => {
    const values = /ENUM\(([^)]*)\)/.exec(modify)[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual([...values].sort(), [...TELEGRAM_GROUP_CATEGORIES].sort());
  });
});

describe("what it must NOT do", () => {
  it("touches only this table", () => {
    for (const stmt of upStatements) {
      assert.match(stmt, /^ALTER TABLE `telegram_group_registry`/, `unexpected: ${stmt}`);
    }
    for (const table of ["outlets", "new_employee", "all_permissions", "permissions", "telegram_departments"]) {
      assert.ok(!upBody.includes(table), `${table} must not be touched`);
    }
  });

  it("rewrites no row and drops nothing", () => {
    for (const forbidden of ["DELETE", "DROP", "TRUNCATE", "REPLACE", "UPDATE"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(upBody), `${forbidden} must not appear`);
    }
  });

  it("GRANTS NOTHING and changes no permission", () => {
    assert.ok(!/permission|designation|GRANT/i.test(upBody));
  });

  it("ADDS NO group_type COLUMN - the type stays derived from the Chat ID", () => {
    // The approved decision, unchanged by this migration: a stored type could
    // disagree with the id sitting beside it.
    assert.ok(!/group_type/.test(upBody));
  });
});

describe("down", () => {
  const downSql = read(`${NAME}-down.sql`);
  const stmts = statements(downSql);

  it("moves Marketing rows to Other BEFORE narrowing the ENUM", () => {
    // Narrowing an ENUM that still has rows using the removed value either
    // refuses or blanks them. The rollback decides where they go rather than
    // leaving it to MySQL.
    const updateAt = stmts.findIndex((s) => /^UPDATE/.test(s));
    const modifyAt = stmts.findIndex((s) => /MODIFY COLUMN `category`/.test(s));
    assert.ok(updateAt !== -1, "the rows are moved");
    assert.match(stmts[updateAt], /SET `category` = 'Other' WHERE `category` = 'Marketing'/);
    assert.ok(updateAt < modifyAt, "the move happens first");
  });

  it("restores the original four and drops the column and index", () => {
    const modify = stmts.find((s) => /MODIFY COLUMN `category`/.test(s));
    const values = /ENUM\(([^)]*)\)/.exec(modify)[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(values, ORIGINAL_TELEGRAM_GROUP_CATEGORIES);
    assert.ok(stmts.some((s) => /DROP COLUMN `is_active`/.test(s)));
    assert.ok(stmts.some((s) => /DROP INDEX `idx_tgr_is_active`/.test(s)));
  });

  it("touches no other table", () => {
    assert.ok(!/outlets|all_permissions|new_employee/.test(stripComments(downSql)));
  });
});
