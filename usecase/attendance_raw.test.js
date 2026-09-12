/**
 * Attendance List and Punch Audit - grouping, filtering and what is refused.
 *
 *   node --test usecase/attendance_raw.test.js
 *
 * The repository is faked with rows in the exact shape repository/
 * biomax_punch.js SELECTs. These are the cross-outlet cases the business
 * confirmed: one employee, one attendance date, one row, whichever
 * terminals saw them; device filters only on the audit; quarantine of
 * unregistered / inactive devices; no attendance calculation anywhere.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./attendance_raw");
const { pivot, toDisplayDate, MAX_LIST_DAYS, MAX_AUDIT_DAYS } = require("./attendance_raw");

/** One repository row, as the SELECT returns it (strings for every time). */
function row(o) {
  return {
    biomax_punch_id: o.id || 1,
    dev_id: o.dev_id || "C2695C56D30E1430",
    user_id: o.user_id || "1952",
    io_time_raw: (o.date || "2026-09-15").replace(/-/g, "") + (o.time || "09:05:12").replace(/:/g, ""),
    io_time: `${o.date || "2026-09-15"} ${o.time || "09:05:12"}`,
    clock_time: o.time || "09:05:12",
    calendar_date: o.date || "2026-09-15",
    source_ip: "103.213.194.119",
    retransmit_count: 0,
    received_at: "2026-09-15 09:08:40",
    attendance_date: o.attendance_date === undefined ? o.date || "2026-09-15" : o.attendance_date,
    derivation_status: o.status || "OK",
    employee_id: o.employee_id === undefined ? 1952 : o.employee_id,
    home_outlet_id: o.home_outlet_id === undefined ? 2 : o.home_outlet_id,
    department_id: 4,
    work_shift_id: 7,
    cutoff_applied: "04:00:00",
    employee_name: o.employee_name === undefined ? "Ravi" : o.employee_name,
    employee_status: 1,
    department_name: "Warehouse Ops",
    home_outlet: o.home_outlet === undefined ? "Warehouse" : o.home_outlet,
    home_outlet_code: o.home_outlet_code === undefined ? "DNHO" : o.home_outlet_code,
    biomax_device_id: o.device_status === "UNREGISTERED_DEVICE" ? null : 6,
    device_label: o.device_label || "WH",
    punch_outlet_id: o.punch_outlet_id === undefined ? 2 : o.punch_outlet_id,
    punch_outlet: o.punch_outlet || "Warehouse",
    punch_outlet_code: o.punch_outlet_code || "DNHO",
    device_status: o.device_status || "REGISTERED",
  };
}

const wh = (time, extra = {}) => row({ time, dev_id: "C2695C56D30E1430", punch_outlet_id: 2, punch_outlet: "Warehouse", punch_outlet_code: "DNHO", device_label: "WH", ...extra });
const dn2 = (time, extra = {}) => row({ time, dev_id: "C2695C935328OB31", punch_outlet_id: 4, punch_outlet: "DN2", punch_outlet_code: "DN2", device_label: "DN2", ...extra });

function fakeRepo(rows, summary) {
  const calls = [];
  return {
    calls,
    async listDated(f) {
      calls.push(["listDated", f]);
      return rows;
    },
    async listPunches(f) {
      calls.push(["listPunches", f]);
      return rows;
    },
    async summary(f) {
      calls.push(["summary", f]);
      return summary || { groups: [], unregistered: [] };
    },
  };
}

describe("pivot - cross-outlet grouping (R11)", () => {
  it("Warehouse -> DN2 -> DN2 -> Warehouse is ONE row with four chronological times and their locations", () => {
    const { data, maxPunchCount, quarantined } = pivot([
      wh("09:05:12", { id: 1 }), dn2("14:10:40", { id: 2 }), dn2("16:00:03", { id: 3 }), wh("20:15:55", { id: 4 }),
    ]);
    assert.equal(data.length, 1);
    const r = data[0];
    assert.equal(r.employee_id, 1952);
    assert.equal(r.clock_date, "2026-09-15");
    assert.equal(r.home_outlet_code, "DNHO");
    assert.equal(r.punch_count, 4);
    assert.deepEqual(r.punches.map((p) => p.time), ["09:05:12", "14:10:40", "16:00:03", "20:15:55"]);
    assert.deepEqual(r.punches.map((p) => p.punch_outlet_code), ["DNHO", "DN2", "DN2", "DNHO"]);
    assert.deepEqual(r.distinct_punch_outlets, ["DNHO", "DN2"]);
    assert.equal(r.quarantined_punch_count, 0);
    assert.equal(maxPunchCount, 4);
    assert.equal(quarantined, 0);
    // Nothing interpreted: no in/out, hours, or status on the row.
    for (const k of Object.keys(r)) assert.doesNotMatch(k, /in_time|out_time|worked|hours|late|early|attendance_status|present|absent/i);
    assert.ok(!("at_home_outlet" in r.punches[0]), "no home-vs-away marker (neutral display)");
  });

  it("HR visiting three outlets: one row, five times, four distinct outlets", () => {
    const punches = [
      row({ time: "09:30:00", punch_outlet_code: "DNHO" }),
      row({ time: "11:00:00", punch_outlet_code: "DN1", punch_outlet_id: 3 }),
      row({ time: "13:30:00", punch_outlet_code: "DN3", punch_outlet_id: 5 }),
      row({ time: "16:45:00", punch_outlet_code: "DN5", punch_outlet_id: 7 }),
      row({ time: "19:00:00", punch_outlet_code: "DNHO" }),
    ];
    const { data, maxPunchCount } = pivot(punches);
    assert.equal(data.length, 1);
    assert.equal(data[0].punch_count, 5);
    assert.deepEqual(data[0].distinct_punch_outlets, ["DNHO", "DN1", "DN3", "DN5"]);
    assert.equal(maxPunchCount, 5);
  });

  it("sales manager with arrival-only punches at three stores, never at home: one row, three times, nothing flagged", () => {
    const { data } = pivot([
      row({ time: "10:00:00", punch_outlet_code: "DN2" }),
      row({ time: "12:00:00", punch_outlet_code: "DN4" }),
      row({ time: "15:00:00", punch_outlet_code: "DN5" }),
    ]);
    assert.equal(data.length, 1);
    assert.equal(data[0].punch_count, 3);
    assert.equal(data[0].quarantined_punch_count, 0);
  });

  it("two devices at different outlets in the same minute: both kept, no collapse", () => {
    const { data } = pivot([dn2("14:10:05"), row({ time: "14:10:50", punch_outlet_code: "DN3", punch_outlet_id: 5 })]);
    assert.equal(data[0].punch_count, 2);
  });

  it("two employees on the same devices and day are two rows; punches never cross", () => {
    const { data } = pivot([
      wh("09:00:00", { employee_id: 1952, user_id: "1952" }),
      wh("09:01:00", { employee_id: 2001, user_id: "2001", employee_name: "Meena" }),
      wh("18:00:00", { employee_id: 2001, user_id: "2001", employee_name: "Meena" }),
    ].sort((a, b) => a.employee_id - b.employee_id || a.io_time.localeCompare(b.io_time)));
    assert.equal(data.length, 2);
    assert.equal(data.find((r) => r.employee_id === 1952).punch_count, 1);
    assert.equal(data.find((r) => r.employee_id === 2001).punch_count, 2);
  });

  it("the same employee on two attendance dates is two rows", () => {
    const { data } = pivot([wh("22:05:00", { date: "2026-09-14", attendance_date: "2026-09-14" }), wh("02:00:00", { date: "2026-09-15", attendance_date: "2026-09-14" }), wh("22:10:00", { date: "2026-09-15", attendance_date: "2026-09-15" })]);
    assert.equal(data.length, 2);
    assert.equal(data[0].clock_date, "2026-09-14");
    assert.equal(data[0].punch_count, 2, "the after-midnight punch belongs to Monday's row");
    assert.equal(data[0].punches[1].calendar_date, "2026-09-15");
    assert.equal(data[1].punch_count, 1);
  });

  it("the group key never includes the device: four distinct devices and outlets still make one row", () => {
    const { data } = pivot([
      row({ time: "09:00:00", dev_id: "A", punch_outlet_id: 3, punch_outlet_code: "DN1" }),
      row({ time: "10:00:00", dev_id: "B", punch_outlet_id: 4, punch_outlet_code: "DN2" }),
      row({ time: "11:00:00", dev_id: "C", punch_outlet_id: 5, punch_outlet_code: "DN3" }),
      row({ time: "12:00:00", dev_id: "D", punch_outlet_id: 6, punch_outlet_code: "DN4" }),
    ]);
    assert.equal(data.length, 1);
    assert.equal(data[0].punch_count, 4);
  });
});

describe("pivot - quarantine (D6, D8)", () => {
  it("a punch from an unregistered device is left out of the row and counted", () => {
    const { data, quarantined } = pivot([
      wh("09:05:12"), row({ time: "12:00:00", dev_id: "UNKNOWN01", device_status: "UNREGISTERED_DEVICE", punch_outlet_id: null, punch_outlet_code: null }),
      dn2("14:10:40"), dn2("16:00:03"), wh("20:15:55"),
    ]);
    assert.equal(data.length, 1);
    assert.equal(data[0].punch_count, 4);
    assert.equal(data[0].quarantined_punch_count, 1);
    assert.deepEqual(data[0].punches.map((p) => p.time), ["09:05:12", "14:10:40", "16:00:03", "20:15:55"]);
    assert.equal(quarantined, 1);
  });

  it("a punch from a registered but inactive device (no period at its time) is quarantined the same way", () => {
    const { data } = pivot([wh("09:05:12"), wh("18:00:00", { device_status: "INACTIVE_DEVICE", punch_outlet_id: null })]);
    assert.equal(data[0].punch_count, 1);
    assert.equal(data[0].quarantined_punch_count, 1);
  });

  it("once the device is registered (status REGISTERED at read time) the punch appears in place with no reprocessing", () => {
    const { data } = pivot([wh("09:05:12"), row({ time: "12:00:00", dev_id: "UNKNOWN01", device_status: "REGISTERED", punch_outlet_id: 4, punch_outlet_code: "DN2" }), dn2("14:10:40")]);
    assert.equal(data[0].punch_count, 3);
    assert.equal(data[0].punches[1].punch_outlet_code, "DN2");
    assert.equal(data[0].quarantined_punch_count, 0);
  });
});

describe("Attendance List filters (R12, R14)", () => {
  const uc = () => build(fakeRepo([]));

  it("requires from/to, rejects reversed and over-long ranges", () => {
    assert.throws(() => uc().listFilters({}), /from and to are required/);
    assert.throws(() => uc().listFilters({ from: "2026-09-10", to: "2026-09-09" }), /to must not be before from/);
    assert.throws(() => uc().listFilters({ from: "2026-01-01", to: "2026-06-01" }), new RegExp(`at most ${MAX_LIST_DAYS} days`));
    assert.throws(() => uc().listFilters({ from: "10/09/2026", to: "10/09/2026" }), /YYYY-MM-DD/);
  });

  it("REJECTS device and punch-location parameters with a message naming the Punch Audit", () => {
    for (const bad of ["dev_id", "punch_outlet_id", "device_status", "outlet_id", "location"]) {
      assert.throws(
        () => uc().listFilters({ from: "2026-09-15", to: "2026-09-15", [bad]: "x" }),
        /not an Attendance List filter[\s\S]*Punch Audit/
      );
    }
  });

  it("passes home_outlet_id, department_id and search through, and nothing about devices", async () => {
    const repo = fakeRepo([]);
    await build(repo).list({ from: "2026-09-15", to: "2026-09-15", home_outlet_id: "2", department_id: "4", search: " 1952 " });
    const [, f] = repo.calls.find((c) => c[0] === "listDated");
    assert.deepEqual(f, { from: "2026-09-15", to: "2026-09-15", home_outlet_id: 2, department_id: 4, search: "1952" });
  });

  it("the Home Outlet filter is a ROW filter: the repository receives it, and a returned row keeps all its punches", async () => {
    // The repository applies d.home_outlet_id = 2; the DN2 punches of a
    // warehouse employee are still in the row it returns.
    const repo = fakeRepo([wh("09:05:12"), dn2("14:10:40"), dn2("16:00:03"), wh("20:15:55")]);
    const { data, meta } = await build(repo).list({ from: "2026-09-15", to: "2026-09-15", home_outlet_id: 2 });
    assert.equal(data.length, 1);
    assert.equal(data[0].punch_count, 4);
    assert.equal(meta.max_punch_count, 4);
  });

  it("meta carries the counts the banners need", async () => {
    const repo = fakeRepo([wh("09:05:12")], {
      groups: [
        { derivation_status: "OK", device_status: "REGISTERED", punches: 10 },
        { derivation_status: "NO_SHIFT", device_status: "REGISTERED", punches: 3 },
        { derivation_status: "UNMATCHED", device_status: "REGISTERED", punches: 2 },
        { derivation_status: "MISSING_CUTOFF", device_status: "REGISTERED", punches: 1 },
        { derivation_status: "OK", device_status: "UNREGISTERED_DEVICE", punches: 4 },
      ],
      unregistered: [{ dev_id: "UNKNOWN01" }],
    });
    const { meta } = await build(repo).list({ from: "2026-09-15", to: "2026-09-15" });
    assert.equal(meta.no_shift_punches, 3);
    assert.equal(meta.unmatched_punches, 2);
    assert.equal(meta.missing_cutoff_punches, 1);
    assert.equal(meta.undated_punches, 6);
    assert.equal(meta.unregistered_device_punches, 4);
    assert.deepEqual(meta.unregistered_devices, ["UNKNOWN01"]);
  });
});

describe("Punch Audit (R14)", () => {
  it("accepts device, punch location, status and review filters, capped at 31 days and 1000 rows", async () => {
    const repo = fakeRepo([dn2("14:10:40"), dn2("16:00:03")]);
    const uc = build(repo);
    const { data, meta } = await uc.audit({ from: "2026-09-15", to: "2026-09-15", punch_outlet_id: "4", limit: "50" });
    const [, f] = repo.calls.find((c) => c[0] === "listPunches");
    assert.equal(f.punch_outlet_id, 4);
    assert.equal(f.limit, 50);
    assert.equal(meta.row_count, 2);
    // Punch rows, not attendance rows.
    assert.ok(!("punches" in data[0]) && !("punch_count" in data[0]));
    assert.equal(data[0].home_outlet_code, "DNHO");
    assert.equal(data[0].match_status, "MATCHED");
    assert.equal(data[0].device_status, "REGISTERED");

    assert.throws(() => uc.auditFilters({ from: "2026-08-01", to: "2026-09-15" }), new RegExp(`${MAX_AUDIT_DAYS} days`));
    assert.throws(() => uc.auditFilters({ from: "2026-09-15", to: "2026-09-15", limit: 5000 }), /limit must be/);
    assert.throws(() => uc.auditFilters({ from: "2026-09-15", to: "2026-09-15", device_status: "BROKEN" }), /device_status must be/);
    assert.throws(() => uc.auditFilters({ from: "2026-09-15", to: "2026-09-15", review: "maybe" }), /review must be/);
  });

  it("presents an undatable punch with its status and null date", async () => {
    const repo = fakeRepo([row({ time: "10:02:11", user_id: "7777", employee_id: null, employee_name: null, attendance_date: null, status: "UNMATCHED", home_outlet: null, home_outlet_code: null, home_outlet_id: null })]);
    const { data } = await build(repo).audit({ from: "2026-09-15", to: "2026-09-15", review: "needs_review" });
    assert.equal(data[0].attendance_date, null);
    assert.equal(data[0].derivation_status, "UNMATCHED");
    assert.equal(data[0].match_status, "UNMATCHED");
    assert.equal(data[0].user_id, "7777");
  });
});

describe("CSV (D5)", () => {
  it("Attendance List CSV: header width follows the filtered result, times only unless with_locations", async () => {
    const repo = fakeRepo([wh("09:05:12"), dn2("14:10:40"), dn2("16:00:03"), wh("20:15:55")]);
    const csv = await build(repo).listCsv({ from: "2026-09-15", to: "2026-09-15" });
    assert.deepEqual(csv.header.slice(0, 5), ["Employee Code", "Employee Name", "Department", "Home Outlet", "Clock Date"]);
    assert.deepEqual(csv.header.slice(5, 9), ["Clock Time-1", "Clock Time-2", "Clock Time-3", "Clock Time-4"]);
    assert.deepEqual(csv.header.slice(9), ["Punches", "Quarantined"]);
    assert.deepEqual(csv.rows[0].slice(0, 9), ["1952", "Ravi", "Warehouse Ops", "Warehouse", "15/09/2026", "09:05:12", "14:10:40", "16:00:03", "20:15:55"]);
    assert.equal(csv.dataset_key, "RAW_ATTENDANCE");

    const withLoc = await build(repo).listCsv({ from: "2026-09-15", to: "2026-09-15", with_locations: "1" });
    assert.deepEqual(withLoc.rows[0].slice(5, 9), ["09:05:12 @DNHO", "14:10:40 @DN2", "16:00:03 @DN2", "20:15:55 @DNHO"]);
  });

  it("Punch Audit CSV is one row per punch with no pivot columns", async () => {
    const repo = fakeRepo([dn2("14:10:40"), dn2("16:00:03")]);
    const csv = await build(repo).auditCsv({ from: "2026-09-15", to: "2026-09-15", punch_outlet_id: 4 });
    assert.equal(csv.rows.length, 2);
    assert.ok(!csv.header.some((h) => /Clock Time-/.test(h)));
    assert.equal(csv.header[0], "Calendar Date");
    assert.equal(csv.dataset_key, "RAW_ATTENDANCE_PUNCHES");
  });

  it("recordExport writes shape only: no search string, never values", async () => {
    const entries = [];
    const uc = build(fakeRepo([]), { logExport: async (e) => entries.push(e) });
    await uc.recordExport({ dataset_key: "RAW_ATTENDANCE", header: ["a"], filters: { from: "x", to: "y", search: "Ravi" }, row_count: 3 }, { userId: 9, employeeId: 1 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].filters.search, undefined);
    assert.equal(entries[0].filters.search_used, true);
    assert.equal(entries[0].row_count, 3);
    assert.equal(entries[0].format, "csv");
  });

  it("dates display as DD/MM/YYYY", () => {
    assert.equal(toDisplayDate("2026-09-05"), "05/09/2026");
    assert.equal(toDisplayDate(null), "");
  });
});


/* ------------------------------------------------ effective status on the audit */

describe("Punch Audit - effective status, voids and ignored duplicates", () => {
  // The void columns the LEFT JOIN adds to the row.
  const voidedRow = (time, extra = {}) =>
    Object.assign(wh(time, extra), { attendance_punch_void_id: 31, void_reason: "Wrong employee punch", voided_by_employee_id: 7, voided_by_name: "HR Person", voided_at: "2026-09-16 10:00:00" });

  function repoWithStream(rows, stream) {
    const repo = fakeRepo(rows);
    repo.listPunchStreamForEmployees = async (f) => {
      repo.calls.push(["listPunchStreamForEmployees", f]);
      return stream;
    };
    return repo;
  }

  it("37/38. a voided punch is still returned, as VOIDED, with the reason, who and when", async () => {
    const rows = [wh("09:00:00", { id: 1 }), voidedRow("12:30:00", { id: 2 }), wh("21:00:00", { id: 3 })];
    const stream = rows.map((r) => ({ biomax_punch_id: r.biomax_punch_id, employee_id: r.employee_id, io_time: r.io_time, ingest_source: "LIVE", attendance_punch_void_id: r.attendance_punch_void_id || null }));
    const { data } = await build(repoWithStream(rows, stream)).audit({ from: "2026-09-15", to: "2026-09-15" });
    assert.equal(data.length, 3, "nothing is hidden");
    const v = data.find((p) => p.biomax_punch_id === 2);
    assert.equal(v.effective_status, "VOIDED");
    assert.equal(v.effective_reason, "Wrong employee punch");
    assert.equal(v.void_reason, "Wrong employee punch");
    assert.equal(v.voided_by_employee_id, 7);
    assert.equal(v.voided_by_name, "HR Person");
    assert.equal(v.voided_at, "2026-09-16 10:00:00");
    assert.equal(v.attendance_punch_void_id, 31);
    assert.deepEqual(data.filter((p) => p.biomax_punch_id !== 2).map((p) => p.effective_status), ["USED", "USED"]);
  });

  it("39. an automatically ignored duplicate is visible, marked IGNORED_DUPLICATE with the reason and the punch it duplicated", async () => {
    const rows = [wh("09:00:00", { id: 1 }), wh("09:04:00", { id: 2 }), wh("21:00:00", { id: 3 })];
    const stream = rows.map((r) => ({ biomax_punch_id: r.biomax_punch_id, employee_id: r.employee_id, io_time: r.io_time, ingest_source: "LIVE", attendance_punch_void_id: null }));
    const { data } = await build(repoWithStream(rows, stream)).audit({ from: "2026-09-15", to: "2026-09-15" });
    const dup = data.find((p) => p.biomax_punch_id === 2);
    assert.equal(dup.effective_status, "IGNORED_DUPLICATE");
    assert.equal(dup.effective_reason, "Duplicate punch within 10 minutes");
    assert.equal(dup.duplicate_of_punch_id, 1);
    assert.equal(dup.duplicate_of_io_time, "2026-09-15 09:00:00");
    assert.equal(dup.punch_source, "BIOMAX");
    assert.equal(dup.attendance_punch_void_id, null, "no fake manual audit record for an automatic suppression");
  });

  it("the stream is read from the day BEFORE the range, so a duplicate of yesterday's last kept punch is marked", async () => {
    const rows = [wh("00:04:00", { id: 2, calendar_date: "2026-09-16" })];
    const stream = [
      { biomax_punch_id: 1, employee_id: 1952, io_time: "2026-09-15 23:58:00", ingest_source: "LIVE", attendance_punch_void_id: null },
      { biomax_punch_id: 2, employee_id: 1952, io_time: "2026-09-16 00:04:00", ingest_source: "LIVE", attendance_punch_void_id: null },
    ];
    const repo = repoWithStream(rows, stream);
    const { data } = await build(repo).audit({ from: "2026-09-16", to: "2026-09-16" });
    assert.equal(data[0].effective_status, "IGNORED_DUPLICATE");
    const call = repo.calls.find((c) => c[0] === "listPunchStreamForEmployees")[1];
    assert.deepEqual(call, { employee_ids: [1952], from: "2026-09-15", to: "2026-09-16" });
  });

  it("an unmatched punch has no effective status, and no stream is read when nobody on the page is matched", async () => {
    const rows = [wh("09:00:00", { id: 1, employee_id: null })];
    const repo = repoWithStream(rows, []);
    const { data } = await build(repo).audit({ from: "2026-09-15", to: "2026-09-15" });
    assert.equal(data[0].effective_status, null);
    assert.ok(!repo.calls.some((c) => c[0] === "listPunchStreamForEmployees"));
  });

  it("the CSV carries the effective status and the void audit fields", async () => {
    const rows = [wh("09:00:00", { id: 1 }), voidedRow("12:30:00", { id: 2 })];
    const stream = rows.map((r) => ({ biomax_punch_id: r.biomax_punch_id, employee_id: r.employee_id, io_time: r.io_time, ingest_source: "LIVE", attendance_punch_void_id: r.attendance_punch_void_id || null }));
    const csv = await build(repoWithStream(rows, stream)).auditCsv({ from: "2026-09-15", to: "2026-09-15" });
    for (const h of ["Punch ID", "Source", "Effective Status", "Effective Reason", "Void Reason", "Voided By", "Voided At"]) assert.ok(csv.header.includes(h), h);
    const idx = (h) => csv.header.indexOf(h);
    assert.equal(csv.rows[0][idx("Effective Status")], "Used");
    assert.equal(csv.rows[1][idx("Effective Status")], "Voided");
    assert.equal(csv.rows[1][idx("Void Reason")], "Wrong employee punch");
    assert.equal(csv.rows[1][idx("Voided By")], "HR Person");
    assert.equal(csv.rows[1][idx("Voided At")], "2026-09-16 10:00:00");
    assert.equal(csv.rows[1][idx("Source")], "BIOMAX");
    // no unrelated personal data joined the export
    assert.ok(!csv.header.some((h) => /bank|aadhaar|pan|salary|phone/i.test(h)));
  });
});
