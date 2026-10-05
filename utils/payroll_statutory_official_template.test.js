/**
 * THE ESIC CONSTANTS, CHECKED AGAINST THE OFFICIAL TEMPLATE ITSELF.
 *
 *   node --test utils/payroll_statutory_official_template.test.js
 *
 * Place the official ESIC sample template, exactly as downloaded from the
 * ESIC portal ("Instructions & Reason Codes", MC_Template1.xls), at
 *
 *   test_support/statutory/MC_Template1.xls
 *
 * and this suite asserts that `utils/payroll_statutory_files.js` matches it:
 * the six column headers (text and order) and the numeric code of every
 * zero-wage reason. SKIPPED while the file is absent - the build environment
 * cannot reach esic.gov.in / esic.in to fetch it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const S = require("./payroll_statutory_files");

const FILE = path.join(__dirname, "..", "test_support", "statutory", "MC_Template1.xls");
const present = fs.existsSync(FILE);
const norm = (t) => String(t || "").replace(/[’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

describe("ESIC constants vs the official MC template", { skip: !present && `official template not supplied at ${FILE}` }, () => {
  const wb = present ? XLSX.readFile(FILE) : null;
  const cells = () =>
    wb.SheetNames.flatMap((name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }).map((row) => ({ name, row })));

  it("the six data columns, text and order, are the template's", () => {
    const header = cells().find(({ row }) => row.some((c) => /ip number/i.test(c)));
    assert.ok(header, "no header row containing 'IP Number' in the template");
    const cols = header.row.filter((c) => norm(c) !== "");
    assert.deepEqual(cols.map(norm), S.ESIC_HEADERS.map(norm));
  });

  it("every reason code DnDS can write has the template's number", () => {
    const table = new Map();
    for (const { row } of cells()) {
      for (let i = 0; i + 1 < row.length; i += 1) {
        if (/^\d{1,2}$/.test(String(row[i]).trim()) && /[a-z]/i.test(row[i + 1])) table.set(Number(row[i]), norm(row[i + 1]));
      }
    }
    for (const [code, label] of Object.entries(S.ESIC_REASON)) {
      assert.ok(table.has(Number(code)), `code ${code} (${label}) is not in the template`);
      const official = table.get(Number(code)).replace(/[^a-z]/g, "");
      const ours = norm(label).replace(/[^a-z]/g, "");
      assert.ok(official.includes(ours) || ours.includes(official), `code ${code}: template says "${table.get(Number(code))}", DnDS says "${label}"`);
    }
  });
});
