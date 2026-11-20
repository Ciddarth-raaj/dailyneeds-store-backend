/**
 * Warehouse Daily Reports from RetailPilot: the five reports built from the
 * pick & pack jobs in runway (SPECTRA), in the same row shapes an uploaded
 * file gives (utils/wh_daily_reports.parseRows), so they are saved, priced
 * and sent to the Write Off / Verification pages the same way.
 *
 *   picknpack.state_machine            one job per stage, keyed by job_id. A
 *                                      job in a done state finished when it
 *                                      was last updated (updated_at).
 *   picknpack.article_dimension_joblets  a job's article lines: advised and
 *                                      actual; short = advised - actual.
 *   picknpack.box_dimension_joblets    a loading / unloading job's boxes.
 *   picknpack.box_articles             what is in each box.
 *   masterhub.stores                   store names.
 *
 * A job counts on the day (India time) it FINISHED. A job still in progress
 * counts, as open, on the day it was created.
 *
 *   PICKING       PICKED, PICKED_PACKED (pick & pack in one job)  open: PICKING, PICK_PACK
 *   PACKING       PACKED                                          open: PACKING
 *   VERIFICATION  VERIFIED                                        open: VERIFICATION
 *   LOADING       LOADED   (boxes)
 *   UNLOADING     UNLOADED (boxes actually unloaded at a store)
 *
 * Sales orders (job_type SO) go to customers, not stores, and are left out.
 *
 * SPECTRA runs SQL text and turns literals into parameters: the only values
 * built into a query are a day already checked as YYYY-MM-DD. No subqueries.
 */

const JOB_STAGES = {
  PICKING: { done: ["PICKED", "PICKED_PACKED"], open: ["PICKING", "PICK_PACK"] },
  PACKING: { done: ["PACKED"], open: ["PACKING"] },
  VERIFICATION: { done: ["VERIFIED"], open: ["VERIFICATION"] },
};
const BOX_STAGES = {
  LOADING: { done: "LOADED", status: "Loaded" },
  UNLOADING: { done: "UNLOADED", status: "Unloaded" },
};
const PULL_TYPES = ["PICKING", "PACKING", "LOADING", "UNLOADING", "VERIFICATION"];
const IST_MS = 330 * 60 * 1000;

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const quoted = (list) => list.map((s) => `'${s}'`).join(", ");

function validDay(d) {
  const s = clean(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

const istDay = (col) => `((${col} AT TIME ZONE 'Asia/Kolkata')::date)`;

/** Picking, packing or verification: every article line of the jobs that finished on `day`, and of those still open from it. */
function buildJobLinesQuery(type, day) {
  const st = JOB_STAGES[type];
  const d = validDay(day);
  if (!st) throw new Error(`Not a job report: ${type}`);
  if (!d) throw new Error("Invalid day");
  return `
SELECT j.job_id, j.job_type, j.state, j.assigned_user, j.created_at, j.updated_at,
  l.slug AS line_id, l.article_id, l.origin, l.destination, l.advised_qty, l.actual_qty, l.stage_id, l.meta
FROM picknpack.state_machine j
JOIN picknpack.article_dimension_joblets l ON l.job_id = j.job_id
WHERE j.job_type <> 'SO'
  AND ((j.state IN (${quoted(st.done)}) AND ${istDay("j.updated_at")} = DATE '${d}')
    OR (j.state IN (${quoted(st.open)}) AND ${istDay("j.created_at")} = DATE '${d}'))
ORDER BY j.job_id, l.slug`;
}

/** Loading or unloading: every article in every box of the jobs that finished on `day`. */
function buildBoxLinesQuery(type, day) {
  const st = BOX_STAGES[type];
  const d = validDay(day);
  if (!st) throw new Error(`Not a box report: ${type}`);
  if (!d) throw new Error("Invalid day");
  return `
SELECT j.job_id, j.job_type, j.state, j.assigned_user, j.updated_at,
  b.slug AS box_row, b.box_id, b.origin, b.destination, b.truck_id, b.unloaded_store, b.meta,
  a.article_id, a.qty
FROM picknpack.state_machine j
JOIN picknpack.box_dimension_joblets b ON b.job_id = j.job_id
JOIN picknpack.box_articles a ON a.joblet_id = b.slug
WHERE j.job_type <> 'SO' AND j.state = '${st.done}' AND ${istDay("j.updated_at")} = DATE '${d}'
ORDER BY j.job_id, b.box_id, a.article_id`;
}

/** Every store's name. */
const STORES_QUERY = `
SELECT CAST(s.slug AS TEXT) AS slug, s.name
FROM masterhub.stores s
ORDER BY s.slug`;

/** slug -> lower-case store name, as the uploaded reports name stores. */
function storeNames(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const slug = clean(r.slug);
    if (slug) m.set(slug, clean(r.name).toLowerCase() || slug);
  }
  return m;
}

/** jsonb arrives as an object or as JSON text. */
function meta(v) {
  if (v && typeof v === "object") return v;
  try {
    const o = JSON.parse(clean(v) || "{}");
    return o && typeof o === "object" ? o : {};
  } catch (err) {
    return {};
  }
}

/** A timestamp as "YYYY-MM-DD HH:MM:SS" India time, or null. */
function istDateTime(v) {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_MS).toISOString().slice(0, 19).replace("T", " ");
}

const articleNo = (v) => {
  const s = clean(v);
  return /^\d+$/.test(s) ? Number(s) : null;
};

/**
 * Job article lines -> wh_report_job_rows rows. A finished line is short by
 * advised - actual (never below 0); an open one is not a write-off yet, and
 * neither is a line whose goods stay where they are (origin = destination:
 * GRN goods kept at the receiving store, auto-picked, never scanned).
 * Verification's short is also its returned qty. Answers { rows, skipped }:
 * lines whose article id is not a number are counted, not kept.
 */
function mapJobLines(type, lines, stores) {
  const st = JOB_STAGES[type];
  const name = (slug) => (stores && stores.get(clean(slug))) || clean(slug).toLowerCase() || null;
  const rows = [];
  let skipped = 0;
  for (const l of lines || []) {
    const article = articleNo(l.article_id);
    if (!article) {
      skipped += 1;
      continue;
    }
    const done = st.done.includes(clean(l.state));
    const advised = num(l.advised_qty);
    const actual = num(l.actual_qty);
    const stays = clean(l.origin) !== "" && clean(l.origin) === clean(l.destination);
    const short = done && !stays ? Math.max(0, Math.round((advised - actual) * 1000) / 1000) : 0;
    rows.push({
      report_type: type,
      job_id: clean(l.job_id) || null,
      job_type: clean(l.job_type).toUpperCase() || null,
      from_store: name(l.origin),
      to_store: name(l.destination),
      article_id: article,
      article_name: null,
      department: null,
      category: null,
      recommended_qty: null,
      planned_qty: advised,
      advised_qty: advised,
      actual_qty: actual,
      short_qty: short,
      returned_qty: type === "VERIFICATION" ? short : null,
      jobs: 1,
      open_jobs: done ? 0 : 1,
      worked_by: clean(l.assigned_user) || null,
      mrp: null,
    });
  }
  return { rows, skipped };
}

/**
 * Box article rows -> wh_report_box_rows rows. Unloading: the planned store
 * is the box's original destination when it was reconciled to another store
 * on arrival, and a box kept on the truck for a later stop (no unloaded
 * store) is not unloaded yet and is left out.
 */
function mapBoxLines(type, lines, stores) {
  const st = BOX_STAGES[type];
  const name = (slug) => (slug ? (stores && stores.get(clean(slug))) || clean(slug).toLowerCase() : null);
  const rows = [];
  let skipped = 0;
  for (const l of lines || []) {
    const article = articleNo(l.article_id);
    const box = clean(l.box_id);
    if (!article || !box) {
      skipped += 1;
      continue;
    }
    const m = meta(l.meta);
    const unloading = type === "UNLOADING";
    if (unloading && !clean(l.unloaded_store)) continue;
    rows.push({
      report_type: type,
      job_id: clean(l.job_id) || null,
      job_type: clean(l.job_type).toUpperCase() || null,
      from_store: name(l.origin),
      planned_to_store: name(unloading && clean(m.original_destination) ? m.original_destination : l.destination),
      unloaded_store: unloading ? name(l.unloaded_store) : null,
      box_id: box.slice(0, 64),
      box_kind: null,
      truck_no: clean(l.truck_id).toUpperCase() || null,
      article_id: article,
      article_name: null,
      department: null,
      category: null,
      mrp: null,
      box_qty: num(l.qty),
      box_status: st.status,
      finished_at: istDateTime(l.updated_at),
      worked_by: clean(l.assigned_user) || null,
    });
  }
  return { rows, skipped };
}

module.exports = {
  JOB_STAGES,
  BOX_STAGES,
  PULL_TYPES,
  STORES_QUERY,
  validDay,
  buildJobLinesQuery,
  buildBoxLinesQuery,
  storeNames,
  istDateTime,
  mapJobLines,
  mapBoxLines,
};
