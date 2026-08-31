const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseLatestGrnLine, SORT_KEY_LENGTH } = require("./grnLatestLine");

/** Build what MySQL's CONCAT(...) in LATEST_GRN_LINE_EXPR would produce. */
function encode({ date = "20260826", mrcNo = 1, mrp = "", netCost = "" } = {}) {
  return `${date}${String(mrcNo).padStart(12, "0")}|${mrp}|${netCost}`;
}

describe("parseLatestGrnLine", () => {
  it("pulls MRP and net cost out of an encoded line", () => {
    const parsed = parseLatestGrnLine(
      encode({ mrp: "125.00", netCost: "98.4500" })
    );
    assert.deepEqual(parsed, { mrp: "125.00", net_cost: "98.4500" });
  });

  it("keeps NULL columns as empty strings", () => {
    assert.deepEqual(parseLatestGrnLine(encode({ mrp: "", netCost: "12" })), {
      mrp: "",
      net_cost: "12",
    });
  });

  it("returns null for missing or truncated values", () => {
    assert.equal(parseLatestGrnLine(null), null);
    assert.equal(parseLatestGrnLine(undefined), null);
    assert.equal(parseLatestGrnLine(""), null);
    assert.equal(parseLatestGrnLine("2026082600000000000"), null);
  });

  it("returns null when the payload separators are missing", () => {
    assert.equal(
      parseLatestGrnLine(`${"0".repeat(SORT_KEY_LENGTH)}125.00`),
      null
    );
    assert.equal(
      parseLatestGrnLine(`${"0".repeat(SORT_KEY_LENGTH)}|125.00`),
      null
    );
  });
});

describe("encoded line ordering", () => {
  it("sorts a later GRN date above an earlier one, whatever the MRC number", () => {
    const older = encode({ date: "20260101", mrcNo: 999999 });
    const newer = encode({ date: "20260826", mrcNo: 1 });
    assert.ok(newer > older);
  });

  it("falls back to MMD_MRC_NO when the dates tie", () => {
    const lower = encode({ date: "20260826", mrcNo: 9 });
    const higher = encode({ date: "20260826", mrcNo: 10 });
    assert.ok(higher > lower);
  });

  it("sorts lines with no header row (no date) oldest", () => {
    const noHeader = encode({ date: "00000000", mrcNo: 999999 });
    const dated = encode({ date: "20200101", mrcNo: 1 });
    assert.ok(dated > noHeader);
  });
});
