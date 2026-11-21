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
  b.slug AS box_row, b.box_id, b.origin, b.destination, b.truck_id, b.unloaded_store, b.stage_id, b.meta,
  a.article_id, a.qty
FROM picknpack.state_machine j
JOIN picknpack.box_dimension_joblets b ON b.job_id = j.job_id
JOIN picknpack.box_articles a ON a.joblet_id = b.slug
WHERE j.job_type <> 'SO' AND j.state = '${st.done}' AND ${istDay("j.updated_at")} = DATE '${d}'
ORDER BY j.job_id, b.box_id, a.article_id`;
}

/**
 * Stuck cartons: loading jobs still open (state LOADING) that were created
 * before `cutoff` (an IST day), with the articles in each carton. Kept flat
 * (no WITH / sub-queries); buildBoxPackQuery finds who packed each carton.
 */
function buildStuckLoadingQuery(cutoff) {
  const d = validDay(cutoff);
  if (!d) throw new Error("Invalid day");
  return `
SELECT j.job_id AS load_job, j.job_type, j.created_at, b.slug AS joblet, b.box_id, b.origin, b.destination, b.stage_id,
  a.article_id, a.qty
FROM picknpack.state_machine j
JOIN picknpack.box_dimension_joblets b ON b.job_id = j.job_id
LEFT JOIN picknpack.box_articles a ON a.joblet_id = b.slug
WHERE j.state = 'LOADING' AND ${istDay("j.created_at")} < DATE '${d}'
ORDER BY j.created_at, j.job_id, a.article_id`;
}

/** Every pack into these cartons (picknpack.box_ratio): the pack line, its job, lane and packer. */
function buildBoxPackQuery(boxIds) {
  const ids = [...new Set((boxIds || []).map((v) => clean(v)).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)))];
  if (!ids.length) return null;
  return `
SELECT r.box_id, r.joblet_id, r.updated_at, l.job_id AS pack_job, l.destination, j.assigned_user
FROM picknpack.box_ratio r
JOIN picknpack.article_dimension_joblets l ON l.slug = r.joblet_id
JOIN picknpack.state_machine j ON j.job_id = l.job_id
WHERE r.box_id IN (${quoted(ids)})
ORDER BY r.box_id, r.updated_at`;
}

/**
 * One row per stuck carton (box id + store it goes to): its open loading
 * job(s), since when, the articles and units in it, and - from the last pack
 * into that carton for that store before the loading job - the packer and
 * pack job. A carton with two open loading jobs lists both.
 */
function mapStuckCartons(loadRows, packRows, stores, today) {
  const name = (slug) => (slug ? (stores && stores.get(clean(slug))) || clean(slug).toLowerCase() : null);
  const by = new Map();
  for (const r of loadRows || []) {
    const box = clean(r.box_id);
    if (!box) continue;
    const k = `${box}|${clean(r.destination)}`;
    const c = by.get(k) || { carton: box, job_type: clean(r.job_type).toUpperCase() || null, from_store: name(r.origin), to_store: name(r.destination), destination: clean(r.destination), stage_id: clean(r.stage_id) || null, load_jobs: [], joblets: new Set(), since: r.created_at, items: new Map() };
    if (!c.load_jobs.includes(clean(r.load_job))) c.load_jobs.push(clean(r.load_job));
    if (String(r.created_at) < String(c.since)) c.since = r.created_at;
    const joblet = clean(r.joblet);
    const article = articleNo(r.article_id);
    if (article) {
      const key = `${joblet}|${article}`;
      if (!c.joblets.has(key)) {
        c.joblets.add(key);
        c.items.set(article, (c.items.get(article) || 0) + num(r.qty));
      }
    }
    by.set(k, c);
  }
  const packs = new Map();
  for (const p of packRows || []) {
    const box = clean(p.box_id);
    if (!packs.has(box)) packs.set(box, []);
    packs.get(box).push(p);
  }
  const day = (v) => istDateTime(v).slice(0, 10);
  return [...by.values()]
    .map((c) => {
      const before = (packs.get(c.carton) || []).filter((p) => clean(p.destination) === c.destination && String(p.updated_at) <= String(c.since));
      const last = before.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
      const items = [...c.items].map(([article_id, qty]) => ({ article_id, qty: Math.round(qty * 1000) / 1000 }));
      const waitingSince = istDateTime(c.since);
      return {
        carton: c.carton,
        job_type: c.job_type,
        from_store: c.from_store,
        to_store: c.to_store,
        stage_id: c.stage_id,
        load_jobs: c.load_jobs,
        waiting_since: waitingSince,
        days: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day(c.since)}T00:00:00Z`)) / 86400000)),
        items,
        articles: items.length,
        units: Math.round(items.reduce((s, i) => s + i.qty, 0) * 1000) / 1000,
        packer: last ? clean(last.assigned_user) || null : null,
        pack_job: last ? clean(last.pack_job) || null : null,
        packed_at: last ? istDateTime(last.updated_at) : null,
      };
    })
    .sort((a, b) => b.days - a.days || b.units - a.units);
}

/** Every store's name. */
const STORES_QUERY = `
SELECT CAST(s.slug AS TEXT) AS slug, s.name
FROM masterhub.stores s
ORDER BY s.slug`;

/**
 * NLC (net landing cost) of these articles, one row each, summed in
 * RetailPilot: the stock it holds now (any store, any location) and that
 * stock's NLC value, and the plain average NLC of its batches. Article ids
 * are checked as digits.
 */
function buildNlcQuery(articleIds) {
  const ids = [...new Set((articleIds || []).map((v) => clean(v)).filter((v) => /^\d{1,18}$/.test(v)))];
  if (!ids.length) return null;
  return `
SELECT CAST(b.article_id AS TEXT) AS article_id,
  SUM(p.quantity * b.net_landing_cost) AS stock_value,
  SUM(p.quantity) AS stock_qty,
  AVG(b.net_landing_cost) AS avg_nlc
FROM public.inventory_batches b
LEFT JOIN public.batch_stock_positions p ON p.batch_id = b.batch_id AND p.quantity > 0
WHERE CAST(b.article_id AS TEXT) IN (${ids.map((id) => `'${id}'`).join(", ")}) AND b.net_landing_cost > 0
GROUP BY b.article_id
ORDER BY b.article_id`;
}

/**
 * article id -> NLC: the stock-weighted average NLC of what the article
 * holds now; an article with no stock (often the case when it was short)
 * takes the average NLC of its batches. 4 decimals.
 */
function nlcByArticle(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const id = articleNo(r.article_id);
    if (!id) continue;
    const qty = num(r.stock_qty);
    const v = qty > 0 ? num(r.stock_value) / qty : num(r.avg_nlc);
    if (v > 0) out.set(id, Math.round(v * 10000) / 10000);
  }
  return out;
}

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
      stage_id: clean(l.stage_id).slice(0, 64) || null,
      // A verification line names the picking job its goods came from: how a store's shortage finds its picker.
      picking_job: clean(meta(l.meta).picking_job).slice(0, 64) || null,
      job_state: clean(l.state).toUpperCase().slice(0, 30) || null,
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
      nlc: null,
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
      stage_id: clean(l.stage_id).slice(0, 64) || null,
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
      nlc: null,
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
  buildNlcQuery,
  nlcByArticle,
  buildJobLinesQuery,
  buildBoxLinesQuery,
  storeNames,
  buildStuckLoadingQuery,
  buildBoxPackQuery,
  mapStuckCartons,
  istDateTime,
  mapJobLines,
  mapBoxLines,
};
