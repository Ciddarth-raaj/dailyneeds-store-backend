/**
 * THE MINI APP URL HELPER.
 *
 *   node --test utils/telegram_mini_app_url.test.js
 *
 * The point of this module is that no caller hand-builds a Mini App URL, so
 * the tests are mostly about what it REFUSES to build.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SECTION,
  miniAppUrl,
  webAppButton,
  webAppKeyboard,
  normalizeBase,
  buildQuery,
} = require("../utils/telegram_mini_app_url");

const BASE = "https://dnds.co.in/telegram/attendance";

describe("the base URL", () => {
  it("strips trailing slashes", () => {
    assert.equal(miniAppUrl(`${BASE}/`), BASE);
    assert.equal(miniAppUrl(`${BASE}///`), BASE);
    assert.equal(miniAppUrl(`  ${BASE}/  `), BASE);
  });

  it("no base URL means NO url, NO button and NO keyboard", () => {
    for (const absent of [null, undefined, "", "   ", 0, {}]) {
      assert.equal(miniAppUrl(absent, { section: SECTION.HELP }), null, String(absent));
      assert.equal(webAppButton(absent, "Help", { section: SECTION.HELP }), null);
      assert.equal(webAppKeyboard(absent, [{ text: "Help", section: SECTION.HELP }]), null);
    }
  });

  it("is not hard-coded - the helper knows no hostname", () => {
    const src = require("fs").readFileSync(require.resolve("../utils/telegram_mini_app_url"), "utf8");
    assert.ok(!/dnds\.co\.in/.test(src), "no production hostname in application logic");
    assert.equal(miniAppUrl("https://staging.example.net/mini"), "https://staging.example.net/mini");
  });
});

describe("the query is navigation, and only the two navigation keys", () => {
  it("builds section and date", () => {
    assert.equal(
      miniAppUrl(BASE, { section: SECTION.CORRECTIONS, date: "2026-09-18" }),
      `${BASE}?section=corrections&date=2026-09-18`
    );
    assert.equal(miniAppUrl(BASE, { section: SECTION.HELP }), `${BASE}?section=help`);
    assert.equal(miniAppUrl(BASE, {}), BASE);
  });

  /**
   * THE LOAD-BEARING TEST. `employee_id` is not stripped - it is not
   * expressible. There is no parameter for it, so a caller cannot pass one
   * through this helper however hard they try.
   */
  it("CANNOT carry an employee id, by any spelling", () => {
    const url = miniAppUrl(BASE, {
      section: SECTION.CORRECTIONS,
      date: "2026-09-18",
      employee_id: 78,
      employeeId: 78,
      requested_for_employee_id: 78,
      emp: 78,
    });
    assert.equal(url, `${BASE}?section=corrections&date=2026-09-18`);
    assert.ok(!/employee/i.test(url));
    assert.ok(!/78/.test(url));
  });

  it("drops an unknown section rather than linking somewhere that does not exist", () => {
    assert.equal(miniAppUrl(BASE, { section: "approvals" }), BASE);
    assert.equal(miniAppUrl(BASE, { section: "" }), BASE);
    assert.equal(miniAppUrl(BASE, { section: 7 }), BASE);
  });

  it("drops a malformed date", () => {
    assert.equal(miniAppUrl(BASE, { date: "yesterday" }), BASE);
    assert.equal(miniAppUrl(BASE, { date: "2026-9-1" }), BASE);
    assert.equal(miniAppUrl(BASE, { date: null }), BASE);
  });

  it("encodes what it does accept", () => {
    assert.equal(buildQuery({ section: SECTION.CORRECTIONS }), "section=corrections");
    assert.equal(normalizeBase("https://a.b/c/"), "https://a.b/c");
  });
});

describe("the inline web_app button", () => {
  /**
   * The SAME shape the Regularise Attendance button already uses in
   * production - an inline keyboard with a `web_app` url. Not a reply
   * keyboard, which is a different Telegram mechanism nothing here needs.
   */
  it("is an inline web_app button, the shape already proven in production", () => {
    const button = webAppButton(BASE, "My Attendance", { section: SECTION.ATTENDANCE });
    assert.deepEqual(button, {
      text: "My Attendance",
      web_app: { url: `${BASE}?section=attendance` },
    });
  });

  it("refuses a button with no label", () => {
    assert.equal(webAppButton(BASE, "", { section: SECTION.HELP }), null);
    assert.equal(webAppButton(BASE, "   "), null);
    assert.equal(webAppButton(BASE, null), null);
  });

  it("stacks one button per row", () => {
    const keyboard = webAppKeyboard(BASE, [
      { text: "My Attendance", section: SECTION.ATTENDANCE },
      { text: "Corrections", section: SECTION.CORRECTIONS },
      { text: "Help", section: SECTION.HELP },
    ]);
    assert.equal(keyboard.inlineKeyboard.length, 3);
    keyboard.inlineKeyboard.forEach((row) => assert.equal(row.length, 1));
    assert.deepEqual(
      keyboard.inlineKeyboard.map((row) => row[0].web_app.url),
      [`${BASE}?section=attendance`, `${BASE}?section=corrections`, `${BASE}?section=help`]
    );
  });

  it("a keyboard with no usable button is null, never an empty keyboard", () => {
    assert.equal(webAppKeyboard(BASE, []), null);
    assert.equal(webAppKeyboard(BASE, [{ text: "" }]), null);
    assert.equal(webAppKeyboard(BASE, null), null);
  });
});
