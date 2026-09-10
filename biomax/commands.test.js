/**
 * The command queue's rules: only GET_LOG_DATA, the dangerous ones refused
 * by name, transaction ids unique, results matched by trans_id AND dev_id.
 *
 *   node --test biomax/commands.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const c = require("./commands");

describe("allowed and forbidden commands", () => {
  it("GET_LOG_DATA is the only allowed command", () => {
    assert.deepEqual(c.ALLOWED_COMMANDS, ["GET_LOG_DATA"]);
    assert.equal(c.assertAllowedCommand("GET_LOG_DATA"), "GET_LOG_DATA");
    assert.equal(c.assertAllowedCommand(" get_log_data "), "GET_LOG_DATA");
  });

  it("refuses every destructive or routing command by name", () => {
    for (const bad of ["CLEAR_LOG_DATA", "CLEAR_ENROLL_DATA", "DELETE_USER", "RESET_FK", "SET_WEB_SERVER_INFO"]) {
      assert.ok(c.FORBIDDEN_COMMANDS.includes(bad), `${bad} is listed`);
      assert.throws(() => c.assertAllowedCommand(bad), (e) => e.name === "CommandRefused" && /never issued/.test(e.message));
      assert.throws(() => c.buildGetLogDataCommand({ trans_id: "HP20260910120000ABCDEF1234", dev_id: "C2695C56D30E1430", begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 00:00:00", cmd_code: bad }), /never issued/);
    }
  });

  it("refuses anything it does not know, too", () => {
    assert.throws(() => c.assertAllowedCommand("GET_USER_DATA"), /unsupported command/);
    assert.throws(() => c.assertAllowedCommand(""), /unsupported command/);
    assert.throws(() => c.assertAllowedCommand(undefined), /unsupported command/);
  });
});

describe("transaction ids", () => {
  it("are unique, header-safe and 26 characters", () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i += 1) ids.add(c.newTransId());
    assert.equal(ids.size, 2000);
    for (const id of ids) {
      assert.match(id, /^HP\d{14}[0-9A-F]{10}$/);
      assert.equal(id.length, 26);
    }
  });
});

describe("buildGetLogDataCommand", () => {
  const ok = { trans_id: "HP20260910120000ABCDEF1234", dev_id: "C2695C56D30E1430", begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" };

  it("produces a PENDING GET_LOG_DATA with device-format times", () => {
    assert.deepEqual(c.buildGetLogDataCommand(ok), {
      trans_id: ok.trans_id,
      dev_id: ok.dev_id,
      cmd_code: "GET_LOG_DATA",
      begin_time: "20260901000000",
      end_time: "20260902235959",
      status: "PENDING",
    });
  });

  it("belongs to exactly one dev_id and refuses a bad one", () => {
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, dev_id: "" }), /dev_id/);
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, dev_id: "has space" }), /dev_id/);
  });

  it("refuses begin after end and unparseable times", () => {
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, begin_time: "2026-09-03 00:00:00" }), /begin_time must not be after/);
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, begin_time: "yesterday" }), /not a YYYY-MM-DD/);
  });

  it("refuses a malformed trans_id", () => {
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, trans_id: "short" }), /trans_id/);
    assert.throws(() => c.buildGetLogDataCommand({ ...ok, trans_id: "has space in it!" }), /trans_id/);
  });
});

describe("matchResult", () => {
  const command = { dev_id: "C2695C56D30E1430", biomax_historical_pull_id: 7 };
  it("MATCHED only when the trans_id is known AND the answering device is the one it was issued to", () => {
    assert.equal(c.matchResult({ dev_id: "C2695C56D30E1430", trans_id: "T" }, command), "MATCHED");
    assert.equal(c.matchResult({ dev_id: "AMDB24121401307", trans_id: "T" }, command), "WRONG_DEVICE");
    assert.equal(c.matchResult({ dev_id: "C2695C56D30E1430", trans_id: "T" }, null), "UNKNOWN_TRANS_ID");
  });
});

describe("cmd_return_code", () => {
  it("OK (any case) and an absent code are not failures; anything else is", () => {
    assert.equal(c.isFailureReturnCode("OK"), false);
    assert.equal(c.isFailureReturnCode(" ok "), false);
    assert.equal(c.isFailureReturnCode(null), false);
    assert.equal(c.isFailureReturnCode(""), false);
    assert.equal(c.isFailureReturnCode("ERROR"), true);
    assert.equal(c.isFailureReturnCode("ERROR_NO_DATA"), true);
    assert.equal(c.isFailureReturnCode("-1"), true);
  });
});
