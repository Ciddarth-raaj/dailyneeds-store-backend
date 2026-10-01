/**
 * The Transporter Master and LR Follow-up migrations: additive, ordered,
 * reversible, granting nobody.
 *
 *   node --test migrations/lr_followup.test.js
 *
 * The tables' behaviour - constraints, triggers, races - is the MariaDB
 * suite's (`repository/lr_followup.mysql.test.js`), which runs these files.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql/migrations");
const read = (f) => fs.readFileSync(path.join(dir, "sqls", f), "utf8");
const body = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

const TRANSPORTER = "20261109110000-transporter-master";
const LRF = "20261109120000-lr-followup";

describe("identity and order", () => {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));

  it("each migration is unique and its wrapper runs its own files", () => {
    for (const name of [TRANSPORTER, LRF]) {
      assert.equal(all.filter((f) => f.slice(0, 14) === name.slice(0, 14)).length, 1, name);
      const js = fs.readFileSync(path.join(dir, `${name}.js`), "utf8");
      assert.match(js, new RegExp(`'${name}-up.sql'`));
      assert.match(js, new RegExp(`'${name}-down.sql'`));
    }
  });

  it("the transporter master runs first, and both after the Advance Request tables", () => {
    assert.ok(TRANSPORTER < LRF);
    assert.ok("20260903020000-lr-workflow-stage-4" < TRANSPORTER);
    assert.ok(all.every((f) => f <= LRF || f > LRF));
  });
});

describe("up", () => {
  const t = body(read(`${TRANSPORTER}-up.sql`));
  const l = body(read(`${LRF}-up.sql`));

  it("alters and writes no existing table", () => {
    for (const sql of [t, l]) {
      assert.doesNotMatch(sql, /ALTER TABLE/i);
      assert.doesNotMatch(sql, /UPDATE (advance_requests|purchase)\b/i);
      assert.doesNotMatch(sql, /DROP TABLE/i);
    }
  });

  it("one follow-up per source, by unique key, and exactly one source per row", () => {
    assert.match(l, /UNIQUE KEY uq_lrf_advance_request \(advance_request_id\)/);
    assert.match(l, /UNIQUE KEY uq_lrf_credit_purchase \(credit_purchase_id\)/);
    assert.match(l, /CONSTRAINT chk_lrf_source CHECK/);
  });

  it("transporters are referenced by key, never stored as text", () => {
    assert.match(l, /transporter_id INT NOT NULL/);
    assert.match(l, /REFERENCES transporter_master\(transporter_id\)/);
    assert.doesNotMatch(l, /\btransporter (VARCHAR|TEXT)/i);
    assert.doesNotMatch(l, /transporter_name/);
  });

  it("duplicate bills are caught on the normalised key, not the generated id", () => {
    assert.match(l, /bill_reference_key VARCHAR\(100\) NOT NULL/);
    assert.match(l, /UNIQUE KEY uq_credpur_supplier_bill \(distributor_code, bill_reference_key\)/);
  });

  it("closure outcomes cannot be confused: receipt and non-receipt are checked by the database", () => {
    assert.match(l, /closure_reason ENUM\('GOODS_RECEIVED','REFUNDED','ADJUSTED','CANCELLED'\)/);
    assert.match(l, /CONSTRAINT chk_lrf_outcome CHECK/);
    assert.match(l, /closure_reason IN \('REFUNDED','ADJUSTED','CANCELLED'\) AND goods_received_at IS NULL AND goods_received_by IS NULL AND closure_remark IS NOT NULL/);
    assert.match(l, /'CLOSED_WITHOUT_RECEIPT'/);
  });

  it("history cannot be cascaded away", () => {
    assert.match(l, /CONSTRAINT fk_lrfa_followup FOREIGN KEY \(lr_followup_id\) REFERENCES lr_followup\(lr_followup_id\) \)/);
    assert.doesNotMatch(l, /ON DELETE CASCADE/i);
    assert.doesNotMatch(t, /ON DELETE CASCADE/i);
  });

  it("adds its permission keys idempotently and grants them to nobody", () => {
    const keys = [
      ...[...t.matchAll(/SELECT '([a-z_]+)' FROM DUAL/g)].map((m) => m[1]),
      ...[...l.matchAll(/SELECT '([a-z_]+)' FROM DUAL/g)].map((m) => m[1]),
    ];
    assert.deepEqual(keys.sort(), [
      "close_lr_followup_without_receipt",
      "create_credit_purchase",
      "create_transporter_master",
      "edit_transporter_master",
      "lr_followup_all_stores",
      "manage_lr_legacy_verification",
      "mark_lr_goods_received",
      "update_lr_followup",
      "view_credit_purchase",
      "view_lr_followup",
      "view_transporter_master",
    ]);
    for (const sql of [t, l]) assert.doesNotMatch(sql, /INSERT INTO `permissions`/);
  });
});

describe("down", () => {
  it("drops only what up created, children first", () => {
    const d = body(read(`${LRF}-down.sql`));
    assert.ok(d.indexOf("lr_followup_activity") < d.indexOf("DROP TABLE IF EXISTS lr_followup;"));
    assert.doesNotMatch(d, /advance_requests/);
    const td = body(read(`${TRANSPORTER}-down.sql`));
    assert.ok(td.indexOf("transporter_master_audit") < td.indexOf("DROP TABLE IF EXISTS transporter_master;"));
  });
});
