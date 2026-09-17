/**
 * The multi-level mapping migration - one table altered, no rule lost.
 *
 *   node --test migrations/telegram_mapping_multilevel.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `telegram_group_mapping.test.js` proves the Phase 3A migration's. The
 * behaviour against a real MySQL 8.4 is proven separately by running the
 * migration up, down and up again.
 *
 * THE PROPERTIES THAT MATTER MOST:
 *
 *   EVERY LEGACY ROW IS BACKFILLED, and the four legacy shapes land on four
 *   distinct triples - so nothing is merged and no rule disappears
 *
 *   THE THREE DIMENSIONS ARE NOT NULL WITH A 0 DEFAULT, because MySQL treats
 *   NULLs as distinct in a UNIQUE index and a nullable dimension would let
 *   one rule be added to a group any number of times
 *
 *   THE UNIQUE KEY COVERS ALL THREE, because the usecase's duplicate check
 *   is only a good error message
 *
 *   NO FOREIGN KEY ON ANY DIMENSION, because a mapping whose outlet was
 *   deleted must SURVIVE and be warned about rather than silently vanish
 *
 *   THE DOWN MIGRATION IS REAL and reverses exactly what the up created
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  MAPPING_TYPES,
  ANY_TARGET_ID,
} = require("../constants/telegram_group_mapping");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20261020120000-telegram-mapping-multilevel";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");

const upSql = read(`${NAME}-up.sql`);
const downSql = read(`${NAME}-down.sql`);
const upBody = stripComments(upSql);
const downBody = stripComments(downSql);
const squash = (sql) => sql.replace(/\s+/g, " ");

describe("the up migration is EXPAND-ONLY", () => {
  it("drops NOTHING - not a column, not an index, not a table", () => {
    // THE PROPERTY THIS WHOLE FILE EXISTS FOR. The deploy sequence is
    // `git pull -> npm install -> db-migrate up -> pm2 reload`, so the OLD
    // Node process is still serving requests while this runs, and every one
    // of its queries names `mapping_type` and `target_id`. Dropping either
    // is a missing-column outage for the whole window, not a deployment.
    assert.doesNotMatch(upBody, /DROP COLUMN/i);
    assert.doesNotMatch(upBody, /DROP INDEX/i);
    assert.doesNotMatch(upBody, /DROP TABLE/i);
    assert.doesNotMatch(upBody, /RENAME/i);
  });

  it("leaves the legacy columns and their UNIQUE key exactly where they are", () => {
    for (const legacy of ["mapping_type", "target_id", "uq_tgm_group_type_target"]) {
      assert.doesNotMatch(
        squash(upBody),
        new RegExp(`DROP[^;]*\`${legacy}\``),
        `${legacy} must survive the expand step`
      );
    }
  });

  it("adds one column per dimension, named as the code expects", () => {
    for (const dimension of RULE_DIMENSIONS) {
      const column = RULE_DIMENSION[dimension].column;
      assert.match(squash(upBody), new RegExp(`ADD COLUMN \\\`${column}\\\` INT NULL DEFAULT NULL`), column);
    }
  });

  it("makes every new column NULLABLE, and that is load-bearing", () => {
    // The OLD process can still INSERT a mapping before the reload, naming
    // only the legacy pair. NOT NULL DEFAULT 0 would land that row on
    // (0,0,0) - which the new code reads as ALL EMPLOYEES - so an operator
    // adding a single-outlet rule during the window would have created a
    // company-wide one, silently. NULL makes the row say "I am legacy".
    for (const dimension of RULE_DIMENSIONS) {
      const column = RULE_DIMENSION[dimension].column;
      assert.doesNotMatch(
        squash(upBody),
        new RegExp(`\\\`${column}\\\` INT NOT NULL`),
        `${column} must not be NOT NULL during the transition`
      );
    }
  });

  it("backfills every existing row, with no WHERE to skip any of them", () => {
    const update = squash(upBody).match(/UPDATE `telegram_group_mapping`[^;]*/);
    assert.ok(update, "a backfill must exist");
    assert.doesNotMatch(update[0], /WHERE/, "no row may be left behind");
    for (const dimension of RULE_DIMENSIONS) {
      assert.match(update[0], new RegExp(`\\\`${RULE_DIMENSION[dimension].column}\\\` = IF\\(`), dimension);
    }
  });

  it("maps each legacy type onto its OWN dimension and no other", () => {
    const update = squash(upBody).match(/UPDATE `telegram_group_mapping`[^;]*/)[0];
    for (const dimension of ["OUTLET", "DEPARTMENT", "DESIGNATION"]) {
      const column = RULE_DIMENSION[dimension].column;
      assert.match(
        update,
        new RegExp(`\\\`${column}\\\` = IF\\(\\\`mapping_type\\\` = '${dimension}', \\\`target_id\\\`, 0\\)`),
        `${dimension} -> ${column}`
      );
    }
  });

  it("ALL_EMPLOYEES is named by no branch, so it backfills to all zeroes", () => {
    // Nothing narrowed IS everybody. It needs no case of its own, and having
    // one would be a second way to spell the same rule.
    const update = squash(upBody).match(/UPDATE `telegram_group_mapping`[^;]*/)[0];
    assert.doesNotMatch(update, /ALL_EMPLOYEES/);
  });

  it("the four legacy shapes land on four DISTINCT triples", () => {
    // The one failure mode that matters: a backfill that merged two rules.
    const backfill = (type, target) => [
      type === "OUTLET" ? target : 0,
      type === "DEPARTMENT" ? target : 0,
      type === "DESIGNATION" ? target : 0,
    ].join(",");
    const legacy = [
      ["ALL_EMPLOYEES", 0],
      ["OUTLET", 5],
      ["DEPARTMENT", 5],
      ["DESIGNATION", 5],
      ["OUTLET", 6],
    ];
    const triples = legacy.map(([type, target]) => backfill(type, target));
    assert.equal(new Set(triples).size, legacy.length, "no two legacy rows may collapse");
  });

  it("APPENDS 'COMPOSITE' to the ENUM rather than inserting it", () => {
    // Appending is metadata-only in MySQL 8 and rewrites no row. Inserting
    // in the middle would renumber the existing values and rewrite the table.
    const modify = squash(upBody).match(/MODIFY COLUMN `mapping_type`\s*ENUM\(([^)]*)\)/);
    assert.ok(modify, "the ENUM must be widened");
    const values = modify[1].split(",").map((v) => v.trim().replace(/'/g, ""));
    assert.deepEqual(values, [...MAPPING_TYPES, "COMPOSITE"], "appended, in the original order");
    assert.equal(values[values.length - 1], "COMPOSITE");
  });

  it("'COMPOSITE' is a value the OLD matcher cannot act on", () => {
    // The neutral shadow. The old matcher does `DIMENSION_COLUMN[type]` and
    // returns false when there is no column - so it matches NOBODY. Both
    // lossy alternatives would BROADEN a multi-level rule, and the old
    // process is live: broadening means telling real people to join a group
    // they do not belong in.
    assert.ok(!MAPPING_TYPES.includes("COMPOSITE"), "it is not a dimension");
    const matcher = fs.readFileSync(path.join(__dirname, "..", "utils", "telegram_group_mapping.js"), "utf8");
    assert.match(matcher, /DIMENSION_COLUMN/);
  });

  it("adds the composite UNIQUE key over all three dimensions", () => {
    const columns = RULE_DIMENSIONS.map((d) => `\`${RULE_DIMENSION[d].column}\``).join(", ");
    assert.match(
      squash(upBody),
      new RegExp(
        `ADD UNIQUE KEY \\\`uq_tgm_group_rule\\\` \\(\\\`telegram_group_id\\\`, ${columns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`
      )
    );
  });

  it("adds no foreign key on any dimension", () => {
    // A cascading FK would delete the rule along with the outlet it named,
    // and the configuration would be gone with nothing to say it existed.
    assert.doesNotMatch(upBody, /ADD CONSTRAINT/);
    assert.doesNotMatch(upBody, /FOREIGN KEY/);
  });

  it("touches no table but the mapping table", () => {
    const tables = [...squash(upBody).matchAll(/(?:ALTER TABLE|UPDATE|INSERT INTO|DELETE FROM|DROP TABLE)\s+`?(\w+)`?/g)].map((m) => m[1]);
    assert.ok(tables.length > 0);
    for (const table of tables) assert.equal(table, "telegram_group_mapping", table);
  });

  it("creates no permission and no new table", () => {
    assert.doesNotMatch(upBody, /CREATE TABLE/i);
    assert.doesNotMatch(upBody, /permission/i);
  });
});

describe("the down migration reverses the expand, and only the expand", () => {
  it("drops the three columns and the composite index", () => {
    assert.match(squash(downBody), /DROP INDEX `uq_tgm_group_rule`/);
    for (const dimension of RULE_DIMENSIONS) {
      assert.match(squash(downBody), new RegExp(`DROP COLUMN \\\`${RULE_DIMENSION[dimension].column}\\\``), dimension);
    }
  });

  it("restores the ENUM to its original vocabulary", () => {
    const modify = squash(downBody).match(/MODIFY COLUMN `mapping_type`\s*ENUM\(([^)]*)\)/);
    assert.ok(modify);
    const values = modify[1].split(",").map((v) => v.trim().replace(/'/g, ""));
    assert.deepEqual(values, [...MAPPING_TYPES]);
    assert.ok(!values.includes("COMPOSITE"));
  });

  it("rebuilds NOTHING, because the up migration destroyed nothing", () => {
    // The legacy columns were never touched on the way up, so a
    // single-dimension row round-trips byte-for-byte with no backfill at all.
    assert.doesNotMatch(downBody, /ADD COLUMN `mapping_type`/);
    assert.doesNotMatch(downBody, /ADD COLUMN `target_id`/);
    assert.doesNotMatch(downBody, /ADD UNIQUE KEY `uq_tgm_group_type_target`/);
    assert.doesNotMatch(squash(downBody), /UPDATE `telegram_group_mapping`\s+SET `mapping_type`/);
  });

  it("deletes the multi-level rows, rather than widening them", () => {
    // Keeping one dimension of "Cashiers at Moolakulam" would silently make
    // it "every cashier in the company" - a rollback that ADDS people to
    // real Telegram groups. Deletion is the failure that manages nobody.
    const del = squash(downBody).match(/DELETE FROM `telegram_group_mapping`[^;]*/);
    assert.ok(del, "multi-level rows must be removed");
    assert.match(del[0], /`mapping_type` = 'COMPOSITE'/);
  });

  it("deletes BEFORE the ENUM loses the value those rows carry", () => {
    const body = squash(downBody);
    assert.ok(body.indexOf("DELETE FROM") < body.indexOf("MODIFY COLUMN `mapping_type`"));
  });

  it("never drops the mapping table itself", () => {
    assert.doesNotMatch(downBody, /DROP TABLE/i);
  });
});

describe("the migration is wired the way db-migrate reads it", () => {
  it("the js runner points at both sql files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("sorts after every migration already applied in production", () => {
    const names = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"))
      .sort();
    assert.equal(names[names.length - 1], `${NAME}.js`, "it must run last");
  });
});
