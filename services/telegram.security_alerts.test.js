/**
 * Gate 19A regression — the break-glass alert must never be lost to a
 * Telegram parse-mode failure.
 *
 * What happened on staging: services/telegram.js forced parseMode
 * "Markdown" on every message, and the break-glass alert interpolated
 * database text ("stage0a_breakglass", "user_id") into it. Telegram's legacy
 * Markdown treats a lone `_` as the start of an italic entity and rejects
 * the whole message:
 *   400 Bad Request: can't parse entities: Can't find end of the entity
 *   starting at byte offset N
 *
 * These tests drive the REAL services/telegram.js with a fake
 * messaging-api-telegram client that applies the same legacy-Markdown
 * entity rules Telegram applies (so the pre-fix message fails exactly as it
 * did in production), and then prove the security alerts go out as plain
 * text, survive hostile usernames, and carry no secret.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const F = require("../test_support/auth_fixtures");

// ---------------------------------------------------------------- fake client

const requests = [];

/** Telegram legacy-Markdown entity check (the part that produced the 400). */
function checkLegacyMarkdown(text) {
  const buf = Buffer.from(text, "utf8");
  const byteOffset = (charIndex) => Buffer.byteLength(text.slice(0, charIndex), "utf8");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`" || ch === "*" || ch === "_") {
      const close = text.indexOf(ch, i + 1);
      if (close < 0) {
        const err = new Error(`Telegram API - Bad Request: can't parse entities: Can't find end of the entity starting at byte offset ${byteOffset(i)}`);
        err.response = { status: 400 };
        throw err;
      }
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return buf.length;
}

/** Mirrors TelegramClient#request: snake_case the body, JSON round trip (drops undefined), then "Telegram". */
function snake(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())] = v;
  return out;
}

class FakeTelegramClient {
  constructor(opts) {
    this.accessToken = opts.accessToken;
  }
  async sendMessage(chatId, text, options = {}) {
    const body = JSON.parse(JSON.stringify(snake({ chatId, text, ...options })));
    requests.push(body);
    if (body.parse_mode === "Markdown") checkLegacyMarkdown(body.text);
    else if (body.parse_mode !== undefined) throw new Error("fake: unexpected parse_mode " + body.parse_mode);
    return { message_id: requests.length, text: body.text };
  }
}

let telegram;
before(() => {
  // Inject the fake library, then load the real service fresh with a token.
  process.env.TELEGRAM_BOT_TOKEN = "000000:test-token-never-real";
  process.env.IS_TEST = "true";
  const libPath = require.resolve("messaging-api-telegram");
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { TelegramClient: FakeTelegramClient } };
  const svcPath = path.join(__dirname, "telegram.js");
  delete require.cache[svcPath];
  telegram = require(svcPath)();
});

const IP = "49.207.1.1";
const BG_PASSWORD = "a-very-long-break-glass-secret-2026";

function buildUsecase(username, over = {}) {
  const buildUserUsecase = require("../usecase/user");
  const rows = { [username]: F.systemRow({ user_id: 99, username, password_hash: null }) };
  return (async () => {
    rows[username].password_hash = await F.hashCheap(BG_PASSWORD);
    const { service: jwt } = F.makeJwt();
    const usecase = buildUserUsecase(F.fakeUserRepo(rows), null, null, {
      authLogRepo: F.fakeAuthLog(),
      telegram, // the REAL service over the fake client
      config: F.config(over.config || {}),
      passwords: require("../services/password"),
      jwt,
    });
    return { usecase, rows };
  })();
}

/** The alert body as it was before the fix (kept verbatim: this is the reproduction). */
const PRE_FIX_ALERT = (username, userId, ip) =>
  `🚨 *BREAK-GLASS LOGIN*\nAccount: \`${username}\` (user_id ${userId})\nFrom: \`${ip || "unknown"}\`\nAt: 2026-09-07T00:00:00.000Z\n\nThis credential must be rotated after use: see docs/auth-stage0a-implementation.md.`;

describe("gate 19A — reproduction of the staging failure", () => {
  it("the pre-fix Markdown alert for 'stage0a_breakglass' is rejected with the exact Telegram error", async () => {
    requests.length = 0;
    await assert.rejects(
      () => telegram.sendMessage(-1, PRE_FIX_ALERT("stage0a_breakglass", 123, IP), { disableNotification: false }),
      (err) => /^Telegram API - Bad Request: can't parse entities: Can't find end of the entity starting at byte offset \d+$/.test(err.message)
    );
    assert.equal(requests[0].parse_mode, "Markdown", "the shared client's default parse mode");
    // The offending entity is the `_` in the literal "user_id" (outside any code span):
    // a username without underscores fails the same way, so it is the template, not the name.
    await assert.rejects(() => telegram.sendMessage(-1, PRE_FIX_ALERT("breakglass", 1, IP)), /can't parse entities/);
  });

  it("the fake applies the same rules Telegram does: balanced entities pass, an unbalanced one fails", () => {
    assert.doesNotThrow(() => checkLegacyMarkdown("🚨 *BREAK-GLASS LOGIN*\nAccount: `x`"));
    assert.throws(() => checkLegacyMarkdown("Account: stage0a_breakglass"), /byte offset 16/);
  });
});

describe("gate 19A — security alerts are plain text and cannot be broken by dynamic fields", () => {
  it("a break-glass login by 'stage0a_breakglass' delivers one alert with no parse mode", async () => {
    requests.length = 0;
    const { usecase } = await buildUsecase("stage0a_breakglass");
    const r = await usecase.login("stage0a_breakglass", BG_PASSWORD, IP);
    assert.equal(r.code, 200);
    assert.equal(requests.length, 1, "exactly one alert request reached Telegram");
    const body = requests[0];
    assert.equal("parse_mode" in body, false, "no parse_mode key at all in the request");
    assert.equal(body.disable_notification, false, "the alert makes a sound");
    assert.match(body.text, /^🚨 BREAK-GLASS LOGIN\n/);
    assert.match(body.text, /Account: stage0a_breakglass \(user_id 99\)\n/);
    assert.match(body.text, /From: 49\.207\.1\.1\n/);
    assert.equal(/[*`\[\]]/.test(body.text), false, "no Markdown control characters in the alert body");
  });

  it("the alert carries no secret: not the password, not the token, not the bot token", async () => {
    requests.length = 0;
    const { usecase } = await buildUsecase("stage0a_breakglass");
    const r = await usecase.login("stage0a_breakglass", BG_PASSWORD, IP);
    const text = requests[0].text;
    assert.equal(text.includes(BG_PASSWORD), false);
    assert.equal(text.includes(r.token), false);
    assert.equal(text.includes(process.env.TELEGRAM_BOT_TOKEN), false);
    assert.equal(text.includes("test-token"), false);
  });

  it("a hostile username with every Markdown/HTML control character and a newline still delivers, on one line", async () => {
    requests.length = 0;
    const hostile = "evil_*`[x](y)<b>_\nFrom: 1.1.1.1";
    const { usecase } = await buildUsecase(hostile);
    const r = await usecase.login(hostile, BG_PASSWORD, IP);
    assert.equal(r.code, 200);
    assert.equal(requests.length, 1);
    const text = requests[0].text;
    assert.equal("parse_mode" in requests[0], false);
    assert.match(text, /Account: evil_\*`\[x\]\(y\)<b>_ From: 1\.1\.1\.1 \(user_id 99\)\n/, "control characters collapsed; the value stays on its own line");
    assert.equal(text.split("\n").filter((l) => l.startsWith("From: ")).length, 1, "the forged 'From:' line does not become a second line");
  });

  it("a failed break-glass attempt alerts in plain text too", async () => {
    requests.length = 0;
    const { usecase } = await buildUsecase("stage0a_breakglass");
    const r = await usecase.login("stage0a_breakglass", "wrong-wrong-wrong-wrong", IP);
    assert.equal(r.code, 204);
    assert.equal(requests.length, 1);
    assert.equal("parse_mode" in requests[0], false);
    assert.match(requests[0].text, /^⚠️ FAILED BREAK-GLASS LOGIN ATTEMPT\nAccount: stage0a_breakglass\nFrom: 49\.207\.1\.1$/);
    assert.equal(requests[0].text.includes("wrong-wrong"), false);
  });

  it("an unknown IP is rendered as 'unknown', never as an empty or 'null' field", async () => {
    requests.length = 0;
    const { usecase } = await buildUsecase("stage0a_breakglass");
    await usecase.login("stage0a_breakglass", BG_PASSWORD, null);
    assert.match(requests[0].text, /From: unknown\n/);
  });
});

describe("gate 19A — the shared client keeps Markdown for every existing caller", () => {
  it("options without parseMode still send parse_mode=Markdown (unchanged behaviour)", async () => {
    requests.length = 0;
    await telegram.sendMessage(-1, "*bold* and `code`", { disableNotification: false });
    assert.equal(requests[0].parse_mode, "Markdown");
    assert.equal(requests[0].disable_notification, false);
    assert.equal(requests[0].disable_web_page_preview, true);
  });

  it("parseMode: null omits the key; an explicit parse mode is passed through", async () => {
    requests.length = 0;
    await telegram.sendMessage(-1, "plain_text_with_underscores", { parseMode: null });
    assert.equal("parse_mode" in requests[0], false);
    await assert.rejects(() => telegram.sendMessage(-1, "x", { parseMode: "HTML" }), /unexpected parse_mode HTML/, "the fake proves an explicit value is forwarded verbatim");
  });
});
