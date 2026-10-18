/**
 *   node --test migrations/purchase_retailpilot_columns.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql", "migrations");
const NAME = "20261204120000-purchase-retailpilot-columns";
const strip = (s) => s.replace(/^\s*--.*$/gm, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));

describe("migration 20261204120000-purchase-retailpilot-columns", () => {
  it("is unique, is the newest, runs after the deployed outlet migration, and reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.slice(0, 14))), [`${NAME}.js`]);
    assert.deepEqual(all.filter((f) => f > `${NAME}.js`), []);
    assert.ok("20261203120000-outlet-retailpilot-id.js" < `${NAME}.js`);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("makes mmh_mrc_no text and widens refno and supplier_id to 50, on purchase and gst_tally_purchase", () => {
    for (const table of ["purchase", "gst_tally_purchase"]) {
      assert.match(up, new RegExp(`ALTER TABLE \`${table}\``));
    }
    assert.equal((up.match(/MODIFY `mmh_mrc_no` VARCHAR\(50\) NULL/g) || []).length, 2);
    assert.equal((up.match(/MODIFY `mmh_mrc_refno` VARCHAR\(50\)/g) || []).length, 2);
    assert.equal((up.match(/MODIFY `supplier_id` VARCHAR\(50\) NULL/g) || []).length, 2);
    assert.match(up, /`gst_tally_purchase`[^;]*MODIFY `mmh_mrc_refno` VARCHAR\(50\) NOT NULL/, "keeps NOT NULL");
  });

  it("changes nothing else, and down restores the old types", () => {
    assert.doesNotMatch(up, /DROP|RENAME|UPDATE |DELETE|INSERT|CREATE/i);
    assert.equal((down.match(/MODIFY `mmh_mrc_no` INT NULL/g) || []).length, 2);
    assert.equal((down.match(/VARCHAR\(20\)/g) || []).length, 4);
  });
});
