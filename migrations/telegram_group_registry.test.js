/**
 * The Telegram Group Registry migration: one new table, two new permission
 * keys, and nothing else touched.
 *
 *   node --test migrations/telegram_group_registry.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `hr_onboarding_dashboard_permission.test.js` and `work_shift_permissions.test.js`
 * prove theirs.
 *
 * THE TWO PROPERTIES THAT MATTER MOST:
 *
 *   the UNIQUE INDEX on chat_id, because the application check is only a good
 *   error message - two requests can pass it at the same instant and this is
 *   what actually decides
 *
 *   that the keys are granted to NOBODY and are not derived from any other
 *   key's holders, so no designation silently gains a new screen on deploy
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { PERMISSIONS, ORIGINAL_TELEGRAM_GROUP_CATEGORIES } = require("../constants/telegram_group_registry");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261014120000-telegram-group-registry";
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
const createTable = upStatements.find((s) => /^CREATE TABLE/.test(s));

describe("the migration runner file", () => {
  it("exists and reads its own two SQL files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`${NAME}-up\\.sql`));
    assert.match(js, new RegExp(`${NAME}-down\\.sql`));
  });

  it("has a unique identifier and sorts after the migrations it follows", () => {
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, 14))
      .filter((id) => /^\d{14}$/.test(id));
    const mine = NAME.slice(0, 14);
    assert.equal(all.filter((id) => id === mine).length, 1, "the identifier is unique");
    // NOT "it is the newest": that was true the day it was written and false
    // the moment another migration was added - the same correction
    // hr_onboarding_dashboard_permission.test.js already records making.
    // What matters is that it sorts after what it depends on.
    for (const dependency of ["20261013120000"]) {
      assert.ok(dependency < mine, `${mine} must sort after ${dependency}`);
    }
  });
});

describe("the table", () => {
  it("is created, and IF NOT EXISTS so a re-run is harmless", () => {
    assert.ok(createTable, "there is a CREATE TABLE");
    assert.match(createTable, /CREATE TABLE IF NOT EXISTS `telegram_group_registry`/);
  });

  it("carries exactly the columns the feature needs, and no others", () => {
    const columns = [
      "telegram_group_id",
      "group_name",
      "chat_id",
      "category",
      "used_for",
      "outlet_id",
      "bot_is_admin",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
    ];
    for (const column of columns) {
      assert.match(createTable, new RegExp("`" + column + "`"), `${column} is declared`);
    }
    // Every backticked identifier inside the column list that is not a key
    // name, an index name or the table itself must be one of the above.
    const declared = [...createTable.matchAll(/`(\w+)`\s+(?:INT|VARCHAR|ENUM|TINYINT|TIMESTAMP)/g)].map((m) => m[1]);
    assert.deepEqual(declared.sort(), [...columns].sort(), "no unnecessary column was added");
  });

  it("DOES NOT STORE THE GROUP TYPE - it is derived from the Chat ID", () => {
    // A stored copy could only ever drift out of agreement with the id
    // sitting beside it; there is one source of truth and it is chat_id.
    assert.ok(!/group_type/.test(upBody), "no group_type column anywhere");
  });

  it("enforces the Chat ID's uniqueness IN THE DATABASE", () => {
    assert.match(createTable, /UNIQUE KEY `uq_tgr_chat_id` \(`chat_id`\)/);
  });

  it("stores the Chat ID as text, so -100… survives exactly as Telegram gives it", () => {
    assert.match(createTable, /`chat_id` VARCHAR\(\d+\) NOT NULL/);
  });

  it("makes Group Name, Chat ID, Category, Used For and Bot Is Admin mandatory", () => {
    for (const column of ["group_name", "chat_id", "category", "used_for", "bot_is_admin"]) {
      // `[^`]*` rather than `[^,]*`: the category ENUM's values are
      // comma-separated, so a comma-free window never reaches its NOT NULL.
      assert.match(createTable, new RegExp("`" + column + "`[^`]*NOT NULL"), `${column} is NOT NULL`);
    }
  });

  it("makes the OUTLET NULLABLE and a foreign key to outlets - never a copy of it", () => {
    assert.match(createTable, /`outlet_id` INT NULL/);
    assert.match(
      createTable,
      /CONSTRAINT `fk_tgr_outlet` FOREIGN KEY \(`outlet_id`\) REFERENCES `outlets` \(`outlet_id`\)/
    );
    assert.ok(!/outlet_name|outlet_code/.test(upBody), "no outlet data is duplicated into this table");
  });

  it("constrains the category to the four values THIS migration shipped with", () => {
    // A migration is a historical fact: this one created the original four.
    // 'Marketing' was appended later by 20261015120000, so this assertion
    // pins the original list rather than today's constant - otherwise every
    // future category would retroactively "fail" a migration that ran long
    // before it existed.
    const enumMatch = /`category` ENUM\(([^)]*)\)/.exec(createTable);
    assert.ok(enumMatch, "category is an ENUM");
    const values = enumMatch[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(values, ORIGINAL_TELEGRAM_GROUP_CATEGORIES);
  });

  it("indexes what the list screen filters on", () => {
    assert.match(createTable, /KEY `idx_tgr_category` \(`category`\)/);
    assert.match(createTable, /KEY `idx_tgr_outlet` \(`outlet_id`\)/);
  });
});

describe("the permissions", () => {
  const declarations = upStatements.filter((s) => /^INSERT INTO `all_permissions`/.test(s));

  it("declares exactly the two keys, each guarded so a re-run adds nothing", () => {
    assert.equal(declarations.length, 2);
    for (const key of [PERMISSIONS.VIEW_TELEGRAM_GROUPS, PERMISSIONS.MANAGE_TELEGRAM_GROUPS]) {
      const stmt = declarations.find((s) => s.includes(`'${key}'`));
      assert.ok(stmt, `${key} is declared`);
      assert.match(stmt, new RegExp(`SELECT '${key}' FROM DUAL`));
      assert.match(
        stmt,
        new RegExp(
          `WHERE NOT EXISTS \\(SELECT 1 FROM \`all_permissions\` WHERE \`permission_key\` = '${key}'\\)`
        )
      );
    }
  });

  it("GRANTS THEM TO NOBODY - no designation gains a screen on deploy", () => {
    assert.ok(
      !upStatements.some((s) => /^INSERT INTO `permissions`/.test(s)),
      "nothing is written to the grants table"
    );
    assert.ok(!/designation/i.test(upBody), "no designation is named or selected from");
  });

  it("derives nothing from any other key's holders", () => {
    const keysNamed = new Set(upBody.match(/'[a-z_]{6,}'/g) || []);
    assert.deepEqual(
      [...keysNamed].sort(),
      [`'${PERMISSIONS.MANAGE_TELEGRAM_GROUPS}'`, `'${PERMISSIONS.VIEW_TELEGRAM_GROUPS}'`].sort(),
      "exactly the two new keys are named, and no existing key is read"
    );
  });
});

describe("what it must NOT do", () => {
  it("is additive - no existing table, column, row or grant is changed", () => {
    for (const stmt of upStatements) {
      assert.match(stmt, /^(CREATE TABLE|INSERT INTO)/, `unexpected statement: ${stmt}`);
    }
    // `ON UPDATE CURRENT_TIMESTAMP` is a column default on the NEW table, not
    // a write to anything that already exists, so it is removed before the
    // destructive-keyword sweep rather than excusing the keyword everywhere.
    const sweep = upBody.replace(/ON UPDATE CURRENT_TIMESTAMP/g, "");
    for (const forbidden of ["DELETE", "UPDATE", "DROP", "ALTER", "TRUNCATE", "REPLACE"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sweep), `${forbidden} must not appear`);
    }
  });

  it("leaves the existing Telegram tables and destinations alone", () => {
    // Scope control: this release records which groups exist. It does not
    // repoint any alert, and telegram_departments is a different feature.
    assert.ok(!/telegram_departments/.test(upBody));
    assert.ok(!/new_employee|biomax_punch|attendance/.test(upBody));
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("removes both keys and the table, and nothing else", () => {
    assert.equal(stmts.length, 3);
    assert.ok(stmts.some((s) => /^DROP TABLE IF EXISTS `telegram_group_registry`$/.test(s)));
    const deletes = stmts.filter((s) => /^DELETE FROM/.test(s));
    assert.equal(deletes.length, 2);
    for (const stmt of deletes) {
      assert.ok(stmt.includes(PERMISSIONS.VIEW_TELEGRAM_GROUPS));
      assert.ok(stmt.includes(PERMISSIONS.MANAGE_TELEGRAM_GROUPS));
    }
  });

  it("touches no other table", () => {
    const down = stripComments(read(`${NAME}-down.sql`));
    assert.ok(!/outlets|new_employee|telegram_departments/.test(down));
  });
});
