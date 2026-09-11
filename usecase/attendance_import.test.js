/**
 * Preview -> commit against an in-memory repository and an in-memory punch
 * store that behaves like the database: the device unique key
 * (dev_id, user_id, io_time_raw) and the import unique key
 * (source|user_id|io_time_raw for dev_id NULL) both raise ER_DUP_ENTRY.
 *
 *   node --test usecase/attendance_import.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const build = require("./attendance_import");
const { CLASS, OUTCOME } = require("./attendance_import");

async function xlsx(rows, headers) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance");
  ws.addRow(headers || ["Employee Code", "Employee Name", "Department Name", "Clock Date", "Clock Time-1", "Clock Time-2", "Clock Time-3"]);
  for (const r of rows) ws.addRow(r);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), originalname: "ATDDailyAttendance.xlsx", size: 1 };
}

/* ------------------------------------------------------ fakes (db-like) */

function fakeStore() {
  const punches = []; // {id, dev_id, user_id, io_time_raw, ingest_source, import_batch_id, derived}
  const employees = new Map([
    [1952, { employee_id: 1952, store_id: 2, department_id: 4, default_work_shift_id: 7 }], // shift 7: cutoff 04:00 every day
    [1641, { employee_id: 1641, store_id: 3, department_id: 4, default_work_shift_id: null }], // NO_SHIFT
    [1420, { employee_id: 1420, store_id: 3, department_id: 5, default_work_shift_id: 9 }], // shift 9: working, no cutoff
  ]);
  const schedule = (shift, dow) => {
    if (shift === 7) return { work_shift_weekly_schedule_id: 700 + dow, is_working_day: 1, attendance_day_cutoff: "04:00:00" };
    if (shift === 9) return { work_shift_weekly_schedule_id: 900 + dow, is_working_day: 1, attendance_day_cutoff: null };
    return null;
  };
  let next = 1;
  const store = {
    punches,
    calls: { findEmployee: 0, findScheduleRow: 0, insertPunch: 0 },
    failOn: null, // io_time_raw that throws a generic error on insert
    async findEmployee(id) {
      store.calls.findEmployee += 1;
      return employees.get(id) || null;
    },
    async findScheduleRow(shift, dow) {
      store.calls.findScheduleRow += 1;
      return schedule(shift, dow);
    },
    /** Same contract as biomax/store.js insertPunch, with the two unique keys enforced. */
    async insertPunch(punch, derived, options = {}) {
      store.calls.insertPunch += 1;
      if (store.failOn && punch.io_time_raw === store.failOn) throw new Error("ER_DATA_TOO_LONG: simulated");
      const source = options.source || "LIVE";
      const dev = source === "DIGISME_IMPORT" ? null : punch.dev_id;
      if (dev === null) {
        if (!options.importBatchId) throw new Error("a DIGISME_IMPORT punch must name its import_batch_id");
        const dup = punches.find((p) => p.dev_id === null && p.ingest_source === source && p.user_id === punch.user_id && p.io_time_raw === punch.io_time_raw);
        if (dup) return { outcome: "duplicate", biomax_punch_id: dup.id };
      } else {
        const dup = punches.find((p) => p.dev_id === dev && p.user_id === punch.user_id && p.io_time_raw === punch.io_time_raw);
        if (dup) {
          dup.retransmits = (dup.retransmits || 0) + 1;
          return { outcome: "duplicate", biomax_punch_id: null };
        }
      }
      const row = { id: next++, dev_id: dev, user_id: punch.user_id, io_time_raw: punch.io_time_raw, ingest_source: source, import_batch_id: options.importBatchId || null, derived, retransmits: 0 };
      punches.push(row);
      return { outcome: "stored", biomax_punch_id: row.id };
    },
  };
  return store;
}

function fakeRepo(store) {
  const batches = [];
  const items = [];
  let nextBatch = 1;
  let nextItem = 1;
  const repo = {
    batches,
    staged: items,
    async transaction(code, work) {
      return work({});
    },
    async existingImportKeys(userIds, fromRaw, toRaw) {
      return new Set(store.punches.filter((p) => p.dev_id === null && p.ingest_source === "DIGISME_IMPORT" && userIds.includes(p.user_id) && p.io_time_raw >= fromRaw && p.io_time_raw <= toRaw).map((p) => `${p.user_id}|${p.io_time_raw}`));
    },
    async existingCrossSource(employeeIds, fromRaw, toRaw) {
      const m = new Map();
      for (const p of store.punches) {
        if (p.ingest_source === "DIGISME_IMPORT") continue;
        if (!p.derived || !employeeIds.includes(p.derived.employee_id)) continue;
        if (p.io_time_raw < fromRaw || p.io_time_raw > toRaw) continue;
        const k = `${p.derived.employee_id}|${p.io_time_raw}`;
        if (!m.has(k)) m.set(k, p.id);
      }
      return m;
    },
    async insertBatch(conn, b) {
      const id = nextBatch++;
      batches.push({ import_batch_id: id, status: "PREVIEWED", ...b });
      return id;
    },
    async insertItems(conn, batchId, list) {
      for (const it of list) items.push({ import_item_id: nextItem++, import_batch_id: batchId, outcome: null, biomax_punch_id: null, ...it });
    },
    async claimForCommit(batchId) {
      const b = batches.find((x) => x.import_batch_id === batchId);
      if (!b || b.status !== "PREVIEWED") return false;
      b.status = "COMMITTING";
      return true;
    },
    async updateItemOutcome(itemId, o) {
      const it = items.find((i) => i.import_item_id === itemId);
      Object.assign(it, { outcome: o.outcome, biomax_punch_id: o.biomax_punch_id, message: o.message || it.message, collided_punch_id: it.collided_punch_id || o.collided_punch_id || null });
    },
    async finishBatch(batchId, f) {
      Object.assign(batches.find((x) => x.import_batch_id === batchId), f);
    },
    async list() {
      return batches;
    },
    async getById(id) {
      const b = batches.find((x) => x.import_batch_id === id);
      return b ? { ...b } : null;
    },
    async itemCounts(batchId) {
      const out = {};
      for (const i of items.filter((x) => x.import_batch_id === batchId)) {
        const k = `${i.classification}|${i.outcome}`;
        out[k] = out[k] || { classification: i.classification, outcome: i.outcome, n: 0 };
        out[k].n += 1;
      }
      return Object.values(out);
    },
    async unmatchedCodes(batchId) {
      const m = {};
      for (const i of items.filter((x) => x.import_batch_id === batchId && x.classification === CLASS.UNMATCHED_EMPLOYEE)) m[i.user_id] = (m[i.user_id] || 0) + 1;
      return Object.entries(m).map(([user_id, punches]) => ({ user_id, punches }));
    },
    async items(batchId, f = {}) {
      const rows = items.filter((x) => x.import_batch_id === batchId && (!f.classification || x.classification === f.classification) && (!f.outcome || x.outcome === f.outcome));
      const lim = f.limit || 200;
      const off = f.offset || 0;
      return { rows: rows.slice(off, off + lim), total: rows.length, limit: lim, offset: off };
    },
    async itemsForCommit(batchId) {
      return items.filter((x) => x.import_batch_id === batchId && x.outcome === null);
    },
  };
  return repo;
}

const ROWS = [
  ["1952", "Ravi", "Ops", "10-09-2026", "09:00:00", "13:00:00", "18:00:00"], // matched, shift 7 -> OK
  ["1952", "Ravi", "Ops", "11-09-2026", "02:30:00", undefined, undefined], // before 04:00 cutoff -> attendance 10-09
  ["1641", "Sita", "Ops", "10-09-2026", "09:30:00", undefined, undefined], // NO_SHIFT
  ["1420", "Anu", "Ops", "10-09-2026", "10:00:00", undefined, undefined], // MISSING_CUTOFF
  ["9999", "Ghost", "Ops", "10-09-2026", "08:00:00", "17:00:00", undefined], // UNMATCHED
  ["1952", "Ravi", "Ops", "32-09-2026", "09:00:00", undefined, undefined], // BAD_ROW (date)
  ["1952", "Ravi", "Ops", "12-09-2026", "09:00:00", "noon", undefined], // one good, one BAD cell
  ["1952", "Ravi", "Ops", "10-09-2026", "09:00:00", undefined, undefined], // in-file duplicate of row 1 cell 1
];

describe("preview", () => {
  let store;
  let repo;
  let uc;
  beforeEach(() => {
    store = fakeStore();
    repo = fakeRepo(store);
    uc = build(repo, store);
  });

  it("classifies every candidate, counts add up, and writes NOTHING to biomax_punch", async () => {
    const out = await uc.preview(await xlsx(ROWS), { employeeId: 1 });
    const b = out.batch;
    assert.equal(b.status, "PREVIEWED");
    assert.equal(b.original_filename, "ATDDailyAttendance.xlsx");
    assert.match(b.file_sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.sheet_name, "Attendance");
    assert.equal(b.time_columns, "Clock Time-1,Clock Time-2,Clock Time-3");
    assert.equal(b.excel_row_count, 8);
    assert.equal(b.employee_code_count, 4, "9999 counts as a code seen; the bad-date row's code still counts");
    assert.equal(b.candidate_count, 11, "non-empty Clock Time cells, bad-row cells excluded");
    assert.equal(b.valid_count, 7); // 1952 x3 (row1) + 1952 02:30 + 1641 NO_SHIFT + 1420 MISSING_CUTOFF + 1952 12-09 09:00
    assert.equal(b.unmatched_count, 2);
    assert.equal(b.bad_count, 2); // the bad-date row + the "noon" cell
    assert.equal(b.reimport_duplicate_count, 1);
    assert.equal(b.cross_source_collision_count, 0);
    assert.equal(b.date_from, "2026-09-10");
    assert.equal(b.date_to, "2026-09-12");
    assert.equal(b.uploaded_by, 1);
    assert.equal(store.punches.length, 0, "preview never inserts a punch");
    assert.equal(store.calls.insertPunch, 0);
    assert.deepEqual(out.unmatched_employee_codes, [{ user_id: "9999", punches: 2 }]);
    assert.deepEqual(out.classification_counts, { VALID: 7, UNMATCHED_EMPLOYEE: 2, BAD_ROW: 2, REIMPORT_DUPLICATE: 1 });
    // The 1641 NO_SHIFT punch is VALID for import (it is stored like a live punch would be)
    const noShift = repo.staged.find((i) => i.user_id === "1641");
    assert.equal(noShift.classification, CLASS.VALID);
    assert.equal(noShift.derivation_status, "NO_SHIFT");
  });

  it("reuses the live attendance-date rule: cutoff, NO_SHIFT, MISSING_CUTOFF, UNMATCHED, midnight", async () => {
    await uc.preview(await xlsx(ROWS), {});
    const by = (raw) => repo.staged.find((i) => i.io_time_raw === raw);
    assert.equal(by("20260910090000").attendance_date, "2026-09-10");
    assert.equal(by("20260911023000").attendance_date, "2026-09-10", "02:30 is before the 04:00 cutoff -> previous day");
    assert.equal(by("20260910093000").derivation_status, "NO_SHIFT");
    assert.equal(by("20260910100000").derivation_status, "MISSING_CUTOFF");
    assert.equal(by("20260910080000").derivation_status, "UNMATCHED");
    assert.equal(by("20260910080000").employee_id, null);
    assert.equal(store.calls.findEmployee <= 4, true, "employee lookups are cached per code");
  });

  it("keeps provenance on every item: Excel row, column, raw cells", async () => {
    await uc.preview(await xlsx(ROWS), {});
    const bad = repo.staged.filter((i) => i.classification === CLASS.BAD_ROW);
    assert.deepEqual(bad.map((i) => [i.excel_row, i.column_name]), [[7, null], [8, "Clock Time-2"]]);
    assert.equal(bad[0].raw_clock_date, "32-09-2026");
    assert.match(bad[0].message, /1 time cell/);
    assert.equal(bad[1].raw_clock_time, "noon");
    const dup = repo.staged.find((i) => i.classification === CLASS.REIMPORT_DUPLICATE);
    assert.equal(dup.excel_row, 9);
    assert.match(dup.message, /earlier in this file/);
  });

  it("refuses a non-xlsx name, an empty file, a non-zip, and a workbook without the Attendance sheet", async () => {
    await assert.rejects(uc.preview({ buffer: Buffer.from("PK"), originalname: "a.xls", size: 2 }, {}), /only \.xlsx/);
    await assert.rejects(uc.preview({ buffer: Buffer.alloc(0), originalname: "a.xlsx", size: 0 }, {}), /empty/);
    await assert.rejects(uc.preview({ buffer: Buffer.from("hello"), originalname: "a.xlsx", size: 5 }, {}), /not an \.xlsx workbook/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").addRow(["a"]);
    await assert.rejects(uc.preview({ buffer: Buffer.from(await wb.xlsx.writeBuffer()), originalname: "a.xlsx", size: 1 }, {}), (e) => e.name === "ValidationError" && /Attendance/.test(e.message));
    assert.equal(repo.batches.length, 0);
  });

  it("flags CROSS_SOURCE_COLLISION when a LIVE punch exists for the same employee at the same time, matched by identity not raw code", async () => {
    await store.insertPunch({ dev_id: "C2695C56D30E1430", user_id: "01952", io_time_raw: "20260910090000" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const out = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "09:00:00", "18:00:00", undefined]]), {});
    assert.equal(out.batch.cross_source_collision_count, 1);
    assert.equal(out.batch.valid_count, 1);
    const c = repo.staged.find((i) => i.classification === CLASS.CROSS_SOURCE_COLLISION);
    assert.equal(c.io_time_raw, "20260910090000");
    assert.equal(c.collided_punch_id, 1);
    assert.match(c.message, /device punch \(#1\)/);
  });

  it("does not treat a LIVE punch as a re-import duplicate, and does not treat an import as a collision", async () => {
    await store.insertPunch({ dev_id: "X", user_id: "1952", io_time_raw: "20260910090000" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const out = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "09:00:00", undefined, undefined]]), {});
    assert.equal(out.batch.reimport_duplicate_count, 0);
    assert.equal(out.batch.cross_source_collision_count, 1);
  });
});

describe("commit", () => {
  let store;
  let repo;
  let uc;
  beforeEach(() => {
    store = fakeStore();
    repo = fakeRepo(store);
    uc = build(repo, store);
  });

  it("imports from the staged batch: one punch per importable item, correct outcomes, batch counts", async () => {
    const pv = await uc.preview(await xlsx(ROWS), { employeeId: 1 });
    const out = await uc.commit(pv.batch.import_batch_id, { employeeId: 2 });
    assert.equal(out.batch.status, "COMMITTED");
    assert.equal(out.batch.imported_count, 9, "7 VALID + 2 UNMATCHED");
    assert.equal(out.batch.skipped_count, 3, "2 BAD + 1 REIMPORT");
    assert.equal(out.batch.failed_count, 0);
    assert.equal(store.punches.length, 9);
    for (const p of store.punches) {
      assert.equal(p.dev_id, null);
      assert.equal(p.ingest_source, "DIGISME_IMPORT");
      assert.equal(p.import_batch_id, pv.batch.import_batch_id);
    }
    assert.deepEqual(out.outcome_counts, { IMPORTED: 7, IMPORTED_UNMATCHED: 2, SKIPPED_BAD_ROW: 2, SKIPPED_REIMPORT_DUPLICATE: 1 });
    const unmatched = store.punches.find((p) => p.user_id === "9999");
    assert.equal(unmatched.derived.status, "UNMATCHED");
    assert.equal(unmatched.derived.employee_id, null);
    const dated = store.punches.find((p) => p.io_time_raw === "20260911023000");
    assert.equal(dated.derived.attendance_date, "2026-09-10");
    assert.equal(dated.derived.employee_id, 1952);
    assert.equal(dated.derived.home_outlet_id, 2);
    assert.ok(repo.staged.filter((i) => i.outcome === OUTCOME.IMPORTED).every((i) => i.biomax_punch_id));
  });

  it("a second commit of the same batch is refused with 409, and inserts nothing", async () => {
    const pv = await uc.preview(await xlsx(ROWS), {});
    await uc.commit(pv.batch.import_batch_id, {});
    const n = store.punches.length;
    await assert.rejects(uc.commit(pv.batch.import_batch_id, {}), (e) => e.httpCode === 409 && /COMMITTED/.test(e.message));
    assert.equal(store.punches.length, n);
    await assert.rejects(uc.commit(42, {}), (e) => e.httpCode === 404);
  });

  it("re-importing the same file: everything is REIMPORT_DUPLICATE at preview, nothing new at commit", async () => {
    const a = await uc.preview(await xlsx(ROWS), {});
    await uc.commit(a.batch.import_batch_id, {});
    const before = store.punches.length;
    const b = await uc.preview(await xlsx(ROWS), {});
    assert.equal(b.batch.reimport_duplicate_count, 10, "9 imported earlier + the in-file duplicate");
    assert.equal(b.batch.valid_count, 0);
    assert.equal(b.batch.unmatched_count, 0);
    const out = await uc.commit(b.batch.import_batch_id, {});
    assert.equal(out.batch.imported_count, 0);
    assert.equal(store.punches.length, before);
  });

  it("overlapping export under a different filename: old punches skipped, new ones imported, no duplicates", async () => {
    const first = await xlsx([["1952", "", "", "01-09-2026", "09:00:00", "18:00:00", undefined], ["1952", "", "", "11-09-2026", "09:00:00", undefined, undefined]]);
    const a = await uc.preview(first, {});
    await uc.commit(a.batch.import_batch_id, {});
    const second = await xlsx([["1952", "", "", "01-09-2026", "09:00:00", "18:00:00", undefined], ["1952", "", "", "11-09-2026", "09:00:00", undefined, undefined], ["1952", "", "", "15-09-2026", "09:00:00", "18:00:00", undefined]]);
    second.originalname = "export-01-to-15.xlsx";
    const b = await uc.preview(second, {});
    assert.equal(b.batch.reimport_duplicate_count, 3);
    assert.equal(b.batch.valid_count, 2);
    const out = await uc.commit(b.batch.import_batch_id, {});
    assert.equal(out.batch.imported_count, 2);
    assert.equal(store.punches.length, 5);
    assert.equal(new Set(store.punches.map((p) => `${p.user_id}|${p.io_time_raw}`)).size, 5);
  });

  it("a race the preview did not see is caught by the database key: SKIPPED_REIMPORT_DUPLICATE, no second row", async () => {
    const pv = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "09:00:00", undefined, undefined]]), {});
    // Another import lands the same punch between preview and commit.
    await store.insertPunch({ user_id: "1952", io_time_raw: "20260910090000" }, { status: "OK", employee_id: 1952 }, { source: "DIGISME_IMPORT", importBatchId: 99 });
    const out = await uc.commit(pv.batch.import_batch_id, {});
    assert.equal(out.batch.imported_count, 0);
    assert.equal(out.batch.skipped_count, 1);
    assert.equal(store.punches.length, 1);
    assert.equal(repo.staged[0].outcome, OUTCOME.SKIPPED_REIMPORT_DUPLICATE);
    assert.match(repo.staged[0].message, /database dedup/);
  });

  it("a cross-source collision is IMPORTED_WITH_COLLISION and the LIVE punch is untouched", async () => {
    await store.insertPunch({ dev_id: "C2695C56D30E1430", user_id: "1952", io_time_raw: "20260910101500" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const pv = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "10:15:00", undefined, undefined]]), {});
    const out = await uc.commit(pv.batch.import_batch_id, {});
    assert.equal(out.batch.imported_count, 1);
    assert.equal(store.punches.length, 2);
    const live = store.punches[0];
    assert.equal(live.dev_id, "C2695C56D30E1430");
    assert.equal(live.retransmits, 0, "the live row was not bumped or altered");
    assert.equal(store.punches[1].dev_id, null);
    assert.equal(repo.staged[0].outcome, OUTCOME.IMPORTED_WITH_COLLISION);
    assert.equal(repo.staged[0].collided_punch_id, 1);
  });

  it("no collision at preview, a live punch arrives before commit -> IMPORTED_WITH_COLLISION, collided id recorded, live punch untouched", async () => {
    const pv = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "10:15:00", undefined, undefined]]), {});
    assert.equal(pv.batch.cross_source_collision_count, 0);
    assert.equal(repo.staged[0].classification, CLASS.VALID);
    // The terminal delivers the same employee's punch at the same instant while HR looks at the preview.
    await store.insertPunch({ dev_id: "C2695C56D30E1430", user_id: "1952", io_time_raw: "20260910101500" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const liveBefore = JSON.stringify(store.punches[0]);
    const out = await uc.commit(pv.batch.import_batch_id, {});
    assert.equal(out.batch.imported_count, 1);
    assert.deepEqual(out.outcome_counts, { IMPORTED_WITH_COLLISION: 1 });
    assert.equal(repo.staged[0].classification, CLASS.VALID, "preview classification is history and stays");
    assert.equal(repo.staged[0].outcome, OUTCOME.IMPORTED_WITH_COLLISION);
    assert.equal(repo.staged[0].collided_punch_id, 1);
    assert.match(repo.staged[0].message, /when committed/);
    assert.equal(store.punches.length, 2, "the DigiSME punch was imported, not rejected");
    assert.equal(store.punches[1].dev_id, null);
    assert.equal(JSON.stringify(store.punches[0]), liveBefore, "the live punch is byte-for-byte untouched");
  });

  it("collision already seen at preview -> IMPORTED_WITH_COLLISION with the preview's collided id kept, even if that row is gone", async () => {
    await store.insertPunch({ dev_id: "C2695C56D30E1430", user_id: "1952", io_time_raw: "20260910101500" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const pv = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "10:15:00", undefined, undefined]]), {});
    assert.equal(repo.staged[0].classification, CLASS.CROSS_SOURCE_COLLISION);
    assert.equal(repo.staged[0].collided_punch_id, 1);
    // Append-only means this never happens in production; if it did, the preview record is not rewritten.
    store.punches.splice(0, 1);
    const out = await uc.commit(pv.batch.import_batch_id, {});
    assert.deepEqual(out.outcome_counts, { IMPORTED_WITH_COLLISION: 1 });
    assert.equal(repo.staged[0].classification, CLASS.CROSS_SOURCE_COLLISION);
    assert.equal(repo.staged[0].collided_punch_id, 1);
  });

  it("a DigiSME duplicate stays SKIPPED_REIMPORT_DUPLICATE even when a live punch also exists - collision is not dedup", async () => {
    const first = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "10:15:00", undefined, undefined]]), {});
    await uc.commit(first.batch.import_batch_id, {});
    await store.insertPunch({ dev_id: "C2695C56D30E1430", user_id: "1952", io_time_raw: "20260910101500" }, { employee_id: 1952, status: "OK" }, { source: "LIVE" });
    const second = await uc.preview(await xlsx([["1952", "", "", "10-09-2026", "10:15:00", undefined, undefined]]), {});
    assert.equal(second.batch.reimport_duplicate_count, 1);
    assert.equal(second.batch.cross_source_collision_count, 0);
    const out = await uc.commit(second.batch.import_batch_id, {});
    assert.deepEqual(out.outcome_counts, { SKIPPED_REIMPORT_DUPLICATE: 1 });
    assert.equal(store.punches.length, 2, "one import, one live - no second import row");
    // And a race duplicate (not seen at preview) with a live punch present is still a skip, with no collision id.
    const third = await uc.preview(await xlsx([["1641", "", "", "10-09-2026", "09:30:00", undefined, undefined]]), {});
    await store.insertPunch({ user_id: "1641", io_time_raw: "20260910093000" }, { status: "NO_SHIFT", employee_id: 1641 }, { source: "DIGISME_IMPORT", importBatchId: 77 });
    await store.insertPunch({ dev_id: "D", user_id: "1641", io_time_raw: "20260910093000" }, { employee_id: 1641, status: "NO_SHIFT" }, { source: "LIVE" });
    const out3 = await uc.commit(third.batch.import_batch_id, {});
    assert.deepEqual(out3.outcome_counts, { SKIPPED_REIMPORT_DUPLICATE: 1 });
    assert.equal(repo.staged.find((i) => i.user_id === "1641").collided_punch_id, null);
  });

  it("one failing item does not stop the batch: FAILED for that item, COMMITTED_WITH_ERRORS overall", async () => {
    const pv = await uc.preview(await xlsx(ROWS), {});
    store.failOn = "20260910130000";
    const out = await uc.commit(pv.batch.import_batch_id, {});
    assert.equal(out.batch.status, "COMMITTED_WITH_ERRORS");
    assert.equal(out.batch.failed_count, 1);
    assert.equal(out.batch.imported_count, 8);
    const failed = repo.staged.find((i) => i.outcome === OUTCOME.FAILED);
    assert.equal(failed.io_time_raw, "20260910130000");
    assert.match(failed.message, /simulated/);
  });

  it("a lost database connection stops the commit and marks the batch FAILED", async () => {
    const pv = await uc.preview(await xlsx(ROWS), {});
    store.insertPunch = async () => {
      const e = new Error("gone");
      e.code = "PROTOCOL_CONNECTION_LOST";
      throw e;
    };
    await assert.rejects(uc.commit(pv.batch.import_batch_id, {}), /gone/);
    assert.equal(repo.batches[0].status, "FAILED");
    assert.match(repo.batches[0].error_message, /gone/);
  });

  it("existing LIVE insertion and retransmission dedup are unchanged by the import store contract", async () => {
    const a = await store.insertPunch({ dev_id: "D", user_id: "1", io_time_raw: "20260910090000" }, {}, {});
    const b = await store.insertPunch({ dev_id: "D", user_id: "1", io_time_raw: "20260910090000" }, {}, {});
    assert.equal(a.outcome, "stored");
    assert.equal(b.outcome, "duplicate");
    assert.equal(store.punches[0].retransmits, 1);
  });
});

describe("reads", () => {
  it("items are paginated and filterable by classification; details carry counts and unmatched codes", async () => {
    const store = fakeStore();
    const repo = fakeRepo(store);
    const uc = build(repo, store);
    const pv = await uc.preview(await xlsx(ROWS), {});
    const page = await uc.items(pv.batch.import_batch_id, { classification: CLASS.VALID, limit: 2, offset: 0 });
    assert.equal(page.total, 7);
    assert.equal(page.rows.length, 2);
    await assert.rejects(uc.items(pv.batch.import_batch_id, { classification: "WHATEVER" }), /unknown classification/);
    const d = await uc.details(pv.batch.import_batch_id);
    assert.equal(d.classification_counts.BAD_ROW, 2);
    await assert.rejects(uc.details("x"), /positive integer/);
  });
});
