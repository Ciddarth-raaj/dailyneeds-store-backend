/**
 * Historical pull request rules, against an in-memory repository.
 *
 *   node --test usecase/biomax_historical_pull.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./biomax_historical_pull");
const { MAX_RANGE_DAYS } = require("./biomax_historical_pull");

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0) + new Date(2026, 8, 10, 12).getTimezoneOffset() * 60000 * 0; // any fixed instant
const clock = () => new Date(2026, 8, 10, 12, 0, 0).getTime(); // local 2026-09-10 12:00:00

function fakeRepo() {
  const state = {
    devices: new Map([[6, { biomax_device_id: 6, dev_id: "C2695C56D30E1430", label: "WH", has_open_period: 1 }], [7, { biomax_device_id: 7, dev_id: "AMDB24121401307", label: "G2", has_open_period: 0 }]]),
    pulls: [],
    commands: [],
    tx: 0,
  };
  return {
    state,
    async deviceById(id) {
      return state.devices.get(id) || null;
    },
    async list(f) {
      return state.pulls.filter((p) => (!f.dev_id || p.dev_id === f.dev_id) && (!f.status || p.status === f.status));
    },
    async getById(id) {
      return state.pulls.find((p) => p.biomax_historical_pull_id === id) || null;
    },
    async commandFor(id) {
      return state.commands.find((c) => c.biomax_historical_pull_id === id) || null;
    },
    async blocksFor() {
      return [{ blk_no: 1, body_len: 10, body_sha256: "x".repeat(64), match_status: "MATCHED" }];
    },
    async findActiveOverlapping(dev_id, from, to) {
      return state.pulls.filter((p) => p.dev_id === dev_id && ["REQUESTED", "WAITING_DEVICE", "RECEIVING"].includes(p.status) && p.requested_from <= to && p.requested_to >= from);
    },
    async transaction(code, work) {
      state.tx += 1;
      return work({});
    },
    async insertPull(conn, p) {
      const id = state.pulls.length + 1;
      state.pulls.push({ biomax_historical_pull_id: id, status: "REQUESTED", ...p });
      return id;
    },
    async insertCommand(conn, c) {
      state.commands.push(c);
      return state.commands.length;
    },
  };
}

describe("create", () => {
  let repo;
  let uc;
  beforeEach(() => {
    repo = fakeRepo();
    let n = 0;
    uc = build(repo, { clock, transId: () => `HP2026091012000000000000${String(++n).padStart(2, "0")}` });
  });

  it("queues exactly one GET_LOG_DATA for the device, in one transaction, REQUESTED", async () => {
    const r = await uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02" }, { employeeId: 99 });
    assert.deepEqual(r, { code: 200, biomax_historical_pull_id: 1, trans_id: "HP202609101200000000000001", status: "REQUESTED" });
    assert.equal(repo.state.tx, 1);
    assert.equal(repo.state.pulls.length, 1);
    assert.deepEqual(repo.state.pulls[0], {
      biomax_historical_pull_id: 1,
      status: "REQUESTED",
      biomax_device_id: 6,
      dev_id: "C2695C56D30E1430",
      requested_from: "2026-09-01 00:00:00",
      requested_to: "2026-09-02 23:59:59",
      trans_id: "HP202609101200000000000001",
      requested_by: 99,
    });
    assert.deepEqual(repo.state.commands, [{
      biomax_historical_pull_id: 1,
      trans_id: "HP202609101200000000000001",
      dev_id: "C2695C56D30E1430",
      cmd_code: "GET_LOG_DATA",
      begin_time: "20260901000000",
      end_time: "20260902235959",
      status: "PENDING",
    }]);
  });

  it("each request gets its own trans_id and belongs to exactly one dev_id", async () => {
    await uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-01" }, {});
    await uc.create({ biomax_device_id: 7, from: "2026-09-01", to: "2026-09-01" }, {});
    const ids = repo.state.commands.map((c) => c.trans_id);
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(repo.state.commands.map((c) => c.dev_id), ["C2695C56D30E1430", "AMDB24121401307"]);
  });

  it("refuses an unregistered device", async () => {
    await assert.rejects(uc.create({ biomax_device_id: 999, from: "2026-09-01", to: "2026-09-01" }, {}), /not registered/);
    assert.equal(repo.state.pulls.length, 0);
  });

  it("an inactive (no open period) but registered device may be asked for its history", async () => {
    const r = await uc.create({ biomax_device_id: 7, from: "2026-09-01", to: "2026-09-01" }, {});
    assert.equal(r.code, 200);
  });

  it("refuses from > to", async () => {
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-09-03", to: "2026-09-02" }, {}), /from must not be after to/);
  });

  it("refuses a future end", async () => {
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-09-10 00:00:00", to: "2026-09-10 12:00:01" }, {}), /future/);
    const ok = await uc.create({ biomax_device_id: 6, from: "2026-09-10 00:00:00", to: "2026-09-10 12:00:00" }, {});
    assert.equal(ok.code, 200);
    await assert.rejects(uc.create({ biomax_device_id: 7, from: "2026-09-10", to: "2026-09-10" }, {}), /future/, "a bare date means end of day, which is still to come");
  });

  it(`refuses more than ${MAX_RANGE_DAYS} days`, async () => {
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-07-01", to: "2026-08-15" }, {}), /at most 31 days/);
    const ok = await uc.create({ biomax_device_id: 6, from: "2026-08-01 00:00:00", to: "2026-08-31 23:59:59" }, {});
    assert.equal(ok.code, 200);
  });

  it("refuses malformed dates", async () => {
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "01/09/2026", to: "2026-09-02" }, {}), /from must be YYYY-MM-DD/);
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-02-30", to: "2026-09-02" }, {}), /not a real date/);
    await assert.rejects(uc.create({ biomax_device_id: "six", from: "2026-09-01", to: "2026-09-02" }, {}), /biomax_device_id/);
  });

  it("refuses an overlapping ACTIVE pull on the same device with 409, allows it on another device or once finished", async () => {
    await uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-05" }, {});
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-09-05", to: "2026-09-06" }, {}), (e) => e.httpCode === 409 && e.existing_pull_id === 1 && /already covers/.test(e.message));
    await assert.rejects(uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-05" }, {}), (e) => e.httpCode === 409);
    const other = await uc.create({ biomax_device_id: 7, from: "2026-09-01", to: "2026-09-05" }, {});
    assert.equal(other.code, 200);
    const adjacent = await uc.create({ biomax_device_id: 6, from: "2026-09-06", to: "2026-09-07" }, {});
    assert.equal(adjacent.code, 200);
    repo.state.pulls[0].status = "COMPLETED";
    const again = await uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02" }, {});
    assert.equal(again.code, 200);
  });
});

describe("reads", () => {
  it("details returns the pull, its command's window and status, and block summaries without bytes", async () => {
    const repo = fakeRepo();
    const uc = build(repo, { clock, transId: () => "HP202609101200000000000001" });
    await uc.create({ biomax_device_id: 6, from: "2026-09-01", to: "2026-09-01" }, {});
    const d = await uc.details(1);
    assert.equal(d.trans_id, "HP202609101200000000000001");
    assert.deepEqual(d.command, { cmd_code: "GET_LOG_DATA", begin_time: "20260901000000", end_time: "20260901235959", status: "PENDING", created_at: undefined, sent_at: undefined });
    assert.equal(d.blocks_received, 1);
    assert.ok(!("raw_body" in d.blocks[0]));
    await assert.rejects(uc.details(42), (e) => e.httpCode === 404);
    await assert.rejects(uc.details("x"), /positive integer/);
  });

  it("list passes only the known filters", async () => {
    const repo = fakeRepo();
    let seen = null;
    repo.list = async (f) => { seen = f; return []; };
    await build(repo, { clock }).list({ dev_id: "X", status: "FAILED", limit: 10, raw: true });
    assert.deepEqual(seen, { dev_id: "X", status: "FAILED", limit: 10 });
  });
});
