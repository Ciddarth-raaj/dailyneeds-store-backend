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

  it("hierarchy rows use RetailPilot's ids, with the parent's RetailPilot id", () => {
    assert.deepEqual(A.hierarchyRows("category", nodes.category), [
      { id: 20, name: "Oils", parentId: 10 },
      { id: 21, name: "New Cat", parentId: 10 },
    ]);
    assert.deepEqual(A.hierarchyRows("department", nodes.department), [{ id: 10, name: "Grocery", parentId: null }]);
  });

  it("product rows point at RetailPilot's hierarchy ids", () => {
    const [p1, p2] = A.productRows(
      [{ article_id: 1, external_id: "33097", article_name: "gold  winner oil 1l", preparation_type: "trade_as_is" }, { article_id: 2, article_name: "x" }],
      new Map([[1, 33097], [2, 2]]),
      taxonomy
    );
    assert.deepEqual(
      [p1.product_id, p1.de_name, p1.department_id, p1.category_id, p1.brand_id, p1.subcategory_id, p1.de_manufacturer_name],
      [33097, "gold winner oil 1l", 10, 20, 30, null, "Kaleesuwari"]
    );
    assert.equal(p2.category_id, 21);
  });
});
