/**
 * Device management rules: add, move, replace, deactivate, correct - and
 * what each refuses.
 *
 *   node --test usecase/biomax_device.test.js
 *
 * The repository is faked in memory with the same method surface as
 * repository/biomax_device.js. Every write must go through `transaction`,
 * and every change must leave an event row.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./biomax_device");
const { normaliseDateTime } = require("./biomax_device");

function fakeRepo() {
  const state = { devices: [], assignments: [], events: [], lastPunch: {}, outlets: new Set([2, 3, 4, 5, 6, 7]) };
  let nextDevice = 1;
  let nextAssign = 1;
  const repo = {
    state,
    async transaction(code, work) {
      return work({ fake: true });
    },
    async list() {
      return state.devices;
    },
    async getById(id) {
      const d = state.devices.find((x) => x.biomax_device_id === id);
      return d ? { ...d } : null;
    },
    async getByDevId(dev_id) {
      const d = state.devices.find((x) => x.dev_id === dev_id);
      return d ? { ...d } : null;
    },
    async assignments(id) {
      return state.assignments.filter((a) => a.biomax_device_id === id).map((a) => ({ ...a, outlet_name: `O${a.outlet_id}` })).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    },
    async events(id) {
      return state.events.filter((e) => e.biomax_device_id === id);
    },
    async unregisteredSeen() {
      return [];
    },
    async lastPunchIoTime(dev_id) {
      return state.lastPunch[dev_id] || null;
    },
    async outletExists(id) {
      return state.outlets.has(id);
    },
    async insertDevice(conn, d) {
      const id = nextDevice++;
      state.devices.push({ biomax_device_id: id, ...d });
      return id;
    },
    async updateDeviceFields(conn, id, fields) {
      Object.assign(state.devices.find((x) => x.biomax_device_id === id), fields);
    },
    async insertAssignment(conn, a) {
      const id = nextAssign++;
      state.assignments.push({ biomax_device_assignment_id: id, effective_to: null, ...a });
      return id;
    },
    async closeAssignment(conn, id, effective_to) {
      const a = state.assignments.find((x) => x.biomax_device_assignment_id === id);
      if (a && a.effective_to === null) a.effective_to = effective_to;
    },
    async insertEvent(conn, e) {
      state.events.push(e);
    },
  };
  return repo;
}

const admin = { employeeId: 1 };

describe("normaliseDateTime", () => {
  it("accepts a date or a date-time and returns YYYY-MM-DD HH:MM:SS", () => {
    assert.equal(normaliseDateTime("2026-09-01", "x"), "2026-09-01 00:00:00");
    assert.equal(normaliseDateTime("2026-09-15 12:30", "x"), "2026-09-15 12:30:00");
    assert.equal(normaliseDateTime("2026-09-15T12:30:05", "x"), "2026-09-15 12:30:05");
  });
  it("rejects nonsense", () => {
    for (const bad of ["", "15/09/2026", "2026-02-30", "2026-09-15 25:00", null]) {
      assert.throws(() => normaliseDateTime(bad, "effective_from"), /effective_from/);
    }
  });
});

describe("create (Add Device)", () => {
  let repo;
  let uc;
  beforeEach(() => {
    repo = fakeRepo();
    uc = build(repo);
  });

  it("registers the Cloud ID VERBATIM with its first period, and writes two events", async () => {
    const r = await uc.create({ dev_id: "C26924B2E7351O35", label: "DN1", outlet_id: 3, effective_from: "2026-09-01" }, admin);
    assert.equal(r.code, 200);
    assert.equal(repo.state.devices[0].dev_id, "C26924B2E7351O35", "letter O kept");
    assert.deepEqual(repo.state.assignments[0], {
      biomax_device_assignment_id: 1, biomax_device_id: 1, outlet_id: 3,
      effective_from: "2026-09-01 00:00:00", effective_to: null, note: null, created_by: 1,
    });
    assert.deepEqual(repo.state.events.map((e) => e.event_type), ["created", "assignment_opened"]);
  });

  it("requires a location and an effective_from every time - no default date", async () => {
    await assert.rejects(() => uc.create({ dev_id: "AMDB24121401307", label: "G2", effective_from: "2026-09-01" }, admin), /outlet_id is required/);
    await assert.rejects(() => uc.create({ dev_id: "AMDB24121401307", label: "G2", outlet_id: 2 }, admin), /effective_from must be/);
  });

  it("refuses a duplicate Cloud ID and points at the replacement procedure", async () => {
    await uc.create({ dev_id: "AMDB24121401307", label: "G2", outlet_id: 2, effective_from: "2026-09-01" }, admin);
    await assert.rejects(
      () => uc.create({ dev_id: "AMDB24121401307", label: "G2 again", outlet_id: 2, effective_from: "2026-09-02" }, admin),
      /already registered[\s\S]*deactivate the old one and add the new Cloud ID/
    );
  });

  it("refuses an unknown outlet and a malformed Cloud ID", async () => {
    await assert.rejects(() => uc.create({ dev_id: "AMDB24121401307", label: "G2", outlet_id: 99, effective_from: "2026-09-01" }, admin), /outlet_id 99 does not exist/);
    await assert.rejects(() => uc.create({ dev_id: "bad id!", label: "x", outlet_id: 2, effective_from: "2026-09-01" }, admin), /Cloud ID/);
  });

  it("two devices may share one outlet (WH and G2 at the warehouse)", async () => {
    await uc.create({ dev_id: "C2695C56D30E1430", label: "WH", outlet_id: 2, effective_from: "2026-09-01" }, admin);
    await uc.create({ dev_id: "AMDB24121401307", label: "G2", outlet_id: 2, effective_from: "2026-09-01" }, admin);
    assert.equal(repo.state.assignments.filter((a) => a.outlet_id === 2 && a.effective_to === null).length, 2);
  });
});

describe("assign (Move / Reactivate)", () => {
  let repo;
  let uc;
  beforeEach(async () => {
    repo = fakeRepo();
    uc = build(repo);
    await uc.create({ dev_id: "C2695C56D30E1430", label: "WH", outlet_id: 2, effective_from: "2026-09-01" }, admin);
  });

  it("moving closes the open period at the move time and opens the new one from the same instant", async () => {
    await uc.assign({ biomax_device_id: 1, outlet_id: 4, effective_from: "2026-09-15 12:00" }, admin);
    const [first, second] = repo.state.assignments;
    assert.equal(first.effective_to, "2026-09-15 12:00:00");
    assert.equal(second.outlet_id, 4);
    assert.equal(second.effective_from, "2026-09-15 12:00:00");
    assert.equal(second.effective_to, null);
    assert.deepEqual(repo.state.events.slice(-2).map((e) => e.event_type), ["assignment_closed", "assignment_opened"]);
    assert.equal(repo.state.events[repo.state.events.length - 2].detail.reason, "moved");
  });

  it("never rewrites the earlier period - history is closed, not edited", async () => {
    await uc.assign({ biomax_device_id: 1, outlet_id: 4, effective_from: "2026-09-15 12:00" }, admin);
    assert.equal(repo.state.assignments[0].outlet_id, 2);
    assert.equal(repo.state.assignments[0].effective_from, "2026-09-01 00:00:00");
    assert.equal(repo.state.assignments.length, 2);
  });

  it("refuses an overlapping period and one that starts before the current period", async () => {
    await uc.assign({ biomax_device_id: 1, outlet_id: 4, effective_from: "2026-09-15 12:00" }, admin);
    await assert.rejects(() => uc.assign({ biomax_device_id: 1, outlet_id: 5, effective_from: "2026-09-10" }, admin), /overlaps the period/);
    await assert.rejects(() => uc.assign({ biomax_device_id: 1, outlet_id: 5, effective_from: "2026-09-15 12:00" }, admin), /must be after the current period's start/);
  });

  it("refuses moving to the outlet it is already at", async () => {
    await assert.rejects(() => uc.assign({ biomax_device_id: 1, outlet_id: 2, effective_from: "2026-09-20" }, admin), /already assigned to that outlet/);
  });

  it("closing before the device's last punch needs explicit confirmation (it would quarantine those punches)", async () => {
    repo.state.lastPunch["C2695C56D30E1430"] = "2026-09-18 10:00:00";
    await assert.rejects(
      () => uc.assign({ biomax_device_id: 1, outlet_id: 4, effective_from: "2026-09-15" }, admin),
      (err) => err.needs_confirmation === true && /INACTIVE_DEVICE/.test(err.message) && err.last_punch_at === "2026-09-18 10:00:00"
    );
    const ok = await uc.assign({ biomax_device_id: 1, outlet_id: 4, effective_from: "2026-09-15", confirm_before_last_punch: true }, admin);
    assert.equal(ok.code, 200);
  });

  it("reactivates a deactivated device by opening a new period", async () => {
    await uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-20" }, admin);
    await uc.assign({ biomax_device_id: 1, outlet_id: 2, effective_from: "2026-09-25" }, admin);
    const periods = repo.state.assignments;
    assert.equal(periods.length, 2);
    assert.equal(periods[0].effective_to, "2026-09-20 00:00:00");
    assert.equal(periods[1].effective_from, "2026-09-25 00:00:00");
    // The gap 20th..25th has no period: punches there resolve INACTIVE_DEVICE.
  });
});

describe("deactivate", () => {
  let repo;
  let uc;
  beforeEach(async () => {
    repo = fakeRepo();
    uc = build(repo);
    await uc.create({ dev_id: "C2695C56D30E1430", label: "WH", outlet_id: 2, effective_from: "2026-09-01" }, admin);
  });

  it("closes the open period with no successor and records why", async () => {
    await uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-20 18:00", note: "screen broken" }, admin);
    assert.equal(repo.state.assignments[0].effective_to, "2026-09-20 18:00:00");
    const ev = repo.state.events[repo.state.events.length - 1];
    assert.equal(ev.event_type, "assignment_closed");
    assert.equal(ev.detail.reason, "deactivated");
    assert.equal(ev.detail.note, "screen broken");
  });

  it("refuses when already inactive, or when effective_to precedes the period start", async () => {
    await assert.rejects(() => uc.deactivate({ biomax_device_id: 1, effective_to: "2026-08-01" }, admin), /must be after the period's start/);
    await uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-20" }, admin);
    await assert.rejects(() => uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-21" }, admin), /already inactive/);
  });

  it("REPLACEMENT: the old Cloud ID stays; the new unit is a new device", async () => {
    await uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-20" }, admin);
    await uc.create({ dev_id: "NEWUNIT0001", label: "WH (replacement)", outlet_id: 2, effective_from: "2026-09-20" }, admin);
    assert.equal(repo.state.devices.length, 2);
    assert.equal(repo.state.devices[0].dev_id, "C2695C56D30E1430", "old Cloud ID untouched");
    assert.equal(repo.state.devices[1].dev_id, "NEWUNIT0001");
  });
});

describe("Cloud ID", () => {
  let repo;
  let uc;
  beforeEach(async () => {
    repo = fakeRepo();
    uc = build(repo);
    await uc.create({ dev_id: "C2695C56D30E143O", label: "WH", outlet_id: 2, effective_from: "2026-09-01" }, admin);
  });

  it("is not editable through update-details", async () => {
    await assert.rejects(() => uc.updateDetails({ biomax_device_id: 1, dev_id: "X" }, admin), /Cloud ID cannot be changed here/);
  });

  it("update-details changes label/notes and records each change", async () => {
    await uc.updateDetails({ biomax_device_id: 1, label: "Warehouse - WH", notes: "near gate" }, admin);
    assert.equal(repo.state.devices[0].label, "Warehouse - WH");
    assert.deepEqual(repo.state.events.slice(-2).map((e) => e.event_type), ["label_changed", "notes_changed"]);
    assert.deepEqual(repo.state.events[repo.state.events.length - 2].detail, { from: "WH", to: "Warehouse - WH" });
  });

  it("can be corrected with a reason before any punch, and is audited", async () => {
    await uc.correctCloudId({ biomax_device_id: 1, dev_id: "C2695C56D30E1430", reason: "typed O for 0" }, admin);
    assert.equal(repo.state.devices[0].dev_id, "C2695C56D30E1430");
    const ev = repo.state.events[repo.state.events.length - 1];
    assert.equal(ev.event_type, "dev_id_corrected");
    assert.deepEqual(ev.detail, { from: "C2695C56D30E143O", to: "C2695C56D30E1430", reason: "typed O for 0" });
  });

  it("cannot be corrected once the device has punched, and never without a reason", async () => {
    await assert.rejects(() => uc.correctCloudId({ biomax_device_id: 1, dev_id: "C2695C56D30E1430" }, admin), /reason is required/);
    repo.state.lastPunch["C2695C56D30E143O"] = "2026-09-10 13:57:41";
    await assert.rejects(
      () => uc.correctCloudId({ biomax_device_id: 1, dev_id: "C2695C56D30E1430", reason: "typo" }, admin),
      /already punched[\s\S]*Add the correct Cloud ID as a new device/
    );
  });

  it("cannot be corrected to another device's Cloud ID", async () => {
    await uc.create({ dev_id: "AMDB24121401307", label: "G2", outlet_id: 2, effective_from: "2026-09-01" }, admin);
    await assert.rejects(() => uc.correctCloudId({ biomax_device_id: 1, dev_id: "AMDB24121401307", reason: "x" }, admin), /belongs to another device/);
  });
});

describe("details", () => {
  it("returns the device with periods, parsed events and a derived status", async () => {
    const repo = fakeRepo();
    const uc = build(repo);
    await uc.create({ dev_id: "C2695C56D30E1430", label: "WH", outlet_id: 2, effective_from: "2026-09-01" }, admin);
    const d = await uc.details(1);
    assert.equal(d.status, "ACTIVE");
    assert.equal(d.current_assignment.outlet_id, 2);
    assert.equal(d.assignments.length, 1);
    assert.equal(d.events.length, 2);
    await uc.deactivate({ biomax_device_id: 1, effective_to: "2026-09-20" }, admin);
    assert.equal((await uc.details(1)).status, "INACTIVE");
    await assert.rejects(() => uc.details(99), /Device not found/);
  });
});
