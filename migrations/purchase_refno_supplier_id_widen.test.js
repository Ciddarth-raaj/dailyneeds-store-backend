/**
 *   node --test migrations/purchase_refno_supplier_id_widen.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "mysql", "migrations");
const NAME = "20261130120000-purchase-refno-supplier-id-widen";
const strip = (s) => s.replace(/^\s*--.*$/gm, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));

describe("widening purchase refno and supplier_id", () => {
  it("is unique and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.slice(0, 14))), [`${NAME}.js`]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("widens both columns to 50 on purchase and gst_tally_purchase, keeping nullability", () => {
    for (const table of ["purchase", "gst_tally_purchase"]) {
      assert.match(up, new RegExp(`ALTER TABLE \`${table}\``));
    }
    assert.equal((up.match(/MODIFY `mmh_mrc_refno` VARCHAR\(50\)/g) || []).length, 2);
    assert.equal((up.match(/MODIFY `supplier_id` VARCHAR\(50\) NULL/g) || []).length, 2);
    assert.match(up, /`gst_tally_purchase`\s+MODIFY `mmh_mrc_refno` VARCHAR\(50\) NOT NULL/);
  });

  it("changes nothing else, and down restores 20", () => {
    assert.doesNotMatch(up, /DROP|RENAME|UPDATE |DELETE|INSERT|CREATE/i);
    assert.equal((down.match(/VARCHAR\(20\)/g) || []).length, 4);
  });
});
