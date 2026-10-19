/**
 *   node --test utils/retailpilot_articles.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./retailpilot_articles");

const tax = (article_id, level_id, hierarchy_id, hierarchy_name) => ({ article_id, level_id, hierarchy_id, hierarchy_name });

describe("resolveProductIds", () => {
  it("keeps an existing code, else the old code, else RetailPilot's id", () => {
    const ids = A.resolveProductIds(
      [{ article_id: 100001, external_id: "33097" }, { article_id: 127784, external_id: null }, { article_id: 100002, external_id: "5" }],
      new Map([[100002, 900]])
    );
    assert.deepEqual([...ids], [[100001, 33097], [127784, 127784], [100002, 900]]);
  });
});

describe("hierarchy", () => {
  const rows = [
    tax(1, "department-cpg", 10, "Grocery"),
    tax(1, "category-cpg", 20, "Oils"),
    tax(1, "brand-cpg", 30, "Gold Winner"),
    tax(1, "manufacturer-cpg", 40, "Kaleesuwari"),
    tax(2, "department-cpg", 10, "Grocery"),
    tax(2, "category-cpg", 21, "New Cat"),
  ];
  const taxonomy = A.taxonomyByArticle(rows);
  const nodes = A.collectNodes(taxonomy);

  it("collects nodes with their majority parent", () => {
    assert.deepEqual(nodes.category.get(20), { name: "Oils", parentRpId: 10 });
    assert.deepEqual(nodes.brand.get(30), { name: "Gold Winner", parentRpId: 20 });
  });

  it("maps by name to our rows, else to a new id, and reuses a saved mapping", () => {
    const cat = A.mapLevel(nodes.category, [{ id: 7, name: " oils " }, { id: 8, name: "Rice" }], new Map());
    assert.equal(cat.localIdOf.get(20), 7);
    assert.equal(cat.localIdOf.get(21), A.NEW_HIERARCHY_ID_OFFSET + 21);
    const again = A.mapLevel(nodes.category, [{ id: 7, name: "Edible Oils" }], new Map([[20, 7], [21, 1000021]]));
    assert.equal(again.newMappings.length, 0);
    assert.equal(again.localIdOf.get(20), 7);
  });

  it("builds product rows from the mapped ids", () => {
    const localIds = {
      department: new Map([[10, 3]]),
      category: new Map([[20, 7], [21, 1000021]]),
      subcategory: new Map(),
      brand: new Map([[30, 99]]),
    };
    const [p1, p2] = A.productRows(
      [{ article_id: 1, external_id: "33097", article_name: "gold  winner oil 1l", preparation_type: "trade_as_is" }, { article_id: 2, article_name: "x" }],
      new Map([[1, 33097], [2, 2]]),
      taxonomy,
      localIds
    );
    assert.deepEqual(
      [p1.product_id, p1.de_name, p1.department_id, p1.category_id, p1.brand_id, p1.subcategory_id, p1.de_manufacturer_name],
      [33097, "gold winner oil 1l", 3, 7, 99, null, "Kaleesuwari"]
    );
    assert.equal(p2.category_id, 1000021);
  });
});
