/**
 * Warehouse Daily Reports - the five RetailPilot exports the team uploads
 * every morning, and how one file's rows become table rows.
 *
 *   PICKING, PACKING, VERIFICATION   an article per store ("job" shape):
 *       Job Type, From Store, To Store, Article ID, ... Short Qty, Returned Qty, Jobs, Open Jobs
 *       Short Qty is the write-off.
 *   LOADING, UNLOADING               an article in a box on a truck ("box" shape):
 *       Job Type, From Store, Planned To Store, [Unloaded Store], Box ID, Box Kind, Truck No, ...
 *
 * The page reads the file (CSV or Excel) and sends its header row and data
 * rows as they are; everything is checked and converted here.
 */

const REPORT_TYPES = ["PICKING", "PACKING", "VERIFICATION", "LOADING", "UNLOADING"];
const JOB_TYPES = ["PICKING", "PACKING", "VERIFICATION"];
const BOX_TYPES = ["LOADING", "UNLOADING"];
const LABELS = { PICKING: "Picking", PACKING: "Packing", VERIFICATION: "Verification", LOADING: "Loading", UNLOADING: "Unloading" };

const JOB_COLUMNS = {
  job_type: "Job Type",
  from_store: "From Store",
  to_store: "To Store",
  article_id: "Article ID",
  article_name: "Article Name",
  department: "Department",
  category: "Category",
  recommended_qty: "Recommended Qty",
  planned_qty: "Planned Qty",
  advised_qty: "Advised Qty",
  actual_qty: "Actual Qty",
  mrp_split: "MRP Split",
  short_qty: "Short Qty",
  returned_qty: "Returned Qty",
  jobs: "Jobs",
  open_jobs: "Open Jobs",
};
const BOX_COLUMNS = {
  job_type: "Job Type",
  from_store: "From Store",
  planned_to_store: "Planned To Store",
  unloaded_store: "Unloaded Store",
  box_id: "Box ID",
  box_kind: "Box Kind",
  truck_no: "Truck No",
  article_id: "Article ID",
  article_name: "Article Name",
  department: "Department",
  category: "Category",
  mrp_split: "MRP Split",
  box_qty: "Box Qty",
  box_status: "Box Status",
  finished_at: "Finished At",
};
/** Headers a file must have; the rest are read when present. */
const REQUIRED = {
  PICKING: ["Job Type", "To Store", "Article ID", "Planned Qty", "Actual Qty", "Short Qty"],
  PACKING: ["Job Type", "To Store", "Article ID", "Planned Qty", "Actual Qty", "Short Qty"],
  VERIFICATION: ["Job Type", "To Store", "Article ID", "Planned Qty", "Actual Qty", "Short Qty", "Returned Qty"],
  LOADING: ["Job Type", "Planned To Store", "Box ID", "Truck No", "Article ID", "Box Qty"],
  UNLOADING: ["Job Type", "Planned To Store", "Unloaded Store", "Box ID", "Truck No", "Article ID", "Box Qty"],
};
const MAX_ROWS = 50000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const shapeOf = (type) => (JOB_TYPES.includes(type) ? "JOB" : BOX_TYPES.includes(type) ? "BOX" : null);
const norm = (h) => String(h == null ? "" : h).trim().toLowerCase().replace(/\s+/g, " ");
const text = (v, max = 255) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const lower = (v, max) => {
  const s = text(v, max);
  return s ? s.toLowerCase() : null;
};
/** A number, or null for a blank cell. NaN marks a cell that is not a number. */
const num = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/** The YYYY-MM-DD in a RetailPilot export's file name, e.g. Picking_Report_2026-11-16_ALL.csv. */
function dateFromFileName(name) {
  const m = String(name || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Which report a file name says it is (Picking_Report_..., Loading_Report_...), or null. */
function typeFromFileName(name) {
  const s = String(name || "").toLowerCase();
  // "unloading" contains "loading": test it first.
  if (/unloading/.test(s)) return "UNLOADING";
  if (/loading/.test(s)) return "LOADING";
  if (/picking/.test(s)) return "PICKING";
  if (/packing/.test(s)) return "PACKING";
  if (/verification/.test(s)) return "VERIFICATION";
  return null;
}

function validDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/**
 * The MRP of a row from its MRP Split ([{"mrp":30,"qty":72}, ...]): the only
 * MRP, or the quantity-weighted one when there are several. Null when empty.
 */
function mrpFromSplit(value) {
  if (value == null || value === "") return null;
  let list;
  try {
    list = typeof value === "string" ? JSON.parse(value) : value;
  } catch (err) {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const parts = list.map((p) => ({ mrp: Number(p && p.mrp), qty: Number(p && p.qty) })).filter((p) => Number.isFinite(p.mrp) && p.mrp > 0);
  if (!parts.length) return null;
  const qty = parts.reduce((s, p) => s + (Number.isFinite(p.qty) && p.qty > 0 ? p.qty : 0), 0);
  if (!qty) return parts[0].mrp;
  const value_ = parts.reduce((s, p) => s + p.mrp * (Number.isFinite(p.qty) && p.qty > 0 ? p.qty : 0), 0);
  return Math.round((value_ / qty) * 100) / 100;
}

/** "16 Nov 2026 11:26 AM" (IST, as RetailPilot writes it) -> "2026-11-16 11:26:00", or null. */
function parseFinishedAt(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // An Excel serial date (days since 1899-12-30), already in local time.
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    let h = Number(m[4]);
    if (m[7]) {
      const pm = m[7].toLowerCase() === "pm";
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    if (h > 23 || Number(m[5]) > 59) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${m[3]}-${p(mon)}-${p(Number(m[1]))} ${p(h)}:${m[5]}:${m[6] || "00"}`;
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4] || "00"}` : null;
}

/**
 * Check a file's header row against the report it is uploaded as. Answers
 * { ok, index, error }, index mapping each column key to its position.
 */
function readHeaders(type, headers) {
  const shape = shapeOf(type);
  if (!shape) return { ok: false, error: "Unknown report" };
  const at = new Map((headers || []).map((h, i) => [norm(h), i]));
  const missing = REQUIRED[type].filter((h) => !at.has(norm(h)));
  if (missing.length) {
    // A box file sent as a job report (or the other way round): say what it looks like.
    let hint = "";
    if (at.has(norm("Box ID"))) hint = ` This file looks like the ${at.has(norm("Unloaded Store")) ? "Unloading" : "Loading"} report.`;
    else if (at.has(norm("Short Qty"))) hint = " This file looks like a Picking, Packing or Verification report.";
    return { ok: false, error: `This is not the ${LABELS[type]} report: missing ${missing.join(", ")}.${hint}` };
  }
  const columns = shape === "JOB" ? JOB_COLUMNS : BOX_COLUMNS;
  const index = {};
  for (const [key, label] of Object.entries(columns)) index[key] = at.has(norm(label)) ? at.get(norm(label)) : -1;
  return { ok: true, index };
}

/**
 * Turn one file's data rows into rows for wh_report_job_rows or
 * wh_report_box_rows. Blank lines are skipped. Answers { rows, errors }:
 * errors name the line in the file (header = line 1), at most 20.
 */
function parseRows(type, headers, rawRows) {
  const head = readHeaders(type, headers);
  if (!head.ok) return { rows: [], errors: [head.error] };
  if (!Array.isArray(rawRows)) return { rows: [], errors: ["No rows"] };
  if (rawRows.length > MAX_ROWS) return { rows: [], errors: [`Too many rows (${rawRows.length}); the limit is ${MAX_ROWS}`] };
  const { index } = head;
  const shape = shapeOf(type);
  const rows = [];
  const errors = [];
  const fail = (line, msg) => {
    if (errors.length < 20) errors.push(`Line ${line}: ${msg}`);
  };

  rawRows.forEach((raw, i) => {
    const line = i + 2;
    const cell = (key) => (index[key] >= 0 && Array.isArray(raw) ? raw[index[key]] : null);
    if (!Array.isArray(raw) || raw.every((v) => v == null || String(v).trim() === "")) return;

    const article = num(cell("article_id"));
    if (!Number.isInteger(article) || article <= 0) return fail(line, `Article ID "${cell("article_id") ?? ""}" is not a number`);
    const numbers = {};
    const keys = shape === "JOB" ? ["recommended_qty", "planned_qty", "advised_qty", "actual_qty", "short_qty", "returned_qty", "jobs", "open_jobs"] : ["box_qty"];
    for (const k of keys) {
      const n = num(cell(k));
      if (Number.isNaN(n)) return fail(line, `${(shape === "JOB" ? JOB_COLUMNS : BOX_COLUMNS)[k]} "${cell(k)}" is not a number`);
      numbers[k] = n;
    }
    const common = {
      report_type: type,
      job_type: text(cell("job_type"), 20),
      from_store: lower(cell("from_store"), 100),
      article_id: article,
      article_name: text(cell("article_name"), 255),
      department: text(cell("department"), 150),
      category: text(cell("category"), 150),
      mrp: mrpFromSplit(cell("mrp_split")),
    };
    if (shape === "JOB") {
      rows.push({
        ...common,
        to_store: lower(cell("to_store"), 100),
        recommended_qty: numbers.recommended_qty,
        planned_qty: numbers.planned_qty,
        advised_qty: numbers.advised_qty,
        actual_qty: numbers.actual_qty,
        short_qty: numbers.short_qty || 0,
        returned_qty: numbers.returned_qty,
        jobs: numbers.jobs == null ? null : Math.round(numbers.jobs),
        open_jobs: numbers.open_jobs == null ? null : Math.round(numbers.open_jobs),
      });
    } else {
      const box = text(cell("box_id"), 64);
      if (!box) return fail(line, "Box ID is blank");
      const finished = cell("finished_at");
      const at = parseFinishedAt(finished);
      if (finished != null && String(finished).trim() !== "" && !at) return fail(line, `Finished At "${finished}" is not a date and time`);
      rows.push({
        ...common,
        planned_to_store: lower(cell("planned_to_store"), 100),
        unloaded_store: lower(cell("unloaded_store"), 100),
        box_id: box,
        box_kind: text(cell("box_kind"), 30),
        truck_no: text(cell("truck_no"), 30) && text(cell("truck_no"), 30).toUpperCase(),
        box_qty: numbers.box_qty || 0,
        box_status: text(cell("box_status"), 30),
        finished_at: at,
      });
    }
  });
  if (!rows.length && !errors.length) errors.push("The file has no rows");
  return { rows, errors };
}

/** Job types the Pick & Pack Verification page (pick_pack_verifications.job_type) keeps. */
const VERIFICATION_PAGE_JOB_TYPES = ["GRN", "STA"];

/**
 * The Verification report's write-off as rows for the Pick & Pack
 * Verification page: Short Qty > 0, one row per article, job type and store
 * (so each store gets its own remark), whole units. Answers
 * { rows, other_job_type_lines } - lines of job types the page has no tab for
 * are counted, not copied.
 */
function verificationWriteOffs(rows) {
  const by = new Map();
  let other = 0;
  for (const r of rows || []) {
    if (!(Number(r.short_qty) > 0)) continue;
    const jt = String(r.job_type || "").toUpperCase();
    if (!VERIFICATION_PAGE_JOB_TYPES.includes(jt)) {
      other += 1;
      continue;
    }
    const store = r.to_store || null;
    const key = `${r.article_id}|${jt}|${store}`;
    const cur = by.get(key) || { product_id: r.article_id, job_type: jt, store, mismatch_qty: 0 };
    cur.mismatch_qty += Number(r.short_qty);
    by.set(key, cur);
  }
  const out = [...by.values()].map((r) => ({ ...r, mismatch_qty: Math.round(r.mismatch_qty) })).filter((r) => r.mismatch_qty > 0);
  return { rows: out, other_job_type_lines: other };
}

/** A box going back to the warehouse (damage returns): loaded, but never unloaded at a store. */
const isReturn = (r) => String(r.job_type || "").toUpperCase() === "DAMG" || (r.planned_to_store && r.planned_to_store === r.from_store);

const addDays = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/**
 * Match loaded box lines to unloaded ones. Inputs are one row per
 * (report_date, box_id, article_id) with summed qty. A line loaded on day D
 * is matched to the same box and article unloaded on D or D+1.
 *
 * Each loaded line comes back with a status:
 *   OK            unloaded at the planned store, same quantity
 *   QTY_DIFF      unloaded, different quantity
 *   WRONG_STORE   unloaded at another store
 *   NOT_UNLOADED  never unloaded (OPEN when loaded on the last day there is unloading for)
 *   RETURN        damage / return to warehouse - not expected at a store
 * and every unloaded line no loading matches comes back as NOT_LOADED.
 */
function reconcileBoxes(loaded, unloaded, { lastUnloadDate = null } = {}) {
  const pool = new Map();
  for (const u of unloaded) {
    const key = `${u.box_id}|${u.article_id}`;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push({ ...u, used: false });
  }
  for (const list of pool.values()) list.sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));

  const lines = [];
  for (const l of loaded) {
    const key = `${l.box_id}|${l.article_id}`;
    const next = addDays(l.report_date, 1);
    const u = (pool.get(key) || []).find((c) => !c.used && c.report_date >= l.report_date && c.report_date <= next);
    if (u) u.used = true;
    let status;
    if (!u) status = isReturn(l) ? "RETURN" : lastUnloadDate && l.report_date >= lastUnloadDate ? "OPEN" : "NOT_UNLOADED";
    else if (u.unloaded_store && l.planned_to_store && u.unloaded_store !== l.planned_to_store) status = "WRONG_STORE";
    else if (Math.abs(Number(u.box_qty) - Number(l.box_qty)) > 1e-6) status = "QTY_DIFF";
    else status = "OK";
    lines.push({
      status,
      report_date: l.report_date,
      box_id: l.box_id,
      box_kind: l.box_kind || null,
      article_id: l.article_id,
      article_name: l.article_name || (u && u.article_name) || null,
      job_type: l.job_type || null,
      truck_no: l.truck_no || null,
      from_store: l.from_store || null,
      planned_to_store: l.planned_to_store || null,
      unloaded_store: u ? u.unloaded_store : null,
      loaded_qty: Number(l.box_qty) || 0,
      unloaded_qty: u ? Number(u.box_qty) || 0 : null,
      mrp: l.mrp != null ? Number(l.mrp) : u && u.mrp != null ? Number(u.mrp) : null,
      loaded_at: l.finished_at || null,
      unloaded_at: u ? u.finished_at || null : null,
      unload_date: u ? u.report_date : null,
    });
  }
  for (const list of pool.values()) {
    for (const u of list) {
      if (u.used) continue;
      lines.push({
        status: "NOT_LOADED",
        report_date: u.report_date,
        box_id: u.box_id,
        box_kind: u.box_kind || null,
        article_id: u.article_id,
        article_name: u.article_name || null,
        job_type: u.job_type || null,
        truck_no: u.truck_no || null,
        from_store: u.from_store || null,
        planned_to_store: u.planned_to_store || null,
        unloaded_store: u.unloaded_store || null,
        loaded_qty: null,
        unloaded_qty: Number(u.box_qty) || 0,
        mrp: u.mrp != null ? Number(u.mrp) : null,
        loaded_at: null,
        unloaded_at: u.finished_at || null,
        unload_date: u.report_date,
      });
    }
  }
  return lines;
}

module.exports = {
  REPORT_TYPES,
  JOB_TYPES,
  BOX_TYPES,
  LABELS,
  REQUIRED,
  MAX_ROWS,
  shapeOf,
  validDate,
  addDays,
  dateFromFileName,
  typeFromFileName,
  mrpFromSplit,
  parseFinishedAt,
  readHeaders,
  parseRows,
  isReturn,
  reconcileBoxes,
  VERIFICATION_PAGE_JOB_TYPES,
  verificationWriteOffs,
};
