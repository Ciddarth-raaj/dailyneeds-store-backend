const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  SP_TOLERANCE,
  MARKDOWN_PP_TOLERANCE,
  FLOAT_EPS,
  resolveBasisType,
  preferFilled,
  exceeds,
  withinTolerance,
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

  it("uses epsilon-aware threshold helpers", () => {
    assert.equal(exceeds(0.1, SP_TOLERANCE), false);
    assert.equal(exceeds(0.100002, SP_TOLERANCE), true);
    assert.equal(withinTolerance(0.1, SP_TOLERANCE), true);
    assert.equal(
      exceeds(0.20000000000000018, MARKDOWN_PP_TOLERANCE),
      false
    );
    assert.equal(exceeds(0.200002, MARKDOWN_PP_TOLERANCE), true);
    assert.ok(FLOAT_EPS > 0);
  });

  it("does not flag same-basis SP gap of 0.10 (item 725 style)", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "255",
        Old_Selling_Price: "225.70",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "240",
        Old_Selling_Price: "225.80",
      }),
      row({
        Batch_No: "B3",
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
    assert.ok(!exceeds(samePp.spGap, SP_TOLERANCE));
  });

  it("flags same Purchase_Price with SP gap > 0.10", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "Purchase price",
        Purchase_Price: "24",
        Old_MRP: "50",
        Old_Selling_Price: "38",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "Purchase price",
        Purchase_Price: "24",
        Old_MRP: "50",
        Old_Selling_Price: "35",
      }),
    ]);

    assert.equal(result.hasConflict, true);
    assert.equal(result.rule1Conflict, true);
    assert.equal(result.conflictExportClass, "conflict");
    assert.ok(result.conflictReasons.includes("rule1"));
  });

  it("does not flag different MRP basis values alone", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "86",
        Purchase_Price: "75.6",
      }),
      row({
        Batch_No: "B2",
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
        Batch_No: "B1",
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "80.8",
      }),
      row({
        Batch_No: "B2",
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
        Batch_No: "B1",
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        New_MRP: "100",
        Old_Selling_Price: "80",
        New_Selling_Price: "95",
      }),
      row({
        Batch_No: "B2",
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

  it("flags Rule 2 markdown outlier on MRP-basis items", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "MRP",
        Old_MRP: "100",
        Old_Selling_Price: "85",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "MRP",
        Old_MRP: "90",
        Old_Selling_Price: "80",
      }),
    ]);

    assert.equal(result.rule1Conflict, false);
    assert.equal(result.rule2Conflict, true);
    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictExportClass, "conflict");
    assert.ok(result.conflictReasons.includes("rule2"));
  });

  it("skips Rule 2 for Landing/Purchase basis items", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "100",
        Old_MRP: "150",
        Old_Selling_Price: "130",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "80",
        Old_MRP: "120",
        Old_Selling_Price: "100",
      }),
    ]);

    assert.equal(result.rule2Conflict, false);
  });

  it("applies stable SP override after Rule 2 signal", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "MRP",
        Old_MRP: "100",
        Old_Selling_Price: "90.00",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "MRP",
        Old_MRP: "95",
        Old_Selling_Price: "90.05",
      }),
    ]);

    assert.equal(result.rule2Conflict, true);
    assert.equal(result.overriddenByStableSp, true);
    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, null);
  });

  it("marks purchase-basis PP gap as markup_verify when not conflict", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "215",
        Old_MRP: "255",
        Old_Selling_Price: "225.7",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "194.78",
        Old_MRP: "215",
        Old_Selling_Price: "204.5",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, "markup_verify");
  });

  it("does not mark multi-MRP-only purchase item as markup_verify", () => {
    const result = analyzeProductItems([
      row({
        Batch_No: "B1",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "37",
        Old_Selling_Price: "31.2",
      }),
      row({
        Batch_No: "B2",
        mpfd_price_parameter: "Landing cost",
        Purchase_Price: "24.01",
        Old_MRP: "35",
        Old_Selling_Price: "31.2",
      }),
    ]);

    assert.equal(result.hasConflict, false);
    assert.equal(result.conflictExportClass, null);
  });
});
