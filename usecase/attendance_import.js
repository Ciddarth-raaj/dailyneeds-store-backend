/**
 * DigiSME Excel attendance import - preview, then commit.
 *
 *   PREVIEW  parse the workbook, resolve every Employee Code against the
 *            employee master, derive each punch's attendance date with the
 *            SAME rule live punches use, classify every candidate, and
 *            write the batch + items to the staging tables. biomax_punch is
 *            NOT touched by a preview.
 *   COMMIT   from the staged items only (the file is never re-read):
 *            insert each importable item through biomax/store.js, the same
 *            write path as a live punch, one row per non-empty Clock Time
 *            cell. One bad item never stops the batch.
 *
 * Classification (preview)          Outcome (commit)
 *   VALID                            IMPORTED
 *   UNMATCHED_EMPLOYEE               IMPORTED_UNMATCHED   (kept, like a live unmatched punch)
 *   CROSS_SOURCE_COLLISION           IMPORTED_WITH_COLLISION (kept; the live punch is kept too)
 *   VALID, live punch arrived since    IMPORTED_WITH_COLLISION (rechecked at commit; the
 *     the preview                      preview classification is left as it was)
 *   REIMPORT_DUPLICATE               SKIPPED_REIMPORT_DUPLICATE
 *   BAD_ROW                          SKIPPED_BAD_ROW
 *   (any)                            FAILED  (database error on that item)
 *
 * Identity: Employee Code only, through biomax/employeeMatch.js. DigiSME's
 * Employee Name and Department Name are never read. Attendance date:
 * biomax/attendanceDate.js, unforked. Nothing computes IN/OUT, hours or pay.
 */
const crypto = require("crypto");
const fs = require("fs");

const { parseWorkbook, WorkbookError } = require("../biomax/digismeImport");
const { parseEmployeeCode } = require("../biomax/employeeMatch");
const { deriveAttendanceDate, calendarDates, STATUS } = require("../biomax/attendanceDate");
const { INGEST_SOURCE } = require("../biomax/store");

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const CLASS = Object.freeze({
  VALID: "VALID",
  UNMATCHED_EMPLOYEE: "UNMATCHED_EMPLOYEE",
  BAD_ROW: "BAD_ROW",
  REIMPORT_DUPLICATE: "REIMPORT_DUPLICATE",
  CROSS_SOURCE_COLLISION: "CROSS_SOURCE_COLLISION",
});
const OUTCOME = Object.freeze({
  IMPORTED: "IMPORTED",
  IMPORTED_UNMATCHED: "IMPORTED_UNMATCHED",
  IMPORTED_WITH_COLLISION: "IMPORTED_WITH_COLLISION",
  SKIPPED_REIMPORT_DUPLICATE: "SKIPPED_REIMPORT_DUPLICATE",
  SKIPPED_BAD_ROW: "SKIPPED_BAD_ROW",
  FAILED: "FAILED",
});
const IMPORTABLE = [CLASS.VALID, CLASS.UNMATCHED_EMPLOYEE, CLASS.CROSS_SOURCE_COLLISION];

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}
function conflict(message) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.httpCode = 409;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  err.httpCode = 404;
  return err;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const isoDate = (raw) => `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;

class AttendanceImportUsecase {
  /**
   * @param {object} repo   repository/attendance_import
   * @param {object} store  biomax/store createStore(pool) - findEmployee,
   *                        findScheduleRow, insertPunch: the live punch path
   */
  constructor(repo, store) {
    this.repo = repo;
    this.store = store;
  }

  /* ---------------------------------------------------------- resolution */

  /** Same identity and date rule as the receiver, with per-batch caches. */
  _resolver() {
    const employees = new Map();
    const schedules = new Map();
    const findEmployee = async (userId) => {
      const code = parseEmployeeCode(userId);
      if (code === null) return null;
      if (!employees.has(code)) employees.set(code, await this.store.findEmployee(code));
      return employees.get(code);
    };
    const derive = async (userId, ioTimeRaw) => {
      const employee = await findEmployee(userId);
      let row = null;
      if (employee && employee.default_work_shift_id !== null && employee.default_work_shift_id !== undefined) {
        const shift = Number(employee.default_work_shift_id);
        const { previousDayOfWeek } = calendarDates(ioTimeRaw);
        const key = `${shift}:${previousDayOfWeek}`;
        if (!schedules.has(key)) schedules.set(key, await this.store.findScheduleRow(shift, previousDayOfWeek));
        row = schedules.get(key);
      }
      const decision = deriveAttendanceDate({ ioTimeRaw, employee, readSchedule: () => row });
      return {
        employee,
        derived: {
          attendance_date: decision.attendance_date,
          status: decision.status,
          employee_id: employee ? employee.employee_id : null,
          home_outlet_id: employee ? (employee.store_id === undefined ? null : employee.store_id) : null,
          department_id: employee ? (employee.department_id === undefined ? null : employee.department_id) : null,
          work_shift_id: decision.work_shift_id,
          work_shift_weekly_schedule_id: decision.work_shift_weekly_schedule_id,
          cutoff_applied: decision.cutoff_applied,
        },
      };
    };
    return { findEmployee, derive };
  }

  /* -------------------------------------------------------------- preview */

  /**
   * @param {{path?: string, buffer?: Buffer, originalname: string, size: number}} file
   * @param {{employeeId?: number}} actor
   */
  async preview(file, actor) {
    if (!file) throw validationError("an .xlsx file is required");
    const name = String(file.originalname || "").trim();
    if (!/\.xlsx$/i.test(name)) throw validationError("only .xlsx files are accepted");
    const buffer = file.buffer || fs.readFileSync(file.path);
    if (buffer.length === 0) throw validationError("the file is empty");
    if (buffer.length > MAX_UPLOAD_BYTES) throw validationError(`the file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    // .xlsx is a zip: PK\x03\x04. Anything else is not a workbook.
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw validationError("the file is not an .xlsx workbook");

    let parsed;
    try {
      parsed = await parseWorkbook(buffer);
    } catch (err) {
      if (err instanceof WorkbookError) throw validationError(err.message);
      throw err;
    }

    const resolver = this._resolver();
    const items = [];
    const seenInFile = new Set();
    const counts = { valid: 0, bad: 0, unmatched: 0, reimport: 0, collision: 0 };

    for (const b of parsed.bad_rows) {
      counts.bad += 1;
      items.push({
        excel_row: b.excel_row, column_name: null, raw_employee_code: b.raw_employee_code, raw_clock_date: b.raw_clock_date,
        raw_clock_time: null, user_id: null, io_time_raw: null, employee_id: null, classification: CLASS.BAD_ROW,
        derivation_status: null, attendance_date: null, collided_punch_id: null,
        message: `${b.error}${b.time_cells ? ` (${b.time_cells} time cell(s) not imported)` : ""}`,
      });
    }

    const good = parsed.candidates.filter((c) => c.io_time_raw);
    for (const c of parsed.candidates.filter((x) => !x.io_time_raw)) {
      counts.bad += 1;
      items.push({ ...c, employee_id: null, classification: CLASS.BAD_ROW, derivation_status: null, attendance_date: null, collided_punch_id: null, message: c.error });
    }

    // Dedup lookups, bounded to the file's employees and time range.
    let existingImport = new Set();
    let crossSource = new Map();
    const resolvedEmployeeIds = new Set();
    const resolved = [];
    for (const c of good) {
      const r = await resolver.derive(c.user_id, c.io_time_raw);
      resolved.push({ c, r });
      if (r.employee) resolvedEmployeeIds.add(r.employee.employee_id);
    }
    if (good.length) {
      const raws = good.map((c) => c.io_time_raw).sort();
      existingImport = await this.repo.existingImportKeys([...new Set(good.map((c) => c.user_id))], raws[0], raws[raws.length - 1]);
      crossSource = await this.repo.existingCrossSource([...resolvedEmployeeIds], raws[0], raws[raws.length - 1]);
    }

    for (const { c, r } of resolved) {
      const key = `${c.user_id}|${c.io_time_raw}`;
      const base = {
        ...c, employee_id: r.employee ? r.employee.employee_id : null, derivation_status: r.derived.status,
        attendance_date: r.derived.attendance_date, collided_punch_id: null, message: null,
      };
      delete base.error;
      if (seenInFile.has(key)) {
        counts.reimport += 1;
        items.push({ ...base, classification: CLASS.REIMPORT_DUPLICATE, message: "same Employee Code and time appears earlier in this file" });
        continue;
      }
      seenInFile.add(key);
      if (existingImport.has(key)) {
        counts.reimport += 1;
        items.push({ ...base, classification: CLASS.REIMPORT_DUPLICATE, message: "already imported from DigiSME" });
        continue;
      }
      if (!r.employee) {
        counts.unmatched += 1;
        items.push({ ...base, classification: CLASS.UNMATCHED_EMPLOYEE, message: "Employee Code is not in the employee master" });
        continue;
      }
      const collided = crossSource.get(`${r.employee.employee_id}|${c.io_time_raw}`);
      if (collided) {
        counts.collision += 1;
        items.push({ ...base, classification: CLASS.CROSS_SOURCE_COLLISION, collided_punch_id: collided, message: `a device punch (#${collided}) exists for this employee at the same time` });
        continue;
      }
      counts.valid += 1;
      items.push({ ...base, classification: CLASS.VALID });
    }

    const batch = {
      original_filename: name.slice(0, 255),
      file_sha256: sha256(buffer),
      file_size_bytes: buffer.length,
      sheet_name: parsed.sheet_name,
      time_columns: parsed.time_columns.join(",").slice(0, 512),
      uploaded_by: actor && actor.employeeId !== undefined ? actor.employeeId : null,
      excel_row_count: parsed.excel_row_count,
      employee_code_count: parsed.employee_codes.length,
      candidate_count: parsed.candidate_count,
      valid_count: counts.valid,
      bad_count: counts.bad,
      unmatched_count: counts.unmatched,
      reimport_duplicate_count: counts.reimport,
      cross_source_collision_count: counts.collision,
      date_from: parsed.date_from,
      date_to: parsed.date_to,
    };

    const batchId = await this.repo.transaction("PREVIEW", async (conn) => {
      const id = await this.repo.insertBatch(conn, batch);
      await this.repo.insertItems(conn, id, items);
      return id;
    });

    return { code: 200, ...(await this.details(batchId)) };
  }

  /* --------------------------------------------------------------- commit */

  async commit(importBatchId, actor) {
    const batchId = this._id(importBatchId);
    const batch = await this.repo.getById(batchId);
    if (!batch) throw notFound("Import batch not found");
    if (batch.status !== "PREVIEWED") throw conflict(`batch is ${batch.status}; only a PREVIEWED batch can be committed`);
    const won = await this.repo.claimForCommit(batchId, actor && actor.employeeId !== undefined ? actor.employeeId : null);
    if (!won) throw conflict("batch is already being committed");

    const resolver = this._resolver();
    const tally = { imported: 0, skipped: 0, failed: 0 };
    let fatal = null;
    try {
      const items = await this.repo.itemsForCommit(batchId);

      // Re-resolve every importable item against the employee master AS IT
      // STANDS NOW (commit is the ingest), then recheck cross-source
      // collisions in one query: a live punch may have arrived for the same
      // employee and instant since the preview, and the final audit must say
      // so. Preview's classification is never rewritten - only the outcome
      // and, when preview did not see it, the collided punch id are added.
      const resolvedById = new Map();
      const employeeIds = new Set();
      let minRaw = null;
      let maxRaw = null;
      for (const it of items) {
        if (!IMPORTABLE.includes(it.classification)) continue;
        const r = await resolver.derive(it.user_id, it.io_time_raw);
        resolvedById.set(it.import_item_id, r);
        if (r.employee) employeeIds.add(r.employee.employee_id);
        if (minRaw === null || it.io_time_raw < minRaw) minRaw = it.io_time_raw;
        if (maxRaw === null || it.io_time_raw > maxRaw) maxRaw = it.io_time_raw;
      }
      const collisionsNow = employeeIds.size ? await this.repo.existingCrossSource([...employeeIds], minRaw, maxRaw) : new Map();

      for (const it of items) {
        let outcome;
        let punchId = null;
        let message = null;
        let collidedNow = null;
        try {
          if (it.classification === CLASS.BAD_ROW) {
            outcome = OUTCOME.SKIPPED_BAD_ROW;
          } else if (it.classification === CLASS.REIMPORT_DUPLICATE) {
            outcome = OUTCOME.SKIPPED_REIMPORT_DUPLICATE;
          } else if (IMPORTABLE.includes(it.classification)) {
            const r = resolvedById.get(it.import_item_id);
            if (r.employee) {
              const hit = collisionsNow.get(`${r.employee.employee_id}|${it.io_time_raw}`);
              if (hit && !it.collided_punch_id) collidedNow = hit;
            }
            const res = await this.store.insertPunch(
              { user_id: it.user_id, io_time_raw: it.io_time_raw },
              r.derived,
              { source: INGEST_SOURCE.DIGISME_IMPORT, importBatchId: batchId }
            );
            punchId = res.biomax_punch_id;
            if (res.outcome === "duplicate") {
              // Dedup wins: a duplicate is a duplicate whatever else exists.
              outcome = OUTCOME.SKIPPED_REIMPORT_DUPLICATE;
              message = "already imported (database dedup)";
              collidedNow = null;
            } else if (it.classification === CLASS.CROSS_SOURCE_COLLISION || it.collided_punch_id || collidedNow) {
              outcome = OUTCOME.IMPORTED_WITH_COLLISION;
              if (collidedNow) message = `a device punch (#${collidedNow}) existed for this employee at the same time when committed`;
            } else if (r.derived.status === STATUS.UNMATCHED) {
              outcome = OUTCOME.IMPORTED_UNMATCHED;
            } else {
              outcome = OUTCOME.IMPORTED;
            }
          } else {
            outcome = OUTCOME.FAILED;
            message = `unknown classification ${it.classification}`;
          }
        } catch (err) {
          if (isConnectionLoss(err)) {
            fatal = err;
            break;
          }
          outcome = OUTCOME.FAILED;
          message = String(err && err.message ? err.message : err).slice(0, 255);
          collidedNow = null;
        }
        if (outcome === OUTCOME.IMPORTED || outcome === OUTCOME.IMPORTED_UNMATCHED || outcome === OUTCOME.IMPORTED_WITH_COLLISION) tally.imported += 1;
        else if (outcome === OUTCOME.FAILED) tally.failed += 1;
        else tally.skipped += 1;
        await this.repo.updateItemOutcome(it.import_item_id, { outcome, biomax_punch_id: punchId, message, collided_punch_id: collidedNow });
      }
    } catch (err) {
      fatal = err;
    }

    const status = fatal ? "FAILED" : tally.failed > 0 ? "COMMITTED_WITH_ERRORS" : "COMMITTED";
    await this.repo.finishBatch(batchId, {
      status,
      imported_count: tally.imported,
      skipped_count: tally.skipped,
      failed_count: tally.failed,
      error_message: fatal ? String(fatal.message || fatal).slice(0, 255) : null,
    });
    if (fatal) throw fatal;
    return { code: 200, ...(await this.details(batchId)) };
  }

  /* ---------------------------------------------------------------- reads */

  list(filters = {}) {
    return this.repo.list({ limit: filters.limit });
  }

  async details(importBatchId) {
    const batchId = this._id(importBatchId);
    const batch = await this.repo.getById(batchId);
    if (!batch) throw notFound("Import batch not found");
    const [counts, unmatched] = await Promise.all([this.repo.itemCounts(batchId), this.repo.unmatchedCodes(batchId, 500)]);
    const byClass = {};
    const byOutcome = {};
    for (const c of counts) {
      byClass[c.classification] = (byClass[c.classification] || 0) + Number(c.n);
      if (c.outcome) byOutcome[c.outcome] = (byOutcome[c.outcome] || 0) + Number(c.n);
    }
    return { batch, classification_counts: byClass, outcome_counts: byOutcome, unmatched_employee_codes: unmatched };
  }

  async items(importBatchId, filters = {}) {
    const batchId = this._id(importBatchId);
    if (filters.classification && !Object.values(CLASS).includes(filters.classification)) throw validationError("unknown classification");
    if (filters.outcome && !Object.values(OUTCOME).includes(filters.outcome)) throw validationError("unknown outcome");
    return this.repo.items(batchId, filters);
  }

  _id(v) {
    const id = Number(v);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("import_batch_id must be a positive integer");
    return id;
  }
}

/** A lost connection is fatal to the batch; anything else is one item's failure. */
function isConnectionLoss(err) {
  const code = err && err.code;
  return code === "PROTOCOL_CONNECTION_LOST" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR";
}

module.exports = (repo, store) => new AttendanceImportUsecase(repo, store);
module.exports.AttendanceImportUsecase = AttendanceImportUsecase;
module.exports.CLASS = CLASS;
module.exports.OUTCOME = OUTCOME;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
