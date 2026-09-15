/**
 * Where DigiSME attendance alerts go - and, just as much, where they do NOT.
 *
 *   node --test usecase/digisme_alert_destination.test.js
 *
 * The DigiSME attendance sync is a ~10-day bridge until Biomax reaches
 * dnds.co.in directly. Its alerts go to ONE PERSONAL CHAT, deliberately not
 * to the shared alerts group that accounts, purchase orders and break-glass
 * use: a fortnight of vendor-feed noise in a channel the whole team reads
 * would teach everyone to ignore that channel, which is how the original
 * silent-failure problem happened in the first place.
 *
 * So this file pins both halves. The DigiSME path must use the temporary
 * constant, every other alerting path must still use the shared one, and
 * neither may drift into the other. It also pins the rule that makes a
 * personal chat tolerable at all: a per-minute cron must never send a
 * routine message.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/** Statements only - a comment naming a constant is prose, not a call. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const telegram = require("../constants/telegram");
const sync = require("./digisme_attendance_sync");
const { DigismeAttendanceSyncUsecase } = sync;

/** The destination given for this bridge. */
const VINODH_CHAT_ID = 1933231677;

/* ------------------------------------------------------------ 1. the id */

describe("DigiSME attendance alerts use DIGISME_ATTENDANCE_ALERT_CHAT_ID", () => {
  it("the constant exists and is the chat the bridge was given", () => {
    assert.equal(telegram.DIGISME_ATTENDANCE_ALERT_CHAT_ID, VINODH_CHAT_ID);
  });

  it("it is NOT the shared alerts chat", () => {
    assert.notEqual(telegram.DIGISME_ATTENDANCE_ALERT_CHAT_ID, telegram.ALERTS_TELEGRAM_CHAT_ID);
  });

  it("it is unconditional - IS_TEST cannot redirect it somewhere nobody watches", () => {
    // Every other id in that file falls back to the test group under
    // IS_TEST. This one deliberately does not: whether production carries an
    // IS_TEST line could not be verified from the repository, and an alert
    // silently delivered to the wrong chat is the failure mode this whole
    // integration exists to prevent. A non-production instance is silenced
    // by CRON_DISABLED instead, which stops the jobs rather than rerouting
    // their alerts.
    for (const value of ["true", "false", undefined]) {
      delete require.cache[require.resolve("../constants/telegram")];
      if (value === undefined) delete process.env.IS_TEST;
      else process.env.IS_TEST = value;
      const fresh = require("../constants/telegram");
      assert.equal(
        fresh.DIGISME_ATTENDANCE_ALERT_CHAT_ID,
        VINODH_CHAT_ID,
        `IS_TEST=${value} must not change the DigiSME destination`
      );
    }
    delete process.env.IS_TEST;
    delete require.cache[require.resolve("../constants/telegram")];
  });

  it("server.js wires the sync's alerter to that constant, and the id reaches sendMessage", () => {
    // Replicates server.js's alerter closure exactly, with a fake telegram
    // service, so the assertion is on the VALUE that would be sent - not on
    // the spelling of a constant name.
    const sent = [];
    const fakeTelegram = () => ({
      sendMessage: async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
      },
    });
    const alerter = {
      sendMessage: (text) =>
        fakeTelegram().sendMessage(telegram.DIGISME_ATTENDANCE_ALERT_CHAT_ID, text, {
          disableNotification: false,
          parseMode: null,
        }),
    };
    const usecase = new DigismeAttendanceSyncUsecase({ alerter, now: () => new Date("2026-09-15T08:30:00Z") });
    return usecase._alert("test_condition", "a problem").then(() => {
      assert.equal(sent.length, 1);
      assert.equal(sent[0].chatId, VINODH_CHAT_ID);
      assert.equal(sent[0].text, "a problem");
      assert.equal(sent[0].opts.parseMode, null, "plain text: alert bodies carry vendor and DB text");
    });
  });

  it("server.js's DigiSME alerter names the DigiSME constant, not the shared one", () => {
    const code = codeOf(read("server.js"));
    const at = code.indexOf("digisme_attendance_sync");
    assert.ok(at !== -1);
    // The alerter is constructed inside the usecase's own options object.
    const block = code.slice(at, code.indexOf("cronService.register(\"digisme_attendance_live\"", at));
    assert.match(block, /sendMessage\(DIGISME_ATTENDANCE_ALERT_CHAT_ID,/);
    assert.ok(
      !block.includes("ALERTS_TELEGRAM_CHAT_ID"),
      "the DigiSME wiring must not mention the shared alerts chat"
    );
  });
});

/* -------------------------------------- 2. and never the shared channel */

describe("DigiSME attendance code does NOT use ALERTS_TELEGRAM_CHAT_ID", () => {
  it("no file of the DigiSME bridge references the shared alerts chat", () => {
    for (const f of [
      path.join("usecase", "digisme_attendance_sync.js"),
      path.join("services", "digisme_attendance.js"),
    ]) {
      const code = codeOf(read(f));
      assert.ok(
        !code.includes("ALERTS_TELEGRAM_CHAT_ID"),
        `${f} must not reach for the shared alerts chat`
      );
    }
  });

  it("the sync hard-codes no chat id of its own - the destination is injected", () => {
    // It must stay swappable: when the bridge is removed, deleting the
    // wiring in server.js is enough.
    const code = codeOf(read(path.join("usecase", "digisme_attendance_sync.js")));
    assert.ok(!/\b-?\d{9,}\b/.test(code), "no bare chat id may be embedded in the sync");
    assert.ok(!code.includes("constants/telegram"), "the sync must not import a destination");
    assert.match(code, /this\.alerter/, "the destination is injected by the caller");
  });
});

/* ------------------------------ 3. everyone else is exactly as they were */

describe("existing non-DigiSME alert destinations are untouched", () => {
  it("every other chat constant keeps its value and its IS_TEST behaviour", () => {
    delete process.env.IS_TEST;
    delete require.cache[require.resolve("../constants/telegram")];
    const live = require("../constants/telegram");
    delete require.cache[require.resolve("../constants/telegram")];
    process.env.IS_TEST = "true";
    const test = require("../constants/telegram");
    delete process.env.IS_TEST;
    delete require.cache[require.resolve("../constants/telegram")];

    for (const name of [
      "ALERTS_TELEGRAM_CHAT_ID",
      "PURCHASE_TELEGRAM_CHAT_ID",
      "ABV_TELEGRAM_CHAT_ID",
      "STOCK_CHECKER_TELEGRAM_CHAT_ID",
      "OFFERS_V3_TELEGRAM_CHAT_ID",
    ]) {
      assert.equal(typeof live[name], "number", `${name} must still exist`);
      assert.equal(
        test[name],
        live.TEST_TELEGRAM_CHAT_ID,
        `${name} must still redirect to the test chat under IS_TEST - unchanged behaviour`
      );
    }
  });

  it("the shared alerts chat still serves exactly the consumers it did before", () => {
    // Pinned so that a future edit cannot quietly move one of these onto the
    // DigiSME chat, or move DigiSME onto theirs.
    const consumers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "docs", "migrations", "scripts", "test_support"].includes(entry.name)) continue;
          walk(rel);
        } else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
          if (codeOf(read(rel)).includes("ALERTS_TELEGRAM_CHAT_ID")) consumers.push(rel);
        }
      }
    };
    for (const dir of ["services", "routes", "usecase", "repository", "config", "utils", "constants", "biomax", "middlewares"]) {
      walk(dir);
    }
    if (codeOf(read("server.js")).includes("ALERTS_TELEGRAM_CHAT_ID")) consumers.push("server.js");

    assert.deepEqual(consumers.sort(), [
      path.join("constants", "telegram.js"),
      "server.js",
      path.join("usecase", "accounts.js"),
      path.join("usecase", "purchase_order.js"),
      path.join("usecase", "user.js"),
    ].sort());
  });

  it("break-glass still alerts to the shared chat, with its own override intact", () => {
    const code = codeOf(read("server.js"));
    assert.match(code, /authConfig\.breakGlass\.alertChatId \|\| ALERTS_TELEGRAM_CHAT_ID/);
  });

  it("the DigiSME chat has exactly one consumer", () => {
    const users = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "docs", "migrations", "scripts", "test_support"].includes(entry.name)) continue;
          walk(rel);
        } else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
          if (codeOf(read(rel)).includes("DIGISME_ATTENDANCE_ALERT_CHAT_ID")) users.push(rel);
        }
      }
    };
    for (const dir of ["services", "routes", "usecase", "repository", "config", "utils", "constants", "biomax", "middlewares"]) {
      walk(dir);
    }
    if (codeOf(read("server.js")).includes("DIGISME_ATTENDANCE_ALERT_CHAT_ID")) users.push("server.js");
    assert.deepEqual(users.sort(), [path.join("constants", "telegram.js"), "server.js"]);
  });
});

/* ------------------------------------ 4. a personal chat is never spammed */

describe("routine polling sends no Telegram at all", () => {
  const punch = (code, raw) => ({
    user_id: String(code),
    io_time: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`,
    io_time_raw: raw,
    raw_json: "{}",
  });

  function harness({ fetch, now }) {
    const sent = [];
    const rows = new Map();
    const store = {
      insertCalls: [],
      async insertPunch(p, d, o) {
        const key = `DIGISME_IMPORT|${p.user_id}|${p.io_time_raw}`;
        if (rows.has(key)) return { outcome: "duplicate", biomax_punch_id: rows.get(key) };
        rows.set(key, rows.size + 1);
        return { outcome: "stored", biomax_punch_id: rows.size };
      },
    };
    const repo = {
      items: [],
      batches: [],
      async existingImportKeys(codes, from, to) {
        const out = new Set();
        for (const k of rows.keys()) {
          const [, u, t] = k.split("|");
          if (codes.includes(u) && t >= from && t <= to) out.add(`${u}|${t}`);
        }
        return out;
      },
      async transaction(c, w) { return w({}); },
      async insertBatch(c, b) { repo.batches.push(b); return repo.batches.length; },
      async insertItems(c, id, items) { items.forEach((i) => repo.items.push({ import_item_id: repo.items.length + 1, import_batch_id: id, outcome: null, ...i })); },
      async itemsForCommit(id) { return repo.items.filter((i) => i.import_batch_id === id && i.outcome === null); },
      async updateItemOutcome(id, patch) { Object.assign(repo.items.find((i) => i.import_item_id === id), patch); },
      async finishBatch() {},
      async storedForDate() { return { count: rows.size, latest_io_time_raw: null }; },
    };
    const usecase = new DigismeAttendanceSyncUsecase({
      client: {
        fetchRawAttendance: async (...a) => {
          const r = await fetch(...a);
          Object.defineProperty(r, "vendor_row_count", { value: r.length * 2, enumerable: false });
          return r;
        },
      },
      repo,
      store,
      importUsecase: {
        _resolver: () => ({
          derive: async (u, raw) => ({
            employee: { employee_id: Number(u), store_id: 1, department_id: 2 },
            derived: { attendance_date: "2026-09-15", status: "OK", employee_id: Number(u), home_outlet_id: 1, department_id: 2, work_shift_id: 7, work_shift_weekly_schedule_id: 9, cutoff_applied: "05:00:00" },
          }),
        }),
      },
      apiSyncLogger: { async write() {} },
      alerter: { sendMessage: async (t) => { sent.push(t); } },
      now,
    });
    return { usecase, sent, rows };
  }

  it("60 minutes of healthy polling sends nothing", async () => {
    // Punches arriving normally, inserts happening, nothing wrong. A
    // personal chat must stay silent through an ordinary trading hour.
    let minute = 0;
    const now = () => new Date(`2026-09-15T06:${String(minute).padStart(2, "0")}:00Z`); // ~11:30 IST
    const { usecase, sent } = harness({
      fetch: async () => Array.from({ length: minute + 1 }, (_, i) => punch(100 + i, `202609151${String(10000 + i).slice(0, 5)}`)),
      now,
    });
    for (minute = 0; minute < 60; minute++) await usecase.runLive();
    assert.deepEqual(sent, [], "healthy polling must be completely silent");
  });

  it("a quiet minute - vendor rows present, nothing new - sends nothing", async () => {
    const rows = [punch(101, "20260915113000"), punch(102, "20260915114500")];
    const { usecase, sent } = harness({
      fetch: async () => rows.slice(),
      now: () => new Date("2026-09-15T06:20:00Z"), // 11:50 IST, inside the window
    });
    const first = await usecase.runLive();
    assert.equal(first.inserted_count, 2);
    for (let i = 0; i < 30; i++) await usecase.runLive();
    assert.deepEqual(sent, [], "'nobody punched this minute' is a success, not a notification");
  });

  it("success is never the reason for a message - only problems are", async () => {
    // Every _alert call site must be a failure condition. Asserted against
    // the source so a future "sync complete" courtesy message is caught.
    const code = codeOf(read(path.join("usecase", "digisme_attendance_sync.js")));
    const keys = [...code.matchAll(/this\._alert\(\s*[`"']?([a-z_$\{\}\.]+)/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, "expected some alert conditions");
    for (const k of keys) {
      assert.ok(
        /fail|zero|stale|error|historical/.test(k),
        `alert condition '${k}' does not look like a problem state`
      );
    }
  });
});

/* ----------------------------------- 5. the approved rules did not move */

describe("the approved alert rules are unchanged", () => {
  it("thresholds and window are exactly as approved", () => {
    assert.equal(sync.ZERO_POLL_ALERT_STREAK, 15, "15 consecutive zero-row polls");
    assert.equal(sync.STALE_FEED_MINUTES, 90, "90 minutes without the vendor's latest punch advancing");
    assert.equal(sync.ALERT_COOLDOWN_MS, 60 * 60 * 1000, "60-minute cooldown");
    assert.equal(sync.ALERT_WINDOW_START_HOUR, 10, "10:00 IST");
    assert.equal(sync.ALERT_WINDOW_END_HOUR, 22, "22:00 IST");
    assert.equal(sync.HEARTBEAT_EVERY_MINUTES, 15);
  });

  it("the cooldown still suppresses a repeat of the same condition", async () => {
    const sent = [];
    const usecase = new DigismeAttendanceSyncUsecase({
      alerter: { sendMessage: async (t) => sent.push(t) },
      now: () => new Date("2026-09-15T08:30:00Z"),
    });
    assert.equal(await usecase._alert("stale_feed", "first"), true);
    assert.equal(await usecase._alert("stale_feed", "second"), false, "inside the cooldown");
    assert.equal(await usecase._alert("zero_dataset", "other"), true, "a different condition is not suppressed");
    assert.deepEqual(sent, ["first", "other"]);
  });

  it("a failing alerter never fails a sync", async () => {
    // The destination is one person's chat. If their Telegram is
    // unreachable the punches must still be ingested - api_sync_log remains
    // the durable record either way.
    const usecase = new DigismeAttendanceSyncUsecase({
      alerter: { sendMessage: async () => { throw new Error("telegram down"); } },
      now: () => new Date("2026-09-15T08:30:00Z"),
    });
    await usecase._alert("api_failing", "something broke");
    assert.ok(true, "_alert swallowed the transport failure");
  });
});
