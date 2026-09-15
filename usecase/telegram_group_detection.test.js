/**
 * Telegram group detection - the `/setup` handler.
 *
 *   node --test usecase/telegram_group_detection.test.js
 *
 * THE PROPERTY THIS FEATURE LIVES OR DIES BY is not in this file alone: that
 * there is still exactly ONE reader of Telegram's update offset. That is
 * asserted in `usecase/telegram_update_ownership.test.js`, which fails if a
 * second `getUpdates` caller ever appears. What is defended here is what the
 * handler does with a message it is given:
 *
 *   `/setup` and `/setup@ourbot` in a group or supergroup are detected
 *   a private chat, a channel, a positive id and any other text are ignored
 *   nothing but the chat id, the title and the time is ever kept
 *   an already-registered chat id is not offered
 *   a repeat `/setup` does not create a second pending entry
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./telegram_group_detection");
const {
  isSetupCommand,
  DETECTION_TTL_MS,
  MAX_DETECTIONS,
} = require("./telegram_group_detection");
const { GROUP_TYPE } = require("../constants/telegram_group_registry");

const SUPERGROUP = "-1001234567890";
const BASIC = "-4800060153";
const BOT = "dailyneeds_bot";

const telegram = { getBotUsername: async () => BOT };

/** A registry repo that says which chat ids are already registered. */
const registryRepo = (registered = []) => ({
  getByChatId: async (chatId) =>
    registered.includes(String(chatId)) ? { telegram_group_id: 1, chat_id: chatId } : null,
});

const message = (overrides = {}) => ({
  text: "/setup",
  chat: { id: Number(SUPERGROUP), title: "Store Attendance", type: "supergroup" },
  from: { id: 42, username: "someone", first_name: "Some" },
  ...overrides,
});

function usecase({ registered = [], now } = {}) {
  return build({ telegram, registryRepo: registryRepo(registered), now });
}

/* ================================================== what is detected ==== */

describe("the setup command", () => {
  it("detects a bare /setup in a supergroup", async () => {
    const d = usecase();
    const detection = await d.handleMessage(message());
    assert.ok(detection, "a detection was recorded");
    assert.equal(detection.chat_id, SUPERGROUP);
    assert.equal(detection.group_name, "Store Attendance");
    const listed = await d.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].group_type, GROUP_TYPE.SUPERGROUP);
  });

  it("detects /setup@ourbot, which is how Telegram sends it beside other bots", async () => {
    const d = usecase();
    assert.ok(await d.handleMessage(message({ text: `/setup@${BOT}` })));
    assert.equal((await d.list()).length, 1);
  });

  it("is case-insensitive about the command and the bot name", async () => {
    const d = usecase();
    assert.ok(await d.handleMessage(message({ text: "/SETUP" })));
    assert.ok(await d.handleMessage(message({ text: `/setup@${BOT.toUpperCase()}` })));
  });

  it("IGNORES /setup@someoneelsesbot - it was not addressed to us", async () => {
    const d = usecase();
    assert.equal(await d.handleMessage(message({ text: "/setup@other_bot" })), null);
    assert.equal((await d.list()).length, 0);
  });

  it("detects a basic group and derives its type", async () => {
    const d = usecase();
    await d.handleMessage(
      message({ chat: { id: Number(BASIC), title: "Maintenance", type: "group" } })
    );
    const listed = await d.list();
    assert.equal(listed[0].group_type, GROUP_TYPE.BASIC_GROUP);
  });

  it("ignores any other message", async () => {
    const d = usecase();
    for (const text of ["hello", "/start abc", "setup", "/setupnow", "/setup please", "", null]) {
      assert.equal(await d.handleMessage(message({ text })), null, JSON.stringify(text));
    }
    assert.equal((await d.list()).length, 0);
  });

  it("the command matcher itself refuses a bot suffix when we do not know our name", () => {
    assert.equal(isSetupCommand("/setup", ""), true);
    assert.equal(isSetupCommand("/setup@anything", ""), false);
  });
});

/* ================================================= what is refused ====== */

describe("chats that are not registrable groups", () => {
  it("IGNORES A PRIVATE CHAT - that is a person, not a group", async () => {
    const d = usecase();
    const result = await d.handleMessage(
      message({ chat: { id: 123456789, title: undefined, type: "private" } })
    );
    assert.equal(result, null);
    assert.equal((await d.list()).length, 0);
  });

  it("ignores a channel", async () => {
    const d = usecase();
    assert.equal(
      await d.handleMessage(message({ chat: { id: Number(SUPERGROUP), title: "News", type: "channel" } })),
      null
    );
  });

  it("IGNORES A POSITIVE CHAT ID even if the type claims to be a group", async () => {
    // Belt and braces: the type is what Telegram says, the id is what the
    // registry can actually store, and a positive id is a user.
    const d = usecase();
    assert.equal(
      await d.handleMessage(message({ chat: { id: 1234567890, title: "Spoofed", type: "supergroup" } })),
      null
    );
  });

  it("ignores a missing or malformed chat id", async () => {
    const d = usecase();
    for (const id of [undefined, null, 0, "abc", "-100abc", " -1001234567890 "]) {
      assert.equal(
        await d.handleMessage(message({ chat: { id, title: "X", type: "supergroup" } })),
        null,
        JSON.stringify(id)
      );
    }
  });

  it("ignores a message with no chat at all, and never throws", async () => {
    const d = usecase();
    assert.equal(await d.handleMessage({ text: "/setup" }), null);
    assert.equal(await d.handleMessage({}), null);
    assert.equal(await d.handleMessage(null), null);
  });
});

/* ============================================ privacy of what is kept === */

describe("what is stored", () => {
  it("KEEPS ONLY the chat id, the title, the type and the time", async () => {
    const d = usecase();
    const detection = await d.handleMessage(message());
    assert.deepEqual(Object.keys(detection).sort(), [
      "chat_id",
      "chat_type",
      "detected_at",
      "group_name",
    ]);
  });

  it("STORES NO MESSAGE BODY AND NO SENDER", async () => {
    // The message text and the `from` block are the two things that could
    // leak a person into an operational screen. Neither is kept.
    const d = usecase();
    await d.handleMessage(message({ text: `/setup@${BOT}` }));
    const stored = JSON.stringify([...d.detections.values()]);
    assert.ok(!stored.includes("/setup"), "no command text");
    assert.ok(!stored.includes("someone"), "no sender username");
    assert.ok(!stored.includes("42"), "no sender id");
    const listed = JSON.stringify(await d.list());
    for (const leak of ["/setup", "someone", "first_name", "from"]) {
      assert.ok(!listed.includes(leak), `${leak} must not be exposed`);
    }
  });

  it("falls back to a readable name rather than storing an empty title", async () => {
    const d = usecase();
    const detection = await d.handleMessage(
      message({ chat: { id: Number(SUPERGROUP), title: "   ", type: "supergroup" } })
    );
    assert.equal(detection.group_name, "Untitled Telegram group");
  });
});

/* ================================================ duplicates and TTL ==== */

describe("duplicates", () => {
  it("a repeat /setup REPLACES rather than adds", async () => {
    const d = usecase();
    await d.handleMessage(message());
    await d.handleMessage(message({ chat: { id: Number(SUPERGROUP), title: "Renamed", type: "supergroup" } }));
    const listed = await d.list();
    assert.equal(listed.length, 1, "one pending entry per chat id");
    assert.equal(listed[0].group_name, "Renamed", "the newer title wins");
  });

  it("DOES NOT OFFER A CHAT ID THAT IS ALREADY REGISTERED", async () => {
    // Offering it would let somebody select a group whose save is then
    // refused as a duplicate - correct, and utterly baffling.
    const d = usecase({ registered: [SUPERGROUP] });
    assert.ok(await d.handleMessage(message()));
    assert.deepEqual(await d.list(), []);
  });

  it("fails closed when it cannot tell whether a group is registered", async () => {
    const d = build({
      telegram,
      registryRepo: {
        getByChatId: async () => {
          throw new Error("db down");
        },
      },
    });
    await d.handleMessage(message());
    assert.deepEqual(await d.list(), [], "not offered when the check failed");
  });

  it("forget() drops one detection", async () => {
    const d = usecase();
    await d.handleMessage(message());
    assert.equal(d.forget(SUPERGROUP), true);
    assert.deepEqual(await d.list(), []);
  });
});

describe("expiry", () => {
  it("stops offering a detection once its TTL has passed", async () => {
    let clock = new Date("2026-09-15T10:00:00Z");
    const d = usecase({ now: () => clock });
    await d.handleMessage(message());
    assert.equal((await d.list()).length, 1);

    clock = new Date(clock.getTime() + DETECTION_TTL_MS + 1000);
    assert.deepEqual(await d.list(), [], "expired detections are forgotten");
    assert.equal(d.detections.size, 0, "and dropped from memory, not just hidden");
  });

  it("is bounded, so a flood of /setup cannot grow memory without limit", async () => {
    const d = usecase();
    for (let i = 0; i < MAX_DETECTIONS + 10; i += 1) {
      await d.handleMessage(
        message({ chat: { id: Number(`-100999${String(i).padStart(4, "0")}`), title: `G${i}`, type: "supergroup" } })
      );
    }
    assert.equal(d.detections.size, MAX_DETECTIONS);
  });

  it("lists newest first", async () => {
    let clock = new Date("2026-09-15T10:00:00Z");
    const d = usecase({ now: () => clock });
    await d.handleMessage(message({ chat: { id: Number(BASIC), title: "Older", type: "group" } }));
    clock = new Date(clock.getTime() + 60000);
    await d.handleMessage(message({ chat: { id: Number(SUPERGROUP), title: "Newer", type: "supergroup" } }));
    const listed = await d.list();
    assert.equal(listed[0].group_name, "Newer");
  });
});

/* ====================================== it must never break the poller == */

describe("it cannot break linking", () => {
  it("returns null rather than throwing when the bot username lookup fails", async () => {
    const d = build({
      telegram: {
        getBotUsername: async () => {
          throw new Error("telegram down");
        },
      },
      registryRepo: registryRepo(),
    });
    // The bare command still works: it needs no bot name to be addressed.
    assert.ok(await d.handleMessage(message({ text: "/setup" })));
    // And the addressed form is refused rather than blowing up.
    assert.equal(await d.handleMessage(message({ text: `/setup@${BOT}` })), null);
  });

  it("never throws, whatever it is handed", async () => {
    const d = usecase();
    for (const bad of [undefined, null, 0, "", [], { chat: { id: {} } }, { chat: null }]) {
      assert.equal(await d.handleMessage(bad), null, JSON.stringify(bad));
    }
  });
});
