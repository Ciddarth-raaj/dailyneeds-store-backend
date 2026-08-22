const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  SP_TOLERANCE,
  resolveBasisType,
  preferFilled,
  analyzeProductItems,
} = require("../utils/priceCheckerConflicts");

function row(overrides = {}) {
  return {
    Outlet_ID: "3",
    Batch_No: "B1",
    Purchase_Price: "",
    Landing_Cost: "0",
    Old_MRP: "",
    New_MRP: "",
    Old_Selling_Price: "",
    New_Selling_Price: "",
    mpfd_price_parameter: "MRP",
    ...overrides,
  };
}

describe("priceCheckerConflicts", () => {
  it("resolves basis type with MRP fallback for blank/unknown", () => {
    assert.equal(resolveBasisType("MRP"), "MRP");
    assert.equal(resolveBasisType("Landing cost"), "Purchase");
    assert.equal(resolveBasisType("Purchase price"), "Purchase");
    assert.equal(resolveBasisType(""), "MRP");
    assert.equal(resolveBasisType("None"), "MRP");
    assert.equal(resolveBasisType("Markup Selling"), "MRP");
  });

  it("prefers New_* when filled", () => {
    assert.equal(preferFilled("100", "90"), 100);
    assert.equal(preferFilled("", "90"), 90);
    assert.equal(preferFilled(null, "90"), 90);
  });

  it("does not flag same-basis SP gap of 0.10 (item 725 style)", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "255",
        Old_Selling_Price: "225.70",
      }),
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "240",
        Old_Selling_Price: "225.80",
      }),
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "210",
        Old_MRP: "235",
        Old_Selling_Price: "220.50",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, "markup_verify");
    const samePp = result.groups.find(
      (g) => g.basisType === "Purchase" && g.basisValue === 215
    );
    assert.ok(samePp);
    assert.equal(samePp.hasConflict, false);
    assert.ok(samePp.spGap <= SP_TOLERANCE);
  });

  it("flags same Purchase_Price with SP gap > 0.10", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "Purchase price",
        Purchase_Price: "24",
        Old_MRP: "50",
        Old_Selling_Price: "38",
      }),
      row({
        mpfd_price_parameter: "Purchase price",
        Purchase_Price: "24",
        Old_MRP: "50",
        Old_Selling_Price: "35",
      }),
    ]);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictExportClass, "conflict");
  });

  it("does not flag different MRP basis values alone", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "86",
        Purchase_Price: "75.6",
      }),
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "85",
        Old_Selling_Price: "81",
        Purchase_Price: "71.4",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, null);
  });

  it("flags same MRP with SP gap > 0.10", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "80.8",
      }),
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "86",
      }),
    ]);

    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictExportClass, "conflict");
    assert.equal(result.groups[0].basisLabel, "MRP");
  });

  it("uses New_Selling_Price and New_MRP when filled", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        New_MRP: "100",
        Old_Selling_Price: "80",
        New_Selling_Price: "95",
      }),
      row({
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        New_MRP: "100",
        Old_Selling_Price: "80",
        New_Selling_Price: "90",
      }),
    ]);

    assert.equal(result.hasConflict, true);
    assert.equal(result.groups[0].basisValue, 100);
  });

  it("marks purchase-basis multi-MRP non-conflict as markup_verify", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "37",
        Old_Selling_Price: "31.2",
      }),
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "35",
        Old_Selling_Price: "31.2",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, "markup_verify");
  });

  it("marks purchase-basis with PP gap > 0.10 as markup_verify", () => {
    const result = analyzeProductItems([
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "255",
        Old_Selling_Price: "225.7",
      }),
      row({
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "194.78",
        Old_MRP: "215",
        Old_Selling_Price: "204.5",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, "markup_verify");
  });
});
