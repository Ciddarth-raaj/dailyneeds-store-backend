/**
 * The employee Telegram identity migration: three new tables, and nothing
 * else in the schema touched.
 *
 *   node --test migrations/employee_telegram_identity.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `telegram_group_registry.test.js` proves its own.
 *
 * THE PROPERTIES THAT MATTER MOST:
 *
 *   THE THREE ACTIVE-UNIQUENESS KEYS. One active identity per employee, per
 *   Telegram account and per chat. The application checks them too, but an
 *   application check is only a good error message: two verifications can pass
 *   it at the same instant and only an index decides. The middle one is the
 *   security rule - it is what stops one Telegram account being moved quietly
 *   onto a second employee's record.
 *
 *   IT IS ADDITIVE. No ALTER, no DROP, no UPDATE, no INSERT. Nobody is
 *   employee-Telegram-linked today, so there is nothing to backfill and no
 *   existing row this migration could damage.
 *
 *   THE AUDIT TABLE HAS NOWHERE TO PUT A SECRET. No column a token, a mobile
 *   number or a message body could be written into - the schema is the
 *   guarantee rather than a convention somebody has to remember.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261016120000-employee-telegram-identity";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
/**
 * The DDL with every COMMENT '…' string removed as well.
 *
 * A column comment is prose, and prose legitimately contains the words this
 * file searches for - "claimed by one UPDATE", "MOBILE_MISMATCH". Asserting
 * over the raw text would either fail on a comment or force the comments to be
 * written around the test, which is the test dictating the documentation.
 * These assertions are about DDL, so they read DDL.
 */
const stripCommentStrings = (sql) => stripComments(sql).replace(/COMMENT '(?:[^']|'')*'/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const upSql = read(`${NAME}-up.sql`);
const downSql = read(`${NAME}-down.sql`);
const upStatements = statements(upSql);
const tableOf = (name) =>
  upStatements.find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS \`${name}\``).test(s));

const identity = tableOf("employee_telegram_identity");
const tokens = tableOf("employee_telegram_link_tokens");
const audit = tableOf("employee_telegram_audit");

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
    // It depends on `new_employee` existing, and on nothing newer.
    for (const dependency of ["20261015120000"]) {
      assert.ok(dependency < mine, `${mine} must sort after ${dependency}`);
    }
  });
});

describe("it is additive", () => {
  it("creates three tables and does nothing else", () => {
    assert.equal(upStatements.length, 3, "three statements, three CREATE TABLEs");
    for (const statement of upStatements) {
      assert.match(statement, /^CREATE TABLE IF NOT EXISTS/);
    }
  });

  it("ALTERS, DROPS, UPDATES and INSERTS nothing", () => {
    // Asserted over what each STATEMENT begins with. A blanket text search
    // would trip over `ON UPDATE CURRENT_TIMESTAMP`, which is a column
    // attribute on a table being created and rewrites nothing.
    for (const statement of statements(stripCommentStrings(upSql))) {
      assert.match(
        statement.toUpperCase(),
        /^CREATE TABLE/,
        `every statement must be a CREATE TABLE, not: ${statement.slice(0, 40)}`
      );
    }
    for (const forbidden of ["ALTER TABLE `", "DROP TABLE", "DROP COLUMN", "TRUNCATE", "INSERT INTO"]) {
      assert.ok(
        !stripCommentStrings(upSql).toUpperCase().includes(forbidden),
        `the up migration must not ${forbidden.trim()}`
      );
    }
  });

  it("IF NOT EXISTS everywhere, so a re-run is harmless", () => {
    assert.equal(upStatements.filter((s) => /IF NOT EXISTS/.test(s)).length, 3);
  });

  it("touches no employee column - new_employee is referenced, never modified", () => {
    const body = stripComments(upSql);
    assert.match(body, /REFERENCES `new_employee` \(`employee_id`\)/);
    assert.ok(!/ALTER TABLE `new_employee`/.test(body));
  });

  it("needs no backfill: nothing reads an existing row", () => {
    assert.ok(!/SELECT/i.test(stripComments(upSql)));
  });
});

describe("the identity table", () => {
  it("is keyed by the EMPLOYEE, and carries no user_id at all", () => {
    assert.match(identity, /`employee_id` INT NOT NULL/);
    assert.ok(
      !/`user_id`/.test(identity),
      "an identity that depended on a login could not exist for most employees"
    );
  });

  it("holds the Telegram user id and the private chat as BIGINT", () => {
    assert.match(identity, /`telegram_user_id` BIGINT NOT NULL/);
    assert.match(identity, /`private_chat_id` BIGINT NOT NULL/);
  });

  it("records what was verified and when, and allows a soft disconnect", () => {
    assert.match(identity, /`verified_mobile` VARCHAR\(15\) NOT NULL/);
    assert.match(identity, /`connected_at` DATETIME NOT NULL/);
    assert.match(identity, /`disconnected_at` DATETIME NULL/);
  });

  // THE THREE RULES, ENFORCED BY THE DATABASE.
  for (const [marker, column, key] of [
    ["active_employee_marker", "employee_id", "uq_eti_active_employee"],
    ["active_telegram_marker", "telegram_user_id", "uq_eti_active_telegram"],
    ["active_chat_marker", "private_chat_id", "uq_eti_active_chat"],
  ]) {
    it(`${key}: one active row per ${column}, via a generated marker`, () => {
      const generated = new RegExp(
        `\`${marker}\` (?:INT|BIGINT) GENERATED ALWAYS AS \\(CASE WHEN \`disconnected_at\` IS NULL THEN \`${column}\` ELSE NULL END\\) STORED`
      );
      assert.match(identity, generated, `${marker} holds its value only while active`);
      assert.match(identity, new RegExp(`UNIQUE KEY \`${key}\` \\(\`${marker}\`\\)`));
    });
  }

  it("HISTORY NEVER COLLIDES - a disconnected row's marker is NULL", () => {
    // MySQL permits many NULLs in a unique index, which is the whole reason
    // the markers are NULL rather than, say, 0 once a row is retired.
    assert.equal((identity.match(/ELSE NULL END\) STORED/g) || []).length, 3);
  });

  it("the markers are STORED, so they can be indexed on MySQL 5.7", () => {
    assert.ok(!/VIRTUAL/.test(identity));
    assert.equal((identity.match(/STORED/g) || []).length, 3);
  });
});

describe("the token table", () => {
  it("stores ONLY the hash - there is no column for the token itself", () => {
    assert.match(tokens, /`token_hash` CHAR\(64\) NOT NULL/);
    assert.match(tokens, /PRIMARY KEY \(`token_hash`\)/);
    assert.ok(!/`token` /.test(tokens), "the plaintext token is never stored");
  });

  it("binds to the EMPLOYEE; the issuer is recorded but carries no authority", () => {
    assert.match(tokens, /`employee_id` INT NOT NULL/);
    assert.match(tokens, /`issued_by_user_id` INT NULL/);
    assert.match(tokens, /REFERENCES `new_employee` \(`employee_id`\)/);
  });

  it("can be claimed once - consumed_at is what an UPDATE competes for", () => {
    assert.match(tokens, /`consumed_at` DATETIME NULL/);
    assert.match(tokens, /`expires_at` DATETIME NOT NULL/);
  });

  it("carries the PENDING VERIFICATION, so it survives a restart", () => {
    for (const column of [
      "pending_telegram_user_id",
      "pending_chat_id",
      "pending_username",
      "pending_expires_at",
      "pending_outcome",
    ]) {
      assert.ok(tokens.includes(`\`${column}\``), `${column} is on the token row`);
    }
  });

  it("is indexed by the Telegram user, which is how a contact finds its session", () => {
    assert.match(tokens, /KEY `idx_etlt_pending` \(`pending_telegram_user_id`, `pending_expires_at`\)/);
  });

  it("HOLDS NO MOBILE NUMBER - the pending row knows who, never what", () => {
    // Over the DDL, not the comments: `pending_outcome`'s comment names
    // MOBILE_MISMATCH, which is an outcome code and not a number.
    assert.ok(!/`[a-z_]*(mobile|phone|contact)[a-z_]*`/i.test(stripCommentStrings(tokens)));
  });
});

describe("the audit table", () => {
  it("records identifiers and a fixed code, and nothing else", () => {
    assert.match(audit, /`employee_id` INT NULL/);
    assert.match(audit, /`event` VARCHAR\(32\) NOT NULL/);
    assert.match(audit, /`telegram_user_id` BIGINT NULL/);
    assert.match(audit, /`actor_user_id` INT NULL/);
    assert.match(audit, /`detail` VARCHAR\(64\) NULL/);
  });

  it("HAS NOWHERE TO PUT A SECRET", () => {
    for (const forbidden of ["token", "mobile", "phone", "message", "text", "contact", "chat_id"]) {
      assert.ok(
        !new RegExp("`[a-z_]*" + forbidden + "[a-z_]*`", "i").test(audit),
        `the audit table must have no ${forbidden} column`
      );
    }
  });

  it("is queryable per employee and per event without a scan", () => {
    assert.match(audit, /KEY `idx_eta_employee` \(`employee_id`, `created_at`\)/);
    assert.match(audit, /KEY `idx_eta_event` \(`event`, `created_at`\)/);
  });
});

describe("the down migration", () => {
  it("drops exactly the three tables it created, and nothing else", () => {
    const down = statements(downSql);
    assert.deepEqual(down, [
      "DROP TABLE IF EXISTS `employee_telegram_audit`",
      "DROP TABLE IF EXISTS `employee_telegram_link_tokens`",
      "DROP TABLE IF EXISTS `employee_telegram_identity`",
    ]);
  });

  it("leaves every existing table alone", () => {
    // The down file's header explains that `new_employee` is left as it was;
    // what matters is that no STATEMENT names it.
    const body = stripCommentStrings(downSql);
    for (const table of ["new_employee", "telegram_links", "telegram_link_tokens", "telegram_group_registry"]) {
      assert.ok(!body.includes(`\`${table}\``), `${table} must not appear in a down statement`);
    }
  });
});
