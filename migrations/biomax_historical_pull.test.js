/**
 * The historical-pull migration: additive only, guarded, reversible.
 *
 *   node --test migrations/biomax_historical_pull.test.js
 *
 * Proven against the SQL text, like the other migration tests:
 *   - three new tables, IF NOT EXISTS, InnoDB utf8mb4
 *   - the pull has exactly the five statuses and a unique trans_id
 *   - the command table can hold ONLY GET_LOG_DATA (one-value ENUM) and no
 *     forbidden command name appears anywhere in the up file
 *   - result blocks are unique on (dev_id, trans_id, blk_no), keep the raw
 *     body, a hash, every header, and count duplicates/conflicts
 *   - the ONLY change to an existing table is two guarded ADD COLUMNs on
 *     biomax_punch, both defaulted/nullable; no DROP, MODIFY, DELETE, UPDATE
 *     or INSERT touches Part 1 data; the punch unique key is not touched
 *   - one permission key declared, granted to nobody
 *   - down removes exactly what up added and drops no Part 1 table
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");
const { FORBIDDEN_COMMANDS } = require("../biomax/commands");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260912120000-biomax-historical-pull";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) => stripComments(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

const NEW_TABLES = ["biomax_historical_pull", "biomax_device_command", "biomax_command_result_block"];
const PART1_TABLES = ["biomax_device", "biomax_device_assignment", "biomax_device_event", "biomax_punch", "biomax_punch_derived", "biomax_raw_request", "biomax_derivation_run", "biomax_derivation_change"];

describe("up", () => {
  const raw = read(`${NAME}-up.sql`);
  const code = stripComments(raw);
  const stmts = statements(raw);
  const creates = stmts.filter((s) => /^CREATE TABLE/.test(s));
  const tableOf = (name) => creates.find((s) => s.includes(`\`${name}\``));

  it("the migration file pair exists and is wired like the others", () => {
    assert.ok(fs.existsSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`)));
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-down.sql`)));
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("creates exactly the three new tables, IF NOT EXISTS, InnoDB utf8mb4", () => {
    assert.equal(creates.length, 3);
    for (const t of NEW_TABLES) {
      const s = tableOf(t);
      assert.ok(s, t);
      assert.match(s, /^CREATE TABLE IF NOT EXISTS/);
      assert.match(s, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/);
    }
  });

  it("the pull has the five statuses, every required column, and a unique trans_id", () => {
    const s = tableOf("biomax_historical_pull");
    assert.match(s, /`status` ENUM\('REQUESTED','WAITING_DEVICE','RECEIVING','COMPLETED','FAILED'\)/);
    for (const c of ["biomax_device_id", "dev_id", "requested_from", "requested_to", "status", "trans_id", "requested_by", "requested_at", "sent_at", "first_result_at", "completed_at", "failed_at", "failure_reason", "punches_returned", "new_punches", "duplicate_punches", "created_at", "updated_at"]) {
      assert.ok(s.includes(`\`${c}\``), c);
    }
    assert.match(s, /UNIQUE KEY `uq_bhp_trans_id` \(`trans_id`\)/);
    assert.match(s, /FOREIGN KEY \(`biomax_device_id`\) REFERENCES `biomax_device`/);
  });

  it("the command queue can hold only GET_LOG_DATA and is unique per trans_id", () => {
    const s = tableOf("biomax_device_command");
    assert.match(s, /`cmd_code` ENUM\('GET_LOG_DATA'\) NOT NULL/);
    assert.match(s, /`status` ENUM\('PENDING','SENT','FAILED'\)/);
    for (const c of ["trans_id", "dev_id", "cmd_code", "begin_time", "end_time", "status", "created_at", "sent_at"]) assert.ok(s.includes(`\`${c}\``), c);
    assert.match(s, /UNIQUE KEY `uq_bdc_trans_id` \(`trans_id`\)/);
  });

  it("no forbidden command name appears anywhere in the executable SQL", () => {
    for (const bad of FORBIDDEN_COMMANDS) assert.ok(!code.includes(bad), bad);
  });

  it("result blocks: unique per (dev_id, trans_id, blk_no), raw body, hash, headers, counters, match status", () => {
    const s = tableOf("biomax_command_result_block");
    assert.match(s, /UNIQUE KEY `uq_bcrb_dev_trans_blk` \(`dev_id`, `trans_id`, `blk_no`\)/);
    for (const c of ["dev_id", "trans_id", "cmd_id", "cmd_return_code", "blk_no", "blk_len", "headers_json", "body_len", "body_sha256", "raw_body", "received_at", "duplicate_count", "conflict_count"]) assert.ok(s.includes(`\`${c}\``), c);
    assert.match(s, /`raw_body` MEDIUMBLOB/);
    assert.match(s, /`match_status` ENUM\('MATCHED','UNKNOWN_TRANS_ID','WRONG_DEVICE'\)/);
    assert.match(s, /`biomax_historical_pull_id` BIGINT UNSIGNED NULL/);
  });

  it("the only change to an existing table is two guarded, additive columns on biomax_punch", () => {
    const alters = code.match(/ALTER TABLE `?(\w+)`?[^']*/g) || [];
    for (const a of alters) assert.match(a, /^ALTER TABLE `biomax_punch` ADD COLUMN/);
    assert.equal(alters.length, 2);
    assert.match(code, /ADD COLUMN `ingest_source` ENUM\(''LIVE'',''HISTORICAL_PULL''\) NOT NULL DEFAULT ''LIVE''/);
    assert.match(code, /ADD COLUMN `biomax_historical_pull_id` BIGINT UNSIGNED NULL/);
    // Guarded through information_schema + PREPARE, since MySQL has no ADD COLUMN IF NOT EXISTS.
    assert.equal((code.match(/information_schema\.COLUMNS/g) || []).length, 2);
    assert.equal((code.match(/PREPARE \w+ FROM/g) || []).length, 2);
    assert.ok(!/DROP COLUMN|MODIFY COLUMN|CHANGE COLUMN|DROP TABLE|DROP KEY|DROP INDEX/.test(code));
    assert.ok(!/uq_biomax_punch_retransmit/.test(code), "the punch dedup key is not touched");
  });

  it("writes nothing to any Part 1 or HR table", () => {
    const writes = stmts.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));
    assert.equal(writes.length, 1, "only the permission declaration");
    assert.match(writes[0], /^INSERT INTO `all_permissions`/);
    for (const t of PART1_TABLES.concat(["new_employee", "work_shift", "work_shift_weekly_schedule", "outlets", "designation", "permissions"])) {
      assert.ok(!writes.some((w) => new RegExp(`(INSERT INTO|UPDATE|DELETE FROM) \`?${t}\`? `).test(w)), t);
    }
  });

  it("declares manage_biomax_historical_pull, guarded, and grants it to nobody", () => {
    assert.equal(P.MANAGE_BIOMAX_HISTORICAL_PULL, "manage_biomax_historical_pull");
    const decl = stmts.find((s) => s.startsWith("INSERT INTO `all_permissions`"));
    assert.ok(decl.includes("'manage_biomax_historical_pull'"));
    assert.match(decl, /WHERE NOT EXISTS/);
    assert.ok(!stmts.some((s) => /^INSERT INTO `permissions`/.test(s)), "no grant");
  });

  it("calculates nothing: no attendance, hours, IN/OUT or payroll column", () => {
    assert.ok(!/\b(in_out|direction|hours|late|overtime|payroll|salary)\b/i.test(code));
  });
});

describe("down", () => {
  const up = stripComments(read(`${NAME}-up.sql`));
  const down = stripComments(read(`${NAME}-down.sql`));
  const stmts = statements(read(`${NAME}-down.sql`));

  it("drops exactly the three new tables, children first, and no Part 1 table", () => {
    const drops = stmts.filter((s) => /^DROP TABLE/.test(s)).map((s) => s.match(/`(\w+)`/)[1]);
    assert.deepEqual(drops, ["biomax_command_result_block", "biomax_device_command", "biomax_historical_pull"]);
    for (const t of PART1_TABLES) assert.ok(!down.includes(`DROP TABLE IF EXISTS \`${t}\``), t);
  });

  it("removes the two punch columns, guarded, and nothing else from biomax_punch", () => {
    assert.match(down, /DROP COLUMN `biomax_historical_pull_id`/);
    assert.match(down, /DROP COLUMN `ingest_source`/);
    assert.equal((down.match(/information_schema\.COLUMNS/g) || []).length, 2);
    assert.ok(!/DELETE FROM `biomax_punch`|TRUNCATE/.test(down));
  });

  it("removes exactly the key up declared", () => {
    assert.ok(up.includes("'manage_biomax_historical_pull'"));
    assert.ok(stmts.some((s) => /^DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_biomax_historical_pull'/.test(s)));
    assert.ok(stmts.some((s) => /^DELETE FROM `permissions` WHERE `permission_key` = 'manage_biomax_historical_pull'/.test(s)));
  });
});
