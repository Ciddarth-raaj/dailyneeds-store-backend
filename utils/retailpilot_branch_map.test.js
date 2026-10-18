/**
 * RetailPilot store ID -> outlet, from Branch Master only.
 *
 *   node --test utils/retailpilot_branch_map.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  RetailPilotBranchMappingError,
  RETAILPILOT_BRANCH_MAP_ERRORS: E,
  buildRetailPilotBranchMap,
  resolveOutletForStore,
  toStoreIdObject,
} = require("./retailpilot_branch_map");

const BRANCH_MASTER = [
  { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "9rJMC" },
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "huABy" },
  { outlet_id: 4, outlet_name: "Vallalar Salai", retailpilot_id: "FuUGY" },
  { outlet_id: 5, outlet_name: "Moolakulam", retailpilot_id: "sooWy" },
  { outlet_id: 6, outlet_name: "Muthialpet", retailpilot_id: "rnMT1" },
  { outlet_id: 7, outlet_name: "ECR", retailpilot_id: "kKFom" },
  { outlet_id: 8, outlet_name: "No RetailPilot store", retailpilot_id: null },
  { outlet_id: 9, outlet_name: "Blank", retailpilot_id: "  " },
];

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => err instanceof RetailPilotBranchMappingError && err.code === code);

describe("building the map from Branch Master", () => {
  it("maps each of the six branches, and leaves out rows without an ID", () => {
    assert.deepEqual(toStoreIdObject(buildRetailPilotBranchMap(BRANCH_MASTER)), {
      "9rJMC": 2, huABy: 3, FuUGY: 4, sooWy: 5, rnMT1: 6, kKFom: 7,
    });
  });

  it("refuses an ID set on two different branches instead of picking one", () => {
    throwsCode(
      () => buildRetailPilotBranchMap([...BRANCH_MASTER, { outlet_id: 10, outlet_name: "Copy", retailpilot_id: "9rJMC" }]),
      E.DUPLICATE_ID
    );
  });

  it("has no store IDs of its own - an empty Branch Master gives an empty map", () => {
    assert.equal(buildRetailPilotBranchMap([]).size, 0);
    const src = fs.readFileSync(path.join(__dirname, "retailpilot_branch_map.js"), "utf8");
    for (const slug of ["9rJMC", "huABy", "FuUGY", "sooWy", "rnMT1", "kKFom"]) {
      assert.ok(!src.includes(slug), `${slug} must come from Branch Master, not the code`);
    }
  });
});

describe("resolving one RetailPilot store", () => {
  const map = buildRetailPilotBranchMap(BRANCH_MASTER);

  it("gives the branch for a mapped ID, trimming spaces", () => {
    assert.deepEqual(resolveOutletForStore(map, "9rJMC"), { outlet_id: 2, outlet_name: "Warehouse" });
    assert.deepEqual(resolveOutletForStore(map, " kKFom "), { outlet_id: 7, outlet_name: "ECR" });
  });

  it("an unknown ID is a clear error naming the ID, never another outlet", () => {
    assert.throws(
      () => resolveOutletForStore(map, "zzNew"),
      (err) =>
        err.code === E.STORE_UNMAPPED &&
        /RetailPilot store zzNew is not set as the RetailPilot ID of any branch in Branch Master/.test(err.message) &&
        err.details.retailpilot_id === "zzNew"
    );
  });

  it("is case-sensitive, like RetailPilot's slugs", () => {
    throwsCode(() => resolveOutletForStore(map, "fuugy"), E.STORE_UNMAPPED);
  });

  it("a blank ID and an empty Branch Master are their own errors", () => {
    for (const blank of [null, undefined, "", "  "]) throwsCode(() => resolveOutletForStore(map, blank), E.STORE_ID_MISSING);
    throwsCode(() => resolveOutletForStore(new Map(), "9rJMC"), E.MAP_EMPTY);
  });
});
