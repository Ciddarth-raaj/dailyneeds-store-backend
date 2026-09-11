/**
 * Attendance List and Punch Audit - the read side of Biomax Part 1.
 *
 * Presents raw punches. It groups, sorts and counts; it interprets nothing.
 * No IN/OUT, no hours, no lateness, no status - a day with one punch and a
 * day with nine are both just rows with that many Clock Time cells.
 *
 * The two views (R14):
 *
 *   Attendance List   one row per (employee, attendance_date), every dated
 *                     punch of that employee on that date merged into one
 *                     chronological sequence whichever terminal or outlet
 *                     recorded it (R11). Filterable by HOME outlet only.
 *                     Punches from an unregistered or inactive device are
 *                     left out of the row and counted (D6, D8).
 *
 *   Punch Audit       one row per physical punch, any status, filterable by
 *                     device, punch location, source IP and review state.
 *                     This is where undatable punches (A3) and quarantined
 *                     punches live.
 */

const RANGE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST_DAYS = 92;
const MAX_AUDIT_DAYS = 31;
const MAX_AUDIT_LIMIT = 1000;

function validationError(message, extra) {
  const err = new Error(message);
  err.name = "ValidationError";
  if (extra) Object.assign(err, extra);
  return err;
}

/** Days between two 'YYYY-MM-DD' strings, UTC integer math (no zone). */
function daysBetween(from, to) {
  const d = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(to) - d(from)) / 86400000);
}

function checkRange(from, to, maxDays) {
  if (!RANGE_RE.test(String(from || "")) || !RANGE_RE.test(String(to || ""))) {
    throw validationError("from and to are required as YYYY-MM-DD");
  }
  const days = daysBetween(from, to);
  if (Number.isNaN(days) || days < 0) throw validationError("to must not be before from");
  if (days > maxDays) throw validationError(`the range may cover at most ${maxDays} days`);
}

const optionalInt = (v, name) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw validationError(`${name} must be a whole number`);
  return n;
};

const optionalText = (v, max = 100) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  return s.slice(0, max);
};

class AttendanceRawUsecase {
  /**
   * @param {object} punchRepo   repository/biomax_punch
   * @param {object} [exportLog] anything with logExport(entry) - the report
   *        template repository, so exports land in report_export_log
   */
  constructor(punchRepo, exportLog) {
    this.punchRepo = punchRepo;
    this.exportLog = exportLog || null;
  }

  /* ------------------------------------------------------ Attendance List */

  /**
   * Normalise and validate the Attendance List query. Rejects device and
   * punch-location parameters outright (R14) so a client cannot believe it
   * filtered by them.
   */
  listFilters(query = {}) {
    for (const forbidden of ["dev_id", "punch_outlet_id", "device_status", "outlet_id", "location"]) {
      if (query[forbidden] !== undefined) {
        throw validationError(
          `${forbidden} is not an Attendance List filter. The list is grouped by employee and date across every device; use /attendance/raw/punches (Punch Audit) to filter by device or punch location.`
        );
      }
    }
    checkRange(query.from, query.to, MAX_LIST_DAYS);
    return {
      from: query.from,
      to: query.to,
      home_outlet_id: optionalInt(query.home_outlet_id, "home_outlet_id"),
      department_id: optionalInt(query.department_id, "department_id"),
      search: optionalText(query.search),
    };
  }

  /**
   * Rows for the Attendance List.
   *
   * @returns {{meta: object, data: object[]}}
   */
  async list(query) {
    const filters = this.listFilters(query);
    const rows = await this.punchRepo.listDated(filters);
    const { data, maxPunchCount, quarantined } = pivot(rows);
    const summary = await this.punchRepo.summary({ from: filters.from, to: filters.to });
    return {
      meta: {
        ...filters,
        row_count: data.length,
        max_punch_count: maxPunchCount,
        quarantined_punches: quarantined,
        ...summariseCounts(summary),
      },
      data,
    };
  }

  /* --------------------------------------------------------- Punch Audit */

  auditFilters(query = {}) {
    checkRange(query.from, query.to, MAX_AUDIT_DAYS);
    const limit = optionalInt(query.limit, "limit");
    const offset = optionalInt(query.offset, "offset");
    if (limit !== null && (limit < 1 || limit > MAX_AUDIT_LIMIT)) {
      throw validationError(`limit must be between 1 and ${MAX_AUDIT_LIMIT}`);
    }
    const deviceStatus = optionalText(query.device_status, 30);
    if (deviceStatus && !["REGISTERED", "INACTIVE_DEVICE", "UNREGISTERED_DEVICE", "IMPORTED"].includes(deviceStatus)) {
      throw validationError("device_status must be REGISTERED, INACTIVE_DEVICE, UNREGISTERED_DEVICE or IMPORTED");
    }
    const review = optionalText(query.review, 20);
    if (review && !["needs_review", "ok"].includes(review)) {
      throw validationError("review must be needs_review or ok");
    }
    const attendanceDate = optionalText(query.attendance_date, 10);
    if (attendanceDate && !RANGE_RE.test(attendanceDate)) {
      throw validationError("attendance_date must be YYYY-MM-DD");
    }
    return {
      from: query.from,
      to: query.to,
      dev_id: optionalText(query.dev_id, 32),
      punch_outlet_id: optionalInt(query.punch_outlet_id, "punch_outlet_id"),
      device_status: deviceStatus,
      review,
      search: optionalText(query.search),
      source_ip: optionalText(query.source_ip, 45),
      employee_id: optionalInt(query.employee_id, "employee_id"),
      attendance_date: attendanceDate,
      limit: limit === null ? 500 : limit,
      offset: offset === null ? 0 : offset,
    };
  }

  async audit(query) {
    const filters = this.auditFilters(query);
    const rows = await this.punchRepo.listPunches(filters);
    return {
      meta: { ...filters, row_count: rows.length },
      data: rows.map(presentPunch),
    };
  }

  async summary(query) {
    checkRange(query.from, query.to, MAX_LIST_DAYS);
    const summary = await this.punchRepo.summary({ from: query.from, to: query.to });
    return { from: query.from, to: query.to, ...summariseCounts(summary), unregistered_devices_detail: summary.unregistered };
  }

  /* ------------------------------------------------------------- exports */

  /**
   * CSV rows for the Attendance List: the same query and filters as the
   * screen (D5). Returns {header, rows} where each row is an array of cell
   * strings; the route does the streaming and the escaping.
   */
  async listCsv(query) {
    const withLocations = String(query.with_locations || "") === "1";
    const { meta, data } = await this.list(query);
    const n = meta.max_punch_count;
    const header = ["Employee Code", "Employee Name", "Department", "Home Outlet", "Clock Date"];
    for (let i = 1; i <= n; i += 1) header.push(`Clock Time-${i}`);
    header.push("Punches", "Quarantined");
    const rows = data.map((r) => {
      const cells = [r.user_id, r.employee_name || "", r.department_name || "", r.home_outlet || "", toDisplayDate(r.clock_date)];
      for (let i = 0; i < n; i += 1) {
        const p = r.punches[i];
        if (!p) cells.push("");
        else cells.push(withLocations ? `${p.time} @${p.punch_outlet_code || p.punch_outlet || ""}`.trim() : p.time);
      }
      cells.push(String(r.punch_count), String(r.quarantined_punch_count));
      return cells;
    });
    return { header, rows, meta, dataset_key: "RAW_ATTENDANCE", filename: `attendance-list-${meta.from}-to-${meta.to}.csv` };
  }

  async auditCsv(query) {
    const { meta, data } = await this.audit(query);
    const header = ["Calendar Date", "Time", "Attendance Date", "Employee Code", "Employee Name", "Home Outlet", "Punch Location", "Device", "Cloud ID", "Source IP", "Device Status", "Derivation Status", "Cutoff Applied", "Retransmits"];
    const rows = data.map((p) => [
      toDisplayDate(p.calendar_date), p.clock_time, toDisplayDate(p.attendance_date), p.user_id, p.employee_name || "", p.home_outlet || "",
      p.punch_outlet || "", p.device_label || "", p.dev_id, p.source_ip || "", p.device_status, p.derivation_status || "NO_DERIVED_ROW", p.cutoff_applied || "", String(p.retransmit_count || 0),
    ]);
    return { header, rows, meta, dataset_key: "RAW_ATTENDANCE_PUNCHES", filename: `punch-audit-${meta.from}-to-${meta.to}.csv` };
  }

  /** Shape-only audit of an export, never values (report_export_log). */
  async recordExport({ dataset_key, header, filters, row_count }, actor) {
    if (!this.exportLog) return null;
    const safeFilters = { ...filters };
    // A search string is often a person's name; record that one was used, not what.
    if (safeFilters.search !== undefined) safeFilters.search_used = Boolean(safeFilters.search);
    delete safeFilters.search;
    return this.exportLog.logExport({
      dataset_key,
      user_id: actor ? actor.userId : null,
      employee_id: actor ? actor.employeeId : null,
      field_keys: header,
      filters: safeFilters,
      row_count,
      format: "csv",
      sensitive_fields_included: 0,
      template_id: null,
    });
  }
}

/* ------------------------------------------------------------ helpers -- */

function presentPunch(row) {
  return {
    biomax_punch_id: Number(row.biomax_punch_id),
    dev_id: row.dev_id,
    user_id: row.user_id,
    io_time: row.io_time,
    io_time_raw: row.io_time_raw,
    clock_time: row.clock_time,
    calendar_date: row.calendar_date,
    attendance_date: row.attendance_date || null,
    derivation_status: row.derivation_status || null,
    employee_id: row.employee_id === null || row.employee_id === undefined ? null : Number(row.employee_id),
    employee_name: row.employee_name || null,
    employee_status: row.employee_status === null || row.employee_status === undefined ? null : Number(row.employee_status),
    department_name: row.department_name || null,
    home_outlet_id: row.home_outlet_id === null || row.home_outlet_id === undefined ? null : Number(row.home_outlet_id),
    home_outlet: row.home_outlet || null,
    home_outlet_code: row.home_outlet_code || null,
    biomax_device_id: row.biomax_device_id === null || row.biomax_device_id === undefined ? null : Number(row.biomax_device_id),
    device_label: row.device_label || null,
    punch_outlet_id: row.punch_outlet_id === null || row.punch_outlet_id === undefined ? null : Number(row.punch_outlet_id),
    punch_outlet: row.punch_outlet || null,
    punch_outlet_code: row.punch_outlet_code || null,
    device_status: row.device_status,
    ingest_source: row.ingest_source,
    import_batch_id: row.import_batch_id,
    source_ip: row.source_ip || null,
    cutoff_applied: row.cutoff_applied || null,
    work_shift_id: row.work_shift_id === null || row.work_shift_id === undefined ? null : Number(row.work_shift_id),
    retransmit_count: Number(row.retransmit_count || 0),
    received_at: row.received_at,
    match_status: row.employee_id === null || row.employee_id === undefined ? "UNMATCHED" : "MATCHED",
  };
}

/**
 * Group dated punches into (employee, attendance_date) rows (R11).
 *
 * Input is ordered by attendance_date, employee_id, io_time, id. Punches
 * whose device is not REGISTERED at their io_time are quarantined: counted
 * on the row, left out of `punches` (D6/D8).
 */
function pivot(rows) {
  const data = [];
  let current = null;
  let maxPunchCount = 0;
  let quarantined = 0;

  for (const raw of rows) {
    const p = presentPunch(raw);
    const key = `${p.attendance_date}|${p.employee_id}`;
    if (!current || current.key !== key) {
      current = {
        key,
        subject: `E${p.employee_id}`,
        employee_id: p.employee_id,
        user_id: p.user_id,
        matched: p.employee_id !== null,
        employee_name: p.employee_name,
        employee_status: p.employee_status,
        department_name: p.department_name,
        home_outlet_id: p.home_outlet_id,
        home_outlet: p.home_outlet,
        home_outlet_code: p.home_outlet_code,
        clock_date: p.attendance_date,
        punches: [],
        punch_count: 0,
        distinct_punch_outlets: [],
        quarantined_punch_count: 0,
      };
      data.push(current);
    }
    // Quarantine is a DEVICE decision: an unregistered or inactive terminal.
    // An IMPORTED punch has no terminal and is never quarantined for one.
    if (p.device_status !== "REGISTERED" && p.device_status !== "IMPORTED") {
      current.quarantined_punch_count += 1;
      quarantined += 1;
      continue;
    }
    current.punches.push({
      biomax_punch_id: p.biomax_punch_id,
      time: p.clock_time,
      io_time: p.io_time,
      calendar_date: p.calendar_date,
      dev_id: p.dev_id,
      device_label: p.device_label,
      punch_outlet_id: p.punch_outlet_id,
      punch_outlet: p.punch_outlet,
      punch_outlet_code: p.punch_outlet_code,
      source_ip: p.source_ip,
      ingest_source: p.ingest_source,
      cutoff_applied: p.cutoff_applied,
    });
    current.punch_count = current.punches.length;
    if (p.punch_outlet_code && !current.distinct_punch_outlets.includes(p.punch_outlet_code)) {
      current.distinct_punch_outlets.push(p.punch_outlet_code);
    }
    if (current.punch_count > maxPunchCount) maxPunchCount = current.punch_count;
  }

  for (const row of data) delete row.key;
  return { data, maxPunchCount, quarantined };
}

function summariseCounts(summary) {
  const out = {
    unmatched_punches: 0,
    no_shift_punches: 0,
    no_schedule_row_punches: 0,
    missing_cutoff_punches: 0,
    undated_punches: 0,
    unregistered_device_punches: 0,
    inactive_device_punches: 0,
    unregistered_devices: (summary.unregistered || []).map((u) => u.dev_id),
  };
  for (const g of summary.groups || []) {
    const n = Number(g.punches) || 0;
    switch (g.derivation_status) {
      case "UNMATCHED": out.unmatched_punches += n; break;
      case "NO_SHIFT": out.no_shift_punches += n; break;
      case "NO_SCHEDULE_ROW": out.no_schedule_row_punches += n; break;
      case "MISSING_CUTOFF": out.missing_cutoff_punches += n; break;
      default: break;
    }
    if (g.derivation_status !== "OK") out.undated_punches += n;
    if (g.device_status === "UNREGISTERED_DEVICE") out.unregistered_device_punches += n;
    if (g.device_status === "INACTIVE_DEVICE") out.inactive_device_punches += n;
  }
  return out;
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (the app's display convention). */
function toDisplayDate(iso) {
  if (!iso || !RANGE_RE.test(iso)) return iso || "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

module.exports = (punchRepo, exportLog) => new AttendanceRawUsecase(punchRepo, exportLog);
module.exports.AttendanceRawUsecase = AttendanceRawUsecase;
module.exports.pivot = pivot;
module.exports.presentPunch = presentPunch;
module.exports.summariseCounts = summariseCounts;
module.exports.toDisplayDate = toDisplayDate;
module.exports.MAX_LIST_DAYS = MAX_LIST_DAYS;
module.exports.MAX_AUDIT_DAYS = MAX_AUDIT_DAYS;
