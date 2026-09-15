/**
 * DigiSME attendance API sync - regression coverage.
 *
 *   node --test usecase/digisme_attendance_sync.test.js
 *
 * The failure this integration exists to prevent is silent: four days of
 * attendance went missing in Sep 2026 and recalculation read the gap as ~208
 * real absences a day until someone noticed. So the assertions here are as
 * much about what is LOUD and what is QUIET as about what is stored.
 *
 * The store and repository are fakes that enforce the one rule that actually
 * guarantees correctness in production: the UNIQUE `import_dedup_key`,
 * CONCAT(ingest_source,'|',user_id,'|',io_time_raw). FakeStore raises
 * ER_DUP_ENTRY on a repeat exactly as MySQL does, so a test that passes here
 * because the pre-filter caught a duplicate and a test that passes because
 * the database caught it are distinguishable - and both are asserted.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const sync = require("./digisme_attendance_sync");
const { DigismeAttendanceSyncUsecase } = sync;

/* --------------------------------------------------------------- fakes -- */

/** The unique key the migration actually creates. */
const dedupKey = (p) => `DIGISME_IMPORT|${p.user_id}|${p.io_time_raw}`;

class FakeStore {
  constructor() {
    this.rows = new Map(); // dedup key -> row
    this.nextId = 1;
    this.insertCalls = [];
  }
  async insertPunch(punch, derived, options) {
    this.insertCalls.push({ punch, derived, options });
    if (!options.importBatchId) throw new Error("a DIGISME_IMPORT punch must name its import_batch_id");
    const key = dedupKey(punch);
    if (this.rows.has(key)) {
      return { outcome: "duplicate", biomax_punch_id: this.rows.get(key).biomax_punch_id };
    }
    const row = {
      biomax_punch_id: this.nextId++,
      ingest_source: "DIGISME_IMPORT",
      import_batch_id: options.importBatchId,
      raw_json: punch.raw_json === undefined ? null : punch.raw_json,
      io_mode: null,
      ...punch,
    };
    this.rows.set(key, row);
    return { outcome: "stored", biomax_punch_id: row.biomax_punch_id };
  }
  /** Seed a punch as if an Excel import had already stored it. */
  seedExcel(user_id, io_time_raw) {
    const key = dedupKey({ user_id, io_time_raw });
    this.rows.set(key, { biomax_punch_id: this.nextId++, user_id, io_time_raw, ingest_source: "DIGISME_IMPORT" });
  }
}

class FakeRepo {
  constructor(store) {
    this.store = store;
    this.batches = [];
    this.items = [];
    this.nextBatchId = 1;
    this.nextItemId = 1;
  }
  async existingImportKeys(codes, fromRaw, toRaw) {
    const out = new Set();
    for (const row of this.store.rows.values()) {
      if (row.io_time_raw >= fromRaw && row.io_time_raw <= toRaw && codes.includes(row.user_id)) {
        out.add(`${row.user_id}|${row.io_time_raw}`);
      }
    }
    return out;
  }
  async transaction(code, work) {
    return work({});
  }
  async insertBatch(conn, b) {
    const id = this.nextBatchId++;
    this.batches.push({ import_batch_id: id, ...b });
    return id;
  }
  async insertItems(conn, batchId, items) {
    for (const it of items) {
      this.items.push({ import_item_id: this.nextItemId++, import_batch_id: batchId, outcome: null, ...it });
    }
  }
  async itemsForCommit(batchId) {
    return this.items.filter((i) => i.import_batch_id === batchId && i.outcome === null);
  }
  async updateItemOutcome(itemId, patch) {
    const it = this.items.find((i) => i.import_item_id === itemId);
    if (it) Object.assign(it, patch);
  }
  async finishBatch(batchId, patch) {
    const b = this.batches.find((x) => x.import_batch_id === batchId);
    if (b) Object.assign(b, patch);
  }
  async storedForDate(dateIso) {
    const ymd = dateIso.replace(/-/g, "");
    let count = 0;
    let latest = null;
    for (const row of this.store.rows.values()) {
      if (String(row.io_time_raw).startsWith(ymd)) {
        count += 1;
        if (!latest || row.io_time_raw > latest) latest = row.io_time_raw;
      }
    }
    return { count, latest_io_time_raw: latest };
  }
}

/** Everyone resolves to an employee, with a clean attendance date. */
const fakeImportUsecase = {
  _resolver: () => ({
    derive: async (user_id, io_time_raw) => ({
      employee: { employee_id: Number(user_id), store_id: 1, department_id: 2 },
      derived: {
        attendance_date: `${io_time_raw.slice(0, 4)}-${io_time_raw.slice(4, 6)}-${io_time_raw.slice(6, 8)}`,
        status: "OK",
        employee_id: Number(user_id),
        home_outlet_id: 1,
        department_id: 2,
        work_shift_id: 7,
        work_shift_weekly_schedule_id: 9,
        cutoff_applied: "05:00:00",
      },
    }),
  }),
};

class FakeLogger {
  constructor() { this.rows = []; }
  async write(entry) { this.rows.push(entry); }
}

class FakeAlerter {
  constructor() { this.messages = []; }
  async sendMessage(text) { this.messages.push(text); }
}

/** A vendor punch as fetchRawAttendance returns it (already client-deduped). */
const punch = (code, raw, extra = {}) => ({
  user_id: String(code),
  io_time: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`,
  io_time_raw: raw,
  employee_name: "Test",
  clock_location: null,
  job_location: null,
  raw_json: JSON.stringify({ Code: String(code), PunchAction: extra.PunchAction || "IN", Source: extra.Source || "Device" }),
});

/**
 * Wrap a plain array the way fetchRawAttendance does: the vendor's own row
 * count travels WITH the punches, because the double-send is an observation
 * and the caller must never re-derive it as `length * 2`.
 */
function vendorResult(punches, vendorRowCount) {
  const out = punches.slice();
  Object.defineProperty(out, "vendor_row_count", {
    value: vendorRowCount === undefined ? punches.length * 2 : vendorRowCount,
    enumerable: false,
  });
  Object.defineProperty(out, "unparseable_count", { value: 0, enumerable: false });
  return out;
}

function build({ fetch, now, alerter } = {}) {
  const store = new FakeStore();
  const repo = new FakeRepo(store);
  const apiSyncLogger = new FakeLogger();
  const usecase = new DigismeAttendanceSyncUsecase({
    client: {
      fetchRawAttendance: async (...args) => {
        const rows = fetch ? await fetch(...args) : [];
        return Array.isArray(rows) && rows.vendor_row_count === undefined ? vendorResult(rows) : rows;
      },
    },
    repo,
    store,
    importUsecase: fakeImportUsecase,
    apiSyncLogger,
    alerter: alerter || new FakeAlerter(),
    now: now || (() => new Date("2026-09-14T08:30:00Z")), // 14:00 IST
  });
  return { usecase, store, repo, apiSyncLogger };
}

/* ---------------------------------------------------------------- tests -- */

describe("dedup: the same punch twice is one stored punch", () => {
  it("the vendor's byte-identical double-send stores 525, not 1050", async () => {
    // fetchRawAttendance already collapses the double-send; what reaches the
    // usecase is 525. Assert the count that ends up in the table.
    const rows = [];
    for (let i = 0; i < 525; i++) rows.push(punch(100 + (i % 208), `202609140${String(90000 + i).slice(0, 5)}`));
    const { usecase, store } = build({ fetch: async () => vendorResult(rows, 1050) });
    const m = await usecase.syncDate("2026-09-14");
    assert.equal(m.client_deduped_count, 525);
    assert.equal(m.vendor_row_count, 1050, "reports what the vendor actually sent");
    assert.equal(store.rows.size, m.inserted_count);
  });

  it("a duplicate the pre-filter does NOT see is still caught by the database", async () => {
    const { usecase, store, repo } = build();
    // Pre-filter sees nothing (empty table), so both reach insertPunch; the
    // second must come back as a duplicate from the unique key alone.
    const p = punch(101, "20260914093000");
    const committed = await usecase._commitNewPunches("2026-09-14", [p, { ...p }]);
    assert.equal(committed.inserted, 1);
    assert.equal(committed.duplicate, 1, "the database, not the pre-filter, settled this");
    assert.equal(store.rows.size, 1);
    assert.equal(repo.items.filter((i) => i.outcome === "SKIPPED_REIMPORT_DUPLICATE").length, 1);
  });
});

describe("vendor_row_count is measured, not inferred", () => {
  it("reports the client's own count, not deduped * 2", async () => {
    // The day the vendor stops double-sending, a `length * 2` guess would
    // silently double every figure in the log.
    const rows = [punch(101, "20260914134500"), punch(102, "20260914135500")];
    const { usecase } = build({ fetch: async () => vendorResult(rows, 2) });
    const m = await usecase.syncDate("2026-09-14");
    assert.equal(m.vendor_row_count, 2, "no double-send on this response");
    assert.equal(m.client_deduped_count, 2);
  });
});

describe("cross-source dedup: Excel then API", () => {
  it("a punch already imported from Excel is not stored again by the API", async () => {
    const { usecase, store } = build({ fetch: async () => [punch(101, "20260914093000")] });
    store.seedExcel("101", "20260914093000");
    assert.equal(store.rows.size, 1);

    const m = await usecase.syncDate("2026-09-14");

    assert.equal(store.rows.size, 1, "still exactly one punch for this employee and instant");
    assert.equal(m.inserted_count, 0);
    assert.equal(m.duplicate_count, 1);
    assert.equal(m.new_candidate_count, 0);
  });

  it("Excel and API share one ingest_source, which is what makes that work", async () => {
    // The guard that matters: import_dedup_key contains ingest_source, so a
    // separate DIGISME_API value would give the same real punch two keys.
    const store = new FakeStore();
    store.seedExcel("101", "20260914093000");
    const key = [...store.rows.keys()][0];
    assert.ok(key.startsWith("DIGISME_IMPORT|"), "Excel punches key on DIGISME_IMPORT");
    const { usecase, store: s2 } = build({ fetch: async () => [punch(101, "20260914093000")] });
    await usecase.syncDate("2026-09-14");
    assert.ok([...s2.rows.keys()][0].startsWith("DIGISME_IMPORT|"), "API punches key on DIGISME_IMPORT too");
  });
});

describe("rerun: the same date twice is idempotent", () => {
  it("second sync inserts nothing, reports duplicates, and stays a success", async () => {
    const rows = [punch(101, "20260914093000"), punch(102, "20260914094500")];
    const { usecase, store, repo } = build({ fetch: async () => rows });

    const first = await usecase.syncDate("2026-09-14");
    assert.equal(first.inserted_count, 2);
    const batchesAfterFirst = repo.batches.length;

    const second = await usecase.syncDate("2026-09-14");
    assert.equal(second.inserted_count, 0);
    assert.equal(second.duplicate_count, 2);
    assert.equal(second.error, null, "an idempotent rerun is not a failure");
    assert.equal(store.rows.size, 2, "no additional punches");
    assert.equal(repo.batches.length, batchesAfterFirst, "and no additional batch");
  });

  it("a quiet poll creates NO batch and NO items at all", async () => {
    // Decision 1: without this the live job would stage ~525 items a minute,
    // ~756,000 rows a day, to describe 525 real punches.
    const rows = [punch(101, "20260914093000")];
    const { usecase, repo } = build({ fetch: async () => rows });
    await usecase.syncDate("2026-09-14");
    const batches = repo.batches.length;
    const items = repo.items.length;

    for (let i = 0; i < 10; i++) await usecase.syncDate("2026-09-14");

    assert.equal(repo.batches.length, batches, "ten quiet polls, zero new batches");
    assert.equal(repo.items.length, items, "ten quiet polls, zero new items");
  });
});

describe("multi-day recovery", () => {
  it("inserts only the missing punches and preserves the existing ones", async () => {
    const byDate = {
      "2026-09-11": [punch(101, "20260911093000")],
      "2026-09-12": [punch(101, "20260912093000")],
      "2026-09-13": [punch(101, "20260913093000")],
    };
    const { usecase, store } = build({ fetch: async (from) => byDate[from] || [] });
    store.seedExcel("101", "20260912093000"); // day 2 already imported
    const before = store.rows.size;

    const result = await usecase.runHistorical();

    assert.equal(result.code, 200);
    assert.equal(result.dates.length, 3);
    assert.equal(store.rows.size, before + 2, "two missing days added, the existing one untouched");
    const day2 = result.dates.find((d) => d.attendance_date === "2026-09-12");
    assert.equal(day2.inserted_count, 0);
    assert.equal(day2.duplicate_count, 1);
  });

  it("the window is today-3, today-2, yesterday - today is NOT re-read", async () => {
    const asked = [];
    const { usecase } = build({
      fetch: async (from) => { asked.push(from); return [punch(101, `${from.replace(/-/g, "")}093000`)]; },
    });
    await usecase.runHistorical();
    assert.deepEqual(asked, ["2026-09-11", "2026-09-12", "2026-09-13"]);
    assert.ok(!asked.includes("2026-09-14"), "today is the live job's, and is self-healing");
  });
});

describe("empty vendor day", () => {
  it("a historical date with zero punches is LOUD", async () => {
    const alerter = new FakeAlerter();
    const { usecase, apiSyncLogger } = build({ fetch: async () => [], alerter });
    const result = await usecase.runHistorical();

    assert.equal(result.code, 500, "not a silent success");
    assert.match(result.message, /3 of 3 dates failed/);
    for (const d of result.dates) assert.match(d.error, /ZERO punches/);
    assert.equal(alerter.messages.length, 3);
    assert.equal(apiSyncLogger.rows[0].status, "failed");
  });

  it("a current-day poll with rows but nothing new is a NORMAL success", async () => {
    const alerter = new FakeAlerter();
    // Punches from a few minutes ago, not this morning: a dataset whose
    // latest punch is four hours old is a STALE FEED and is supposed to
    // alert (see the stale-feed suite). What is being asserted here is the
    // quiet minute - everyone who is coming has arrived and nobody punched
    // in the last sixty seconds.
    const rows = [punch(101, "20260914134500"), punch(102, "20260914135500")];
    const { usecase } = build({ fetch: async () => rows, alerter });
    await usecase.runLive();
    const second = await usecase.runLive();

    assert.equal(second.code, 200);
    assert.equal(second.vendor_row_count, 4);
    assert.equal(second.inserted_count, 0);
    assert.equal(second.duplicate_count, 2);
    assert.equal(alerter.messages.length, 0, "nobody punched this minute; that is not an incident");
  });
});

describe("zero-row current-day polling", () => {
  it("stays silent outside the alert window however long it is empty", async () => {
    const alerter = new FakeAlerter();
    // 04:00 IST - the shop is shut.
    const { usecase } = build({ fetch: async () => [], alerter, now: () => new Date("2026-09-13T22:30:00Z") });
    for (let i = 0; i < 40; i++) await usecase.runLive();
    assert.equal(alerter.messages.length, 0);
  });

  it("needs 15 consecutive empty polls inside the window before it alerts", async () => {
    const alerter = new FakeAlerter();
    const { usecase } = build({ fetch: async () => [], alerter }); // 14:00 IST
    for (let i = 0; i < sync.ZERO_POLL_ALERT_STREAK - 1; i++) await usecase.runLive();
    assert.equal(alerter.messages.length, 0, "14 empty polls is a vendor blip, not an incident");

    await usecase.runLive();
    assert.equal(alerter.messages.length, 1);
    assert.match(alerter.messages[0], /EMPTY dataset/);
  });

  it("does not alert again inside the cooldown", async () => {
    const alerter = new FakeAlerter();
    const { usecase } = build({ fetch: async () => [], alerter });
    for (let i = 0; i < 60; i++) await usecase.runLive();
    assert.equal(alerter.messages.length, 1, "one alert an hour, not one a minute");
  });
});

describe("stale feed", () => {
  it("flags a feed that answers 200 but has stopped advancing", async () => {
    const alerter = new FakeAlerter();
    let now = new Date("2026-09-14T04:00:00Z"); // 09:30 IST
    const rows = [punch(101, "20260914093000")];
    const { usecase } = build({ fetch: async () => rows, alerter, now: () => now });

    await usecase.runLive();                       // dataset is fresh
    assert.equal(alerter.messages.length, 0);

    now = new Date("2026-09-14T05:30:00Z");        // 11:00 IST, 90 min later
    await usecase.runLive();
    assert.equal(alerter.messages.length, 1);
    assert.match(alerter.messages[0], /NOT ADVANCING/);
  });

  it("stays quiet at a gap shorter than the threshold", async () => {
    const alerter = new FakeAlerter();
    let now = new Date("2026-09-14T04:00:00Z");
    const rows = [punch(101, "20260914093000")];
    const { usecase } = build({ fetch: async () => rows, alerter, now: () => now });
    await usecase.runLive();
    now = new Date("2026-09-14T05:00:00Z");        // 60 minutes: plausible quiet
    await usecase.runLive();
    assert.equal(alerter.messages.length, 0);
  });
});

describe("partial failure", () => {
  it("one bad date does not stop or hide the others", async () => {
    const { usecase } = build({
      fetch: async (from) => {
        if (from === "2026-09-12") throw new Error("gateway timeout");
        return [punch(101, `${from.replace(/-/g, "")}093000`)];
      },
    });
    const result = await usecase.runHistorical();

    assert.equal(result.code, 500);
    assert.equal(result.dates.length, 3, "all three dates are reported");
    assert.match(result.message, /2026-09-12/);
    const ok = result.dates.filter((d) => !d.error);
    assert.equal(ok.length, 2);
    assert.equal(ok[0].inserted_count, 1, "the healthy dates still stored their punches");
  });
});

describe("credentials never reach a log or an error", () => {
  const API_KEY = "11111111-2222-3333-4444-555555555555:SuperSecretVendorBearerValue";
  const CUSTOM_KEY = "Y3VzdG9tS2V5VmFsdWVUaGF0SXNTZWNyZXQ=";

  it("an axios error carrying credential headers is reduced to its message", async () => {
    // This is the real shape: axios attaches the request config, headers and
    // all, to every error it throws.
    const err = new Error("connect ETIMEDOUT");
    err.config = { headers: { Authorization: API_KEY, customKey: CUSTOM_KEY } };
    err.response = { status: 504, config: err.config };

    const scrubbed = sync.safeError(err);
    assert.ok(!scrubbed.includes(API_KEY));
    assert.ok(!scrubbed.includes(CUSTOM_KEY));
    assert.equal(scrubbed, "HTTP 504: connect ETIMEDOUT");
  });

  it("no credential value appears anywhere in the logged output of a failed run", async () => {
    const err = new Error("connect ETIMEDOUT");
    err.config = { headers: { Authorization: API_KEY, customKey: CUSTOM_KEY } };
    err.response = { status: 504, config: err.config };

    const alerter = new FakeAlerter();
    const { usecase, apiSyncLogger } = build({ fetch: async () => { throw err; }, alerter });
    for (let i = 0; i < 6; i++) await usecase.runLive();
    await usecase.runHistorical();

    const everything = JSON.stringify(apiSyncLogger.rows) + JSON.stringify(alerter.messages);
    assert.ok(!everything.includes(API_KEY), "the bearer must never be persisted");
    assert.ok(!everything.includes(CUSTOM_KEY), "the custom key must never be persisted");
    assert.ok(!everything.includes("SuperSecret"));
  });
});

describe("PunchAction and Source are preserved, not mapped", () => {
  it("the vendor row survives in raw_json and io_mode stays NULL", async () => {
    const rows = [punch(101, "20260914093000", { PunchAction: "OUT", Source: "Mobile" })];
    const { usecase, store } = build({ fetch: async () => rows });
    await usecase.syncDate("2026-09-14");

    const stored = [...store.rows.values()][0];
    assert.equal(stored.io_mode, null, "io_mode is a BIGINT documented as NOT a direction flag");
    const payload = JSON.parse(stored.raw_json);
    assert.equal(payload.PunchAction, "OUT");
    assert.equal(payload.Source, "Mobile");
  });

  it("an Excel import still writes raw_json NULL", async () => {
    const store = new FakeStore();
    const res = await store.insertPunch(
      { user_id: "101", io_time_raw: "20260914093000" }, // no raw_json
      {},
      { source: "DIGISME_IMPORT", importBatchId: 1 }
    );
    assert.equal(res.outcome, "stored");
    assert.equal([...store.rows.values()][0].raw_json, null);
  });
});

describe("IST date boundaries", () => {
  // The server's clock and the database session are UTC; attendance is
  // Indian wall-clock. Between 18:30 and 24:00 UTC the two disagree about
  // what day it is, and a sync that derived "today" from UTC would spend
  // those five and a half hours re-fetching YESTERDAY - so the first hours
  // of every Indian day would never be pulled until the day was over.
  // IST is UTC+5:30 with no DST, so the offset is a constant, not a lookup.

  it("a 00:15 IST run fetches the NEW Indian date, not the UTC one", async () => {
    const asked = [];
    // 00:15 IST on 15 Sep == 18:45 UTC on 14 Sep.
    const { usecase } = build({
      fetch: async (from) => { asked.push(from); return []; },
      now: () => new Date("2026-09-14T18:45:00Z"),
    });
    await usecase.runLive();
    assert.deepEqual(asked, ["2026-09-15"], "the UTC date 2026-09-14 would miss the whole new Indian day");
  });

  it("a 23:59 IST run is still on the old Indian date", async () => {
    const asked = [];
    const { usecase } = build({
      fetch: async (from) => { asked.push(from); return []; },
      now: () => new Date("2026-09-14T18:29:00Z"), // 23:59 IST
    });
    await usecase.runLive();
    assert.deepEqual(asked, ["2026-09-14"]);
  });

  it("the boundary is exactly 18:30 UTC, to the minute", () => {
    assert.equal(sync.istDateString(new Date("2026-09-14T18:29:59Z")), "2026-09-14");
    assert.equal(sync.istDateString(new Date("2026-09-14T18:30:00Z")), "2026-09-15");
  });

  it("recovery walks back from the IST date, across a month end", async () => {
    const asked = [];
    // 00:30 IST on 1 Oct 2026 == 19:00 UTC on 30 Sep.
    const { usecase } = build({
      fetch: async (from) => { asked.push(from); return []; },
      now: () => new Date("2026-09-30T19:00:00Z"),
    });
    await usecase.runHistorical();
    assert.deepEqual(asked, ["2026-09-28", "2026-09-29", "2026-09-30"]);
    assert.ok(!asked.includes("2026-10-01"), "today is never in the recovery window");
  });

  it("the alert window is read in IST too", () => {
    // 10:00 IST == 04:30 UTC. A UTC reading would open the window at
    // 15:30 IST and alert through the night.
    const inWindow = (iso) => {
      const { usecase } = build({ now: () => new Date(iso) });
      return usecase._inAlertWindow(new Date(iso));
    };
    assert.equal(inWindow("2026-09-14T04:29:00Z"), false, "09:59 IST - still shut");
    assert.equal(inWindow("2026-09-14T04:30:00Z"), true, "10:00 IST - window opens");
    assert.equal(inWindow("2026-09-14T16:29:00Z"), true, "21:59 IST - still open");
    assert.equal(inWindow("2026-09-14T16:30:00Z"), false, "22:00 IST - window closes");
    assert.equal(inWindow("2026-09-14T20:00:00Z"), false, "01:30 IST - shut");
  });

  it("the attendance date on a stored punch comes from the punch, not the clock", async () => {
    // A punch at 00:30 IST is a punch on the new calendar date. Whether it
    // belongs to the PREVIOUS attendance date is the cutoff rule's business
    // (biomax/attendanceDate.js), reached through the shared resolver - the
    // sync never decides it.
    const { usecase, repo } = build({
      fetch: async () => [punch(101, "20260915003000")],
      now: () => new Date("2026-09-14T19:00:00Z"), // 00:30 IST on the 15th
    });
    await usecase.syncDate("2026-09-15");
    assert.equal(repo.items[0].io_time_raw, "20260915003000");
    assert.equal(repo.items[0].attendance_date, "2026-09-15", "from the resolver, given the punch instant");
  });
});

describe("monitoring state survives a restart without crying wolf", () => {
  it("a fresh process does not alert stale on its very first poll", async () => {
    // State is in memory and resets on restart. The first poll must
    // re-establish the baseline from the vendor's own dataset rather than
    // treating "I have no history" as "the feed has stopped".
    const alerter = new FakeAlerter();
    const { usecase } = build({
      // A dataset whose newest punch is hours old - which is normal first
      // thing, and normal for the first poll after any restart.
      fetch: async () => [punch(101, "20260914093000")],
      alerter,
      now: () => new Date("2026-09-14T04:35:00Z"), // 10:05 IST
    });
    assert.equal(usecase.state.latest_vendor_punch_ts, null, "no history yet");
    await usecase.runLive();
    assert.equal(alerter.messages.length, 0, "the first poll establishes a baseline, it does not alert");
  });

  it("a fresh process does not inherit a zero-poll streak", async () => {
    const alerter = new FakeAlerter();
    const { usecase } = build({ fetch: async () => [], alerter });
    assert.equal(usecase.state.consecutive_zero_polls, 0);
    await usecase.runLive();
    assert.equal(alerter.messages.length, 0, "one empty poll after a restart is not an incident");
  });

  it("a non-empty poll clears the streak, so a blip cannot accumulate into an alert", async () => {
    const alerter = new FakeAlerter();
    let empty = true;
    const { usecase } = build({
      fetch: async () => (empty ? [] : [punch(101, "20260914134500")]),
      alerter,
    });
    for (let i = 0; i < 14; i++) await usecase.runLive();
    empty = false;
    await usecase.runLive();
    assert.equal(usecase.state.consecutive_zero_polls, 0, "the streak resets on real data");
    empty = true;
    for (let i = 0; i < 14; i++) await usecase.runLive();
    assert.equal(alerter.messages.length, 0, "two sub-threshold runs are not one alert");
  });
});

describe("raw_json cannot carry anything of ours", () => {
  it("is built from the vendor's response row alone - never from the request", () => {
    // The only assignment to raw_json in the client is JSON.stringify(row),
    // where `row` is one element of the DECODED RESPONSE. Our credentials
    // live in the request headers and in module constants; neither is in
    // scope of that expression. Asserted against the source because the risk
    // is a future edit that helpfully attaches "context" to the payload.
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "services", "digisme_attendance.js"),
      "utf8"
    );
    const assignments = [...src.matchAll(/raw_json:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(assignments, ["JSON.stringify(row)"], "raw_json must be the vendor row and nothing else");
  });

  it("the stored payload contains no credential, header or config value", async () => {
    const API_KEY = "11111111-2222-3333-4444-555555555555:SuperSecretVendorBearerValue";
    const CUSTOM_KEY = "Y3VzdG9tS2V5VmFsdWVUaGF0SXNTZWNyZXQ=";
    const { usecase, store } = build({
      fetch: async () => [punch(101, "20260914134500", { PunchAction: "IN", Source: "Device" })],
    });
    await usecase.syncDate("2026-09-14");
    const stored = [...store.rows.values()][0];
    for (const secret of [API_KEY, CUSTOM_KEY, "Authorization", "customKey", "bearer", "Grant_type"]) {
      assert.ok(!String(stored.raw_json).includes(secret), `raw_json must not contain ${secret}`);
    }
    // What it DOES contain: the vendor's own fields.
    const payload = JSON.parse(stored.raw_json);
    assert.deepEqual(Object.keys(payload).sort(), ["Code", "PunchAction", "Source"]);
  });

  it("the punch handed to insertPunch carries nothing but identity and payload", async () => {
    const { usecase, store } = build({ fetch: async () => [punch(101, "20260914134500")] });
    await usecase.syncDate("2026-09-14");
    assert.deepEqual(
      Object.keys(store.insertCalls[0].punch).sort(),
      ["io_time_raw", "raw_json", "user_id"],
      "no employee_name, clock_location or other vendor extras leak into biomax_punch"
    );
  });
});

describe("re-entrancy", () => {
  it("a tick arriving mid-run is skipped, not queued", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const { usecase } = build({ fetch: async () => { calls += 1; await gate; return []; } });

    const first = usecase.runLive();
    const second = await usecase.runLive();
    assert.equal(second.skipped, true);
    assert.match(second.reason, /still in flight/);
    release();
    await first;
    assert.equal(calls, 1, "the vendor was called once, not twice");
  });

  it("the guard clears after a failing run", async () => {
    const { usecase } = build({ fetch: async () => { throw new Error("boom"); } });
    await usecase.runLive();
    assert.equal(usecase.liveRunning, false, "a failure must not wedge the job for ever");
  });
});

describe("api_sync_log volume", () => {
  it("quiet minutes do not each earn a durable row", async () => {
    const rows = [punch(101, "20260914093000")];
    // 14:01 IST .. so the first heartbeat lands at 14:15.
    let minute = 1;
    const now = () => new Date(`2026-09-14T08:${String(30 + minute).padStart(2, "0")}:00Z`);
    const { usecase, apiSyncLogger } = build({ fetch: async () => rows, now });

    for (minute = 1; minute <= 30; minute++) await usecase.runLive();

    assert.ok(
      apiSyncLogger.rows.length <= 4,
      `expected a handful of rows for 30 quiet minutes, got ${apiSyncLogger.rows.length}`
    );
    assert.ok(apiSyncLogger.rows.length >= 1, "but the heartbeat must still land");
  });

  it("an empty dataset outside opening hours does NOT earn a row every minute", async () => {
    // ~540 overnight polls legitimately return zero rows. Persisting each
    // would put back most of the 1,440 rows a day this rule avoids.
    let minute = 1;
    // 03:01 IST onwards.
    const now = () => new Date(`2026-09-13T21:${String(30 + minute).padStart(2, "0")}:00Z`);
    const { usecase, apiSyncLogger } = build({ fetch: async () => [], now });
    for (minute = 1; minute <= 29; minute++) await usecase.runLive();
    assert.ok(
      apiSyncLogger.rows.length <= 2,
      `29 correctly-empty night polls should be near-silent, got ${apiSyncLogger.rows.length}`
    );
  });

  it("an empty dataset DURING opening hours is persisted every poll", async () => {
    let minute = 1;
    const now = () => new Date(`2026-09-14T08:${String(30 + minute).padStart(2, "0")}:00Z`); // 14:0x IST
    const { usecase, apiSyncLogger } = build({ fetch: async () => [], now });
    for (minute = 1; minute <= 5; minute++) await usecase.runLive();
    assert.equal(apiSyncLogger.rows.length, 5, "an empty shop floor at 2pm is worth a durable record");
  });

  it("a run that inserted something is always persisted", async () => {
    const rows = [punch(101, "20260914093000")];
    // 14:07 IST - not a heartbeat minute.
    const { usecase, apiSyncLogger } = build({
      fetch: async () => rows,
      now: () => new Date("2026-09-14T08:37:00Z"),
    });
    await usecase.runLive();
    assert.equal(apiSyncLogger.rows.length, 1);
    assert.equal(apiSyncLogger.rows[0].row_count, 1);
  });

  it("the heartbeat carries the monitoring signals", async () => {
    const rows = [punch(101, "20260914093000")];
    const { usecase, apiSyncLogger } = build({
      fetch: async () => rows,
      now: () => new Date("2026-09-14T08:45:00Z"), // 14:15 IST
    });
    await usecase.runLive();
    await usecase.runLive(); // second run inserts nothing; heartbeat minute
    const meta = apiSyncLogger.rows[apiSyncLogger.rows.length - 1].metadata_json;
    for (const field of [
      "attendance_date", "api_ok", "vendor_row_count", "client_deduped_count",
      "inserted_count", "duplicate_count", "rejected_count",
      "latest_vendor_punch_ts", "stored_punch_count", "latest_stored_punch_ts",
      "last_successful_fetch_at", "last_nonempty_dataset_at", "consecutive_zero_polls",
    ]) {
      assert.ok(field in meta, `heartbeat metadata is missing ${field}`);
    }
  });
});

describe("batch provenance", () => {
  it("an API batch is DIGISME_API_PULL; the punch stays DIGISME_IMPORT", async () => {
    const { usecase, repo, store } = build({ fetch: async () => [punch(101, "20260914093000")] });
    await usecase.syncDate("2026-09-14");

    assert.equal(repo.batches[0].source_type, "DIGISME_API_PULL");
    assert.equal(repo.batches[0].sheet_name, "GetRawAttendance");
    assert.match(repo.batches[0].original_filename, /^GetRawAttendance 2026-09-14$/);
    assert.equal([...store.rows.values()][0].ingest_source, "DIGISME_IMPORT");
    assert.equal(store.insertCalls[0].options.source, "DIGISME_IMPORT");
  });

  it("no sync path triggers attendance recalculation", async () => {
    // Asserted against the SOURCE, because the risk is a future edit that
    // adds the convenience call. Recalculating a date from inside a sync
    // that has not finished its window recalculates against knowingly
    // incomplete punch data - the exact failure this integration exists to
    // end. Statements only: the word appears in an operator-facing alert
    // message, which is prose, not a call.
    const src = require("fs").readFileSync(require("path").join(__dirname, "digisme_attendance_sync.js"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    assert.ok(!/recalculat/i.test(code), "the sync must not recalculate: see the header");
  });
});
