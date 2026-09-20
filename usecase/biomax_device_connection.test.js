/**
 * The Devices screen's two states, as the usecase assembles them.
 *
 *   node --test usecase/biomax_device_connection.test.js
 *
 * The rule lives on the server: the screen is handed a word, never a
 * timeout to apply itself.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { BiomaxDeviceUsecase } = require("./biomax_device");
const { RECEIVER } = require("../utils/biomax_receiver_health");

const NOW = Date.UTC(2026, 8, 20, 12, 40, 0);
const at = (minutesAgo) => {
  const d = new Date(NOW - minutesAgo * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

const ROWS = [
  { biomax_device_id: 1, dev_id: "DN1", label: "DN1", status: "ACTIVE", last_seen_at: at(2), last_punch_at: at(82) },
  { biomax_device_id: 2, dev_id: "DN2", label: "DN2", status: "ACTIVE", last_seen_at: at(300), last_punch_at: at(300) },
  { biomax_device_id: 3, dev_id: "DN3", label: "DN3", status: "INACTIVE", last_seen_at: at(1), last_punch_at: null },
  { biomax_device_id: 4, dev_id: "DN4", label: "DN4", status: "INACTIVE", last_seen_at: null, last_punch_at: null },
];

const repo = {
  list: async () => ROWS.map((r) => ({ ...r })),
  getById: async (id) => ({ ...ROWS.find((r) => r.biomax_device_id === id), notes: null }),
  assignments: async () => [{ biomax_device_assignment_id: 9, outlet_id: 3, outlet_name: "Vallalar Salai", effective_from: "2026-01-01 00:00:00", effective_to: null }],
  events: async () => [],
};

const make = (health) =>
  new BiomaxDeviceUsecase(repo, {
    now: () => NOW,
    env: {},
    checkReceiverHealth: health || (async () => ({ status: RECEIVER.ONLINE, ok: true, db: true, last_punch_received: at(82) })),
  });

describe("list carries both states for every device", () => {
  it("each row gets connection_status, last_seen_at and seconds_since_seen", async () => {
    const rows = await make().list();
    assert.deepEqual(
      rows.map((r) => [r.dev_id, r.status, r.connection_status]),
      [
        ["DN1", "ACTIVE", "CONNECTED"],
        ["DN2", "ACTIVE", "OFFLINE"],
        ["DN3", "INACTIVE", "CONNECTED"],
        ["DN4", "INACTIVE", "NEVER_SEEN"],
      ]
    );
    assert.equal(rows[0].seconds_since_seen, 120);
    assert.equal(rows[3].seconds_since_seen, null);
    assert.equal(rows[0].last_seen_at, ROWS[0].last_seen_at);
  });

  it("a device polling with no punch for over an hour is Connected, not Offline", async () => {
    const [dn1] = await make().list();
    assert.equal(dn1.connection_status, "CONNECTED");
    assert.equal(dn1.last_punch_at, at(82));
  });
});

describe("the device page shows the same pair", () => {
  it("details carries connection_status beside the assignment status", async () => {
    const got = await make().details(2);
    assert.equal(got.status, "ACTIVE");
    assert.equal(got.connection_status, "OFFLINE");
    assert.equal(got.current_assignment.outlet_name, "Vallalar Salai");
  });
});

describe("receiver health sits beside the counts, and cannot take them down with it", () => {
  it("an online receiver comes back with the tally", async () => {
    const got = await make().receiverHealth();
    assert.equal(got.receiver.status, RECEIVER.ONLINE);
    assert.deepEqual(got.devices, { connected: 2, stale: 0, offline: 1, never_seen: 1, total: 4 });
    assert.deepEqual(got.thresholds, { staleSeconds: 900, offlineSeconds: 3600 });
  });

  it("an unreachable receiver does not turn every terminal Offline", async () => {
    const got = await make(async () => ({ status: RECEIVER.UNAVAILABLE, ok: false, db: false, last_punch_received: null, reason: "timeout" }))
      .receiverHealth();
    assert.equal(got.receiver.status, RECEIVER.UNAVAILABLE);
    // Unchanged: each device is still judged by its own last_seen_at.
    assert.deepEqual(got.devices, { connected: 2, stale: 0, offline: 1, never_seen: 1, total: 4 });
  });

  it("a probe that throws outright still leaves the list readable", async () => {
    const usecase = make(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7005");
    });
    await assert.rejects(() => usecase.receiverHealth());
    // The list endpoint is separate and unaffected - that is why it is separate.
    assert.equal((await usecase.list()).length, 4);
  });
});
