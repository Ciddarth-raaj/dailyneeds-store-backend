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

describe("the up migration adds the three dimensions", () => {
  it("adds one column per dimension, named as the code expects", () => {
    for (const dimension of RULE_DIMENSIONS) {
      const column = RULE_DIMENSION[dimension].column;
      assert.match(squash(upBody), new RegExp(`ADD COLUMN \`${column}\` INT NOT NULL DEFAULT 0`), column);
    }
  });

  it("every dimension is NOT NULL with a 0 default, never nullable", () => {
    // The sentinel IS the duplicate guard. A NULL dimension would make the
    // UNIQUE key below useless, silently.
    assert.equal(ANY_TARGET_ID, 0);
    for (const dimension of RULE_DIMENSIONS) {
      const column = RULE_DIMENSION[dimension].column;
      assert.doesNotMatch(squash(upBody), new RegExp(`\`${column}\`[^,]*NULL DEFAULT NULL`), column);
    }
  });

  it("backfills every legacy row, with no WHERE to skip any of them", () => {
    const update = squash(upBody).match(/UPDATE `telegram_group_mapping`[^;]*/);
    assert.ok(update, "a backfill must exist");
    assert.doesNotMatch(update[0], /WHERE/, "no row may be left behind");
    for (const dimension of RULE_DIMENSIONS) {
      assert.match(update[0], new RegExp(`\`${RULE_DIMENSION[dimension].column}\` = IF\\(`), dimension);
    }
  });

  it("maps each legacy type onto its OWN dimension and no other", () => {
    const update = squash(upBody).match(/UPDATE `telegram_group_mapping`[^;]*/)[0];
    for (const [type, dimension] of [
      ["OUTLET", "OUTLET"],
      ["DEPARTMENT", "DEPARTMENT"],
      ["DESIGNATION", "DESIGNATION"],
    ]) {
      const column = RULE_DIMENSION[dimension].column;
      assert.match(
        update,
        new RegExp(`\`${column}\` = IF\\(\`mapping_type\` = '${type}', \`target_id\`, 0\\)`),
        `${type} -> ${column}`
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
    // The old UNIQUE key made (group, type, target) unique, and this is the
    // arithmetic that shows distinct pairs stay distinct.
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

  it("replaces the single-dimension UNIQUE key with one over all three", () => {
    assert.match(squash(upBody), /DROP INDEX `uq_tgm_group_type_target`/);
    const columns = RULE_DIMENSIONS.map((d) => `\`${RULE_DIMENSION[d].column}\``).join(", ");
    assert.match(
      squash(upBody),
      new RegExp(`ADD UNIQUE KEY \`uq_tgm_group_rule\` \\(\`telegram_group_id\`, ${columns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`)
    );
  });

  it("drops the old columns only AFTER the backfill has read them", () => {
    const body = squash(upBody);
    assert.ok(body.indexOf("UPDATE `telegram_group_mapping`") < body.indexOf("DROP COLUMN `mapping_type`"));
    assert.match(body, /DROP COLUMN `mapping_type`/);
    assert.match(body, /DROP COLUMN `target_id`/);
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

describe("the down migration is real, and reverses the up", () => {
  it("restores both dropped columns", () => {
    assert.match(squash(downBody), /ADD COLUMN `mapping_type` ENUM\(/);
    assert.match(squash(downBody), /ADD COLUMN `target_id` INT NOT NULL/);
  });

  it("restores the full legacy vocabulary, unchanged", () => {
    const enumList = squash(downBody).match(/ADD COLUMN `mapping_type` ENUM\(([^)]*)\)/)[1];
    const values = enumList.split(",").map((v) => v.trim().replace(/'/g, ""));
    assert.deepEqual(values.sort(), [...MAPPING_TYPES].sort());
  });

  it("deletes the rows it cannot represent, rather than widening them", () => {
    // Keeping one dimension of "Cashiers at Moolakulam" would silently make
    // it "every cashier in the company" - a rollback that ADDS people to
    // real Telegram groups. Deletion is the failure that manages nobody.
    const del = squash(downBody).match(/DELETE FROM `telegram_group_mapping`[^;]*/);
    assert.ok(del, "multi-level rows must be removed");
    assert.match(del[0], /> 1/, "only rows narrowing more than one dimension");
  });

  it("deletes BEFORE it rebuilds, so the collapse cannot run on them", () => {
    const body = squash(downBody);
    assert.ok(body.indexOf("DELETE FROM") < body.indexOf("ADD COLUMN `mapping_type`"));
  });

  it("collapses each single-dimension row back to its own type", () => {
    const update = squash(downBody).match(/UPDATE `telegram_group_mapping`[^;]*/)[0];
    for (const dimension of RULE_DIMENSIONS) {
      assert.match(update, new RegExp(`WHEN \`${RULE_DIMENSION[dimension].column}\` <> 0 THEN '${dimension}'`), dimension);
    }
    assert.match(update, /ELSE 'ALL_EMPLOYEES'/);
  });

  it("restores the old UNIQUE key and drops the new one", () => {
    assert.match(squash(downBody), /DROP INDEX `uq_tgm_group_rule`/);
    assert.match(squash(downBody), /ADD UNIQUE KEY `uq_tgm_group_type_target` \(`telegram_group_id`, `mapping_type`, `target_id`\)/);
  });

  it("drops all three dimension columns", () => {
    for (const dimension of RULE_DIMENSIONS) {
      assert.match(squash(downBody), new RegExp(`DROP COLUMN \`${RULE_DIMENSION[dimension].column}\``), dimension);
    }
  });

  it("drops the temporary defaults, so the restored columns match the original", () => {
    assert.match(squash(downBody), /ALTER COLUMN `mapping_type` DROP DEFAULT/);
    assert.match(squash(downBody), /ALTER COLUMN `target_id` DROP DEFAULT/);
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
