/**
 * Branch Master's RetailPilot ID: the store map read from it, and
 * the one-branch-per-ID rule.
 *
 *   node --test usecase/outlet_retailpilot_id.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const outletFactory = require("./outlet");

function fakeRepo(rows) {
  const calls = { created: [], updated: [] };
  return {
    calls,
    getRetailPilotIds: async () => rows.filter((r) => r.retailpilot_id != null && r.retailpilot_id !== ""),
    create: async (details) => {
      calls.created.push(details);
      return { code: 200, id: 99 };
    },
    updateOutletDetails: async (details, id) => {
      calls.updated.push({ details, id });
      return { code: 200 };
    },
  };
}

const BRANCHES = [
  { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "9rJMC" },
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "huABy" },
  { outlet_id: 4, outlet_name: "Vallalar Salai", retailpilot_id: "FuUGY" },
  { outlet_id: 8, outlet_name: "New Branch", retailpilot_id: null },
];

describe("the store map from Branch Master", () => {
  it("maps each RetailPilot ID to its outlet, and leaves out branches without one", async () => {
    const map = await outletFactory(fakeRepo(BRANCHES), {}).getRetailPilotStoreMap();
    assert.deepEqual(map, { "9rJMC": 2, huABy: 3, FuUGY: 4 });
  });
});

describe("the RetailPilot ID on save", () => {
  it("refuses an ID another branch already has, and saves nothing", async () => {
    const repo = fakeRepo(BRANCHES);
    const res = await outletFactory(repo, {}).updateOutletDetails({
      outlet_id: 3,
      outlet_details: { outlet_name: "Kathirkamam", retailpilot_id: " 9rJMC " },
    });
    assert.equal(res.code, 409);
    assert.match(res.msg, /9rJMC is already set on Warehouse \(outlet 2\)/);
    assert.equal(repo.calls.updated.length, 0);
  });

  it("lets a branch keep its own ID", async () => {
    const repo = fakeRepo(BRANCHES);
    const res = await outletFactory(repo, {}).updateOutletDetails({
      outlet_id: 2,
      outlet_details: { outlet_name: "Warehouse", retailpilot_id: "9rJMC" },
    });
    assert.equal(res.code, 200);
    assert.equal(repo.calls.updated[0].details.retailpilot_id, "9rJMC");
  });

  it("is case-sensitive, like RetailPilot's slugs", async () => {
    const repo = fakeRepo(BRANCHES);
    const res = await outletFactory(repo, {}).updateOutletDetails({
      outlet_id: 8,
      outlet_details: { outlet_name: "New Branch", retailpilot_id: "fuugy" },
    });
    assert.equal(res.code, 200);
  });

  it("stores a blank ID as NULL, so the unique column never sees ''", async () => {
    const repo = fakeRepo(BRANCHES);
    await outletFactory(repo, {}).updateOutletDetails({
      outlet_id: 8,
      outlet_details: { outlet_name: "New Branch", retailpilot_id: "   " },
    });
    assert.equal(repo.calls.updated[0].details.retailpilot_id, null);
  });

  it("checks a new branch too", async () => {
    const repo = fakeRepo(BRANCHES);
    const res = await outletFactory(repo, {}).create({
      outlet_details: { outlet_name: "Copy", retailpilot_id: "huABy" },
    });
    assert.equal(res.code, 409);
    assert.equal(repo.calls.created.length, 0);
  });

  it("leaves the GoFrugal ID and a save without a RetailPilot ID untouched", async () => {
    const repo = fakeRepo(BRANCHES);
    const details = { outlet_name: "Warehouse", gofrugal_id: "11" };
    const res = await outletFactory(repo, {}).updateOutletDetails({ outlet_id: 2, outlet_details: details });
    assert.equal(res.code, 200);
    assert.deepEqual(repo.calls.updated[0].details, { outlet_name: "Warehouse", gofrugal_id: "11" });
  });
});

describe("the route accepts RetailPilot IDs that look like slugs only", () => {
  const Joi = require("@hapi/joi");
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "outlet.js"), "utf8");
  const schema = Joi.string().trim().max(50).regex(/^[A-Za-z0-9_-]+$/).allow(null).allow("").optional();

  it("both the create and the update schemas carry it", () => {
    assert.equal((src.match(/retailpilot_id: Joi\.string\(\)\.trim\(\)\.max\(50\)\.regex\(\/\^\[A-Za-z0-9_-\]\+\$\/\)/g) || []).length, 2);
  });

  it("accepts a slug, blank or null, and rejects anything else", () => {
    for (const ok of ["9rJMC", "", null, " FuUGY "]) assert.equal(Joi.validate(ok, schema).error, null, String(ok));
    for (const bad of ["9rJ MC", "a;b", "x".repeat(51)]) assert.notEqual(Joi.validate(bad, schema).error, null, bad);
  });
});

describe("migration 20261203120000-outlet-retailpilot-id", () => {
  const dir = path.join(__dirname, "..", "migrations", "mysql", "migrations");
  const NAME = "20261203120000-outlet-retailpilot-id";
  const strip = (s) => s.replace(/^\s*--.*$/gm, "");
  const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
  const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));

  it("is unique, is the newest, and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.slice(0, 14))), [`${NAME}.js`]);
    assert.deepEqual(all.filter((f) => f > `${NAME}.js`), []);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });

  it("adds a nullable, unique retailpilot_id next to gofrugal_id", () => {
    assert.match(up, /ADD COLUMN `retailpilot_id` VARCHAR\(50\) NULL DEFAULT NULL AFTER `gofrugal_id`/);
    assert.match(up, /ADD UNIQUE KEY `uniq_outlets_retailpilot_id` \(`retailpilot_id`\)/);
  });

  it("fills the six branches by outlet_id, not by name, and touches nothing else", () => {
    const expected = { 2: "9rJMC", 3: "huABy", 4: "FuUGY", 5: "sooWy", 6: "rnMT1", 7: "kKFom" };
    for (const [id, slug] of Object.entries(expected)) {
      assert.match(up, new RegExp(`WHEN ${id} THEN '${slug}'`));
    }
    assert.match(up, /WHERE `outlet_id` IN \(2, 3, 4, 5, 6, 7\)/);
    assert.doesNotMatch(up, /outlet_name|gofrugal_id`\s*=|DROP|DELETE|INSERT/i);
  });

  it("down drops exactly what up added", () => {
    assert.match(down, /DROP INDEX `uniq_outlets_retailpilot_id`/);
    assert.match(down, /DROP COLUMN `retailpilot_id`/);
  });
});

describe("resolving a RetailPilot store through the outlet usecase", () => {
  const { RETAILPILOT_BRANCH_MAP_ERRORS: E } = require("../utils/retailpilot_branch_map");

  it("reads Branch Master on every call, so an edit applies at once", async () => {
    const rows = [{ outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "9rJMC" }];
    const usecase = outletFactory(fakeRepo(rows), {});
    assert.deepEqual(await usecase.resolveRetailPilotStore("9rJMC"), { outlet_id: 2, outlet_name: "Warehouse" });
    rows[0].retailpilot_id = "newId";
    await assert.rejects(usecase.resolveRetailPilotStore("9rJMC"), (err) => err.code === E.STORE_UNMAPPED);
    assert.equal((await usecase.resolveRetailPilotStore("newId")).outlet_id, 2);
  });

  it("an unmapped store is rejected with the store ID in the message", async () => {
    await assert.rejects(
      outletFactory(fakeRepo(BRANCHES), {}).resolveRetailPilotStore("kKFom"),
      /RetailPilot store kKFom is not set as the RetailPilot ID of any branch/
    );
  });
});
