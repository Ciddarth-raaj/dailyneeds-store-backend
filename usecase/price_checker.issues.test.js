const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { enrichSellingPriceIssues } = require("./price_checker");

function productWithItems(items) {
  return {
    Item_Code: "1",
    items,
    allSellingPrices: [],
    incorrectSellingPrices: [],
    hasIssue: false,
  };
}

describe("enrichSellingPriceIssues hasIssue", () => {
  it("marks multi-MRP-only purchase verify items as hasIssue", () => {
    const product = productWithItems([
      {
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "37",
        Old_Selling_Price: "31.2",
        Expected_Selling: "31.2",
      },
      {
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "35",
        Old_Selling_Price: "31.2",
        Expected_Selling: "31.2",
      },
    ]);

    enrichSellingPriceIssues(product);

    assert.equal(product.hasConflict, false);
    assert.equal(product.conflictExportClass, "markup_verify");
    assert.equal(product.hasIssue, true);
  });

  it("marks SP near-tie purchase verify items as hasIssue", () => {
    const product = productWithItems([
      {
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "8.85",
        Old_MRP: "27",
        Old_Selling_Price: "12",
        Expected_Selling: "12",
      },
      {
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "8.85",
        Old_MRP: "27",
        Old_Selling_Price: "11.9",
        Expected_Selling: "12",
      },
    ]);

    enrichSellingPriceIssues(product);

    assert.equal(product.hasConflict, false);
    assert.equal(product.conflictExportClass, "markup_verify");
    assert.equal(product.hasIssue, true);
  });

  it("keeps frozen-SP PP-gap exclusion off the verify sheet", () => {
    const product = productWithItems([
      {
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "36.05",
        Old_MRP: "55",
        Old_Selling_Price: "39",
        Expected_Selling: "48.7",
      },
      {
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "30.05",
        Old_MRP: "55",
        Old_Selling_Price: "39",
        Expected_Selling: "40.6",
      },
    ]);

    enrichSellingPriceIssues(product);

    assert.equal(product.hasConflict, false);
    assert.equal(product.conflictExportClass, null);
    assert.equal(product.hasIssue, true);
  });
});
