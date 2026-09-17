/**
 * THE THREE PHASE 3C MIGRATIONS, read as text. Phase 3C.
 *
 *   node --test migrations/telegram_membership_schema.test.js
 *
 * These pin intent. They CANNOT pin what the server will accept - that took
 * the Phase 3B deploy down once, when a STORED generated column met a
 * cascading foreign key and every text test passed. The executable proof
 * runs the same migrations through db-migrate against a real MySQL 8.4;
 * this is the layer that says what the schema is FOR.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  JOB_STATUS,
  JOB_SCOPE,
  JOB_REASON,
  MEMBERSHIP_EVENT,
} = require("../constants/telegram_membership_claim");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const read = (file) => fs.readFileSync(path.join(dir, file), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const one = (sql) => strip(sql).replace(/\s+/g, " ");

const CLAIM = "20260917100000-telegram-membership-claim";
const JOB = "20260917110000-telegram-membership-job";
const EVENT = "20260917130000-telegram-membership-event";

const claimUp = one(read(`${CLAIM}-up.sql`));
const jobUp = one(read(`${JOB}-up.sql`));
const eventUp = one(read(`${EVENT}-up.sql`));

const enumValues = (sql, column) => {
  const match = new RegExp("`" + column + "` ENUM\\(([^)]*)\\)").exec(sql);
  assert.ok(match, `${column} must be an ENUM`);
  return match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
};

describe("the migration files", () => {
  for (const name of [CLAIM, JOB, EVENT]) {
    it(`${name} reads its own two files and owns its timestamp`, () => {
      const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${name}.js`), "utf8");
      assert.match(js, new RegExp(`${name}-up\\.sql`));
      assert.match(js, new RegExp(`${name}-down\\.sql`));
      const stamp = name.split("-")[0];
      const all = fs
        .readdirSync(path.join(__dirname, "mysql/migrations"))
        .filter((f) => f.endsWith(".js") && f.startsWith(stamp));
      assert.deepEqual(all, [`${name}.js`]);
    });
  }

  it("all three are additive - they create tables and alter nothing", () => {
    for (const sql of [claimUp, jobUp, eventUp]) {
      // `ON UPDATE CURRENT_TIMESTAMP` is a column default, not a statement,
      // so the check is for statements that would touch existing data.
      assert.ok(!/ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE `/i.test(sql));
      assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
    }
  });

  it("each down drops only its own table", () => {
    for (const [name, table] of [
      [CLAIM, "employee_telegram_group_membership"],
      [JOB, "telegram_membership_job"],
      [EVENT, "employee_telegram_group_membership_event"],
    ]) {
      const down = one(read(`${name}-down.sql`));
      assert.match(down, new RegExp(`DROP TABLE IF EXISTS \`${table}\``));
      assert.equal((down.match(/DROP TABLE/g) || []).length, 1);
    }
  });
});

describe("the claim table", () => {
  it("SOURCE IS PART OF THE KEY, so RULE and MANUAL are separate claims", () => {
    assert.match(claimUp, /UNIQUE KEY `uq_etgm_claim` \(`employee_id`,`telegram_group_id`,`source`\)/);
    assert.deepEqual(enumValues(claimUp, "source").sort(), Object.values(CLAIM_SOURCE).sort());
  });

  it("carries the three states, and REMOVAL_PENDING is one of them", () => {
    assert.deepEqual(enumValues(claimUp, "state").sort(), Object.values(CLAIM_STATE).sort());
  });

  it("cascades from the registry, so settled history cannot orphan", () => {
    assert.match(
      claimUp,
      /CONSTRAINT `fk_etgm_group` FOREIGN KEY \(`telegram_group_id`\) REFERENCES `telegram_group_registry`/
    );
    assert.match(claimUp, /ON DELETE CASCADE/);
  });

  it("stores no Telegram identifier of any kind", () => {
    assert.ok(!/telegram_user_id|chat_id|invite_link_hash|mobile/.test(claimUp));
  });
});

describe("the queue table", () => {
  it("four statuses, and retry is PENDING again rather than a fifth", () => {
    assert.deepEqual(enumValues(jobUp, "status").sort(), Object.values(JOB_STATUS).sort());
  });

  it("carries the durable dirty flag and the retry bookkeeping", () => {
    assert.match(jobUp, /`rerun_requested` TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.match(jobUp, /`failure_count` INT NOT NULL DEFAULT 0/);
    assert.match(jobUp, /`next_attempt_at` DATETIME NOT NULL/);
    assert.match(jobUp, /`last_error_code`/);
  });

  it("ONE LIVE JOB PER SCOPE, marked VIRTUAL and never STORED", () => {
    // VIRTUAL is the Phase 3B lesson: a STORED generated column forbids
    // ON DELETE CASCADE on any column it reads, and that took a deploy down.
    assert.match(jobUp, /`live_job_marker` VARCHAR\(40\) AS/);
    assert.match(jobUp, /ELSE NULL END\) VIRTUAL/);
    assert.ok(!/ELSE NULL END\) STORED/.test(jobUp));
    assert.match(jobUp, /UNIQUE KEY `uq_tmj_live` \(`live_job_marker`\)/);
    assert.match(jobUp, /WHEN `status` IN \('PENDING','RUNNING'\)/);
  });

  it("its vocabularies match the constants exactly", () => {
    assert.deepEqual(enumValues(jobUp, "scope_type").sort(), Object.values(JOB_SCOPE).sort());
    assert.deepEqual(enumValues(jobUp, "reason").sort(), Object.values(JOB_REASON).sort());
  });
});

describe("the event table", () => {
  it("is typed throughout - no JSON, no free text", () => {
    assert.ok(!/JSON|TEXT/.test(eventUp));
    assert.match(eventUp, /`detail_code` VARCHAR\(48\)/);
    assert.deepEqual(enumValues(eventUp, "event_type").sort(), Object.values(MEMBERSHIP_EVENT).sort());
  });

  it("names OUR identity row, never a Telegram user id", () => {
    assert.match(eventUp, /`employee_telegram_id` INT NULL/);
    assert.ok(!/telegram_user_id|chat_id|mobile/.test(eventUp));
  });
});
