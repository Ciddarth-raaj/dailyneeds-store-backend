/**
 * The stage chain: every line of goods followed through
 *
 *   Picked -> Packed -> Loaded -> Unloaded -> Verified
 *
 * from BOX_CHAIN_FROM, by its document (stage_id) + article + the store it
 * goes to, in qty. Each gap between two stages is a ledger for the day:
 *
 *   waiting from earlier days + arrived today - moved on today = stands tonight
 *
 * "Moved on" includes what the next stage recorded short (lost). Matching,
 * in this order:
 *   1. by job: RetailPilot records which job each line came from - a packing
 *      line its picking_job, a loading box its packing_job(s) (or the
 *      pick-pack picking_job), a verification line its unloading_job. Carton
 *      barcodes are reused on every delivery and loading is often the day
 *      after packing, so the job link is the only exact one;
 *   2. else the same document + article + store, oldest first;
 *   3. else any document of that article + store, oldest first - except,
 *      from picked to packed, for a packing line that names its picking job:
 *      its extra never takes another document's goods.
 * What the next stage records with nothing waiting for it at all
 * "jumped" a stage. Goods that stay put (from = to store) never move on and
 * are left out. Loaded -> Unloaded is followed by box in utils/wh_box_chain.js.
 *
 * Pure: the usecase reads utils' stageFlows and this follows them.
 */
const { BOX_CHAIN_FROM } = require("./wh_box_chain");

/** Waiting more than this many days is stuck (the warehouse allows 2). */
const STUCK_DAYS = 2;

const n = (v) => Number(v) || 0;
const r3 = (v) => Math.round(n(v) * 1000) / 1000;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const addDays = (day, k) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const lane = (e) => `${e.article_id}|${e.to_store || ""}`;
const exact = (e) => `${e.stage_id || "-"}|${lane(e)}`;
const staysPut = (e) => e.from_store && e.to_store && e.from_store === e.to_store;

/** Follow one gap up to `cutoff`: what is still waiting, and what jumped. */
/**
 * Follow one gap up to `cutoff` in one pass: what is still waiting at the
 * end of `cutoff`, what was waiting at the end of the day before it
 * (`before`), and what jumped. Every list is sorted once and read from a
 * moving start, so a long history costs little.
 */
function follow(ins, outs, cutoff, { strict = false } = {}) {
  const byDate = (a, b) => (a.report_date < b.report_date ? -1 : a.report_date > b.report_date ? 1 : 0);
  const all = [];
  const layers = new Map(); // exact key -> [layer]
  const byLane = new Map(); // lane -> [layer]
  const byLink = new Map(); // job id | article | store -> [layer]
  const add = (m, k, layer) => {
    let list = m.get(k);
    if (!list) {
      list = [];
      list.start = 0;
      m.set(k, list);
    }
    list.push(layer);
  };
  for (const e of ins) {
    if (e.report_date > cutoff || n(e.qty) <= 0) continue;
    const layer = { ...e, left: n(e.qty) };
    all.push(layer);
    add(layers, exact(e), layer);
    add(byLane, lane(e), layer);
    for (const id of [].concat(e.link || [])) add(byLink, `${id}|${e.article_id}|${e.to_store || ""}`, layer);
  }
  for (const m of [layers, byLane, byLink]) for (const list of m.values()) list.sort(byDate);
  const take = (list, o, want) => {
    let need = want;
    while (list.start < list.length && list[list.start].left <= 0) list.start += 1; // skip what is used up
    for (let i = list.start; i < list.length && need > 0; i += 1) {
      const l = list[i];
      if (l.report_date > o.report_date) break; // sorted: the rest came later
      if (l.left <= 0) continue;
      const q = Math.min(l.left, need);
      l.left = r3(l.left - q);
      need = r3(need - q);
    }
    return need;
  };
  const sorted = outs.filter((o) => o.report_date <= cutoff && n(o.qty) > 0).sort(byDate);
  const jumped = [];
  const prevDay = addDays(cutoff, -1);
  let before = null;
  const snapshot = () => all.filter((l) => l.report_date <= prevDay && l.left > 0).map((l) => ({ ...l }));
  for (const o of sorted) {
    if (before === null && o.report_date === cutoff) before = snapshot();
    let need = n(o.qty);
    for (const id of o.links || []) {
      if (need <= 0) break;
      const list = byLink.get(`${id}|${o.article_id}|${o.to_store || ""}`);
      if (list) need = take(list, o, need);
    }
    if (need > 0 && o.stage_id && layers.has(exact(o))) need = take(layers.get(exact(o)), o, need);
    // Any document of the article + store only for lines that carry no job link (pulled before
    // links were kept). A linked line's extra must not eat another document's goods: it took the
    // oldest - the really stuck ones - off the list (gold winner 1l, pCK8q6adQLCt, 10 left 19 days).
    // `strict` (picked -> packed only, where a packing line's picking_job is exact): a linked line's
    // extra must not eat another document's goods. Elsewhere links are partial (a carton is unloaded
    // in several unloading jobs, a verification names one; cartons carry no document), so a linked
    // line still falls back to the article + store.
    const linked = (o.links || []).length > 0;
    if (need > 0 && !(strict && linked) && byLane.has(lane(o))) need = take(byLane.get(lane(o)), o, need);
    if (need > 0) jumped.push({ ...o, qty: need });
  }
  if (before === null) before = snapshot();
  return { waiting: all.filter((l) => l.left > 0), before, jumped };
}

function gap({ key, label, unit, ins, outs, lost, date, carried = [], strict = false }) {
  // `carried`: what was still waiting at the end of the day before (stored), so
  // a day is worked out without re-reading every earlier day.
  const I = [...carried, ...ins.filter((e) => !staysPut(e))];
  const O = outs.filter((e) => !staysPut(e));
  const cur = follow(I, O, date, { strict });
  const sum = (list, f = "left") => r3(list.reduce((s, x) => s + n(x[f]), 0));
  const fromEarlier = sum(cur.before);
  const arrived = sum(I.filter((e) => e.report_date === date), "qty");
  const stands = sum(cur.waiting);
  // One line per document + article + store, aged by its oldest waiting qty.
  const lines = new Map();
  for (const w of cur.waiting) {
    const k = exact(w);
    const l = lines.get(k) || { stage_id: w.stage_id || null, article_id: w.article_id, article_name: w.article_name || null, from_store: w.from_store || null, to_store: w.to_store || null, qty: 0, value: 0, since: w.report_date, nlc: n(w.nlc) };
    l.qty = r3(l.qty + w.left);
    l.value = r2(l.value + w.left * n(w.nlc));
    if (w.report_date < l.since) l.since = w.report_date;
    if (!l.article_name && w.article_name) l.article_name = w.article_name;
    lines.set(k, l);
  }
  const list = [...lines.values()].map((l) => ({ ...l, days: daysBetween(l.since, date) })).sort((a, b) => b.days - a.days || b.value - a.value);
  const jumpedToday = cur.jumped.filter((j) => j.report_date === date).map((j) => ({ stage_id: j.stage_id || null, article_id: j.article_id, article_name: j.article_name || null, from_store: j.from_store || null, to_store: j.to_store || null, qty: r3(j.qty), value: r2(n(j.qty) * n(j.nlc)) }));
  const lostToday = (lost || []).filter((e) => e.report_date === date && n(e.qty) > 0 && !staysPut(e));
  return {
    key,
    label,
    unit,
    from_earlier: fromEarlier,
    arrived,
    moved_on: r3(fromEarlier + arrived - stands),
    stands,
    value: r2(list.reduce((s, l) => s + l.value, 0)),
    lines: list.length,
    oldest_days: list.length ? list[0].days : 0,
    stuck: list.filter((l) => l.days > STUCK_DAYS).length,
    lost: {
      qty: r3(lostToday.reduce((s, e) => s + n(e.qty), 0)),
      value: r2(lostToday.reduce((s, e) => s + n(e.qty) * n(e.nlc), 0)),
      lines: lostToday.length,
      // What the next stage found short today, line by line: who, when, which job.
      list: lostToday
        .map((e) => ({ stage_id: e.stage_id || null, article_id: e.article_id, article_name: e.article_name || null, from_store: e.from_store || null, to_store: e.to_store || null, qty: r3(e.qty), value: r2(n(e.qty) * n(e.nlc)), worked_by: e.worked_by || null, finished_at: e.finished_at || null, job_id: e.job_id || null }))
        .sort((a, b) => b.value - a.value || b.qty - a.qty)
        .slice(0, 200),
    },
    jumped: { qty: r3(jumpedToday.reduce((s, j) => s + j.qty, 0)), lines: jumpedToday.length, list: jumpedToday.slice(0, 200) },
    list: list.slice(0, 300),
    // Everything still waiting tonight, for tomorrow to start from (not sent to the page).
    open: cur.waiting.map((w) => ({ report_date: w.report_date, stage_id: w.stage_id || null, article_id: w.article_id, article_name: w.article_name || null, from_store: w.from_store || null, to_store: w.to_store || null, link: [].concat(w.link || []), qty: r3(w.left), nlc: w.nlc == null ? null : n(w.nlc) })),
  };
}

/**
 * @param jobs  stageFlows().jobs: { report_type, report_date, stage_id, article_id, article_name, from_store, to_store, pick_pack, qty, short_qty, nlc, no_state }
 * @param boxes stageFlows().boxes: { report_type, report_date, stage_id, article_id, article_name, from_store, to_store, qty, nlc }
 */
function buildStageChain({ jobs, boxes, date, carried = null }) {
  // With `carried` (the stored end of the day before) only `date`'s rows are
  // new events; earlier rows passed in are context, to tell pick-packs and
  // carton splits apart.
  const isNew = (r) => !carried || r.report_date === date;
  const J = (t, pred = () => true) => (jobs || []).filter((r) => r.report_type === t && pred(r));
  const B = (t) => (boxes || []).filter((r) => r.report_type === t && isNew(r));
  const shortOf = (rows) => rows.filter((r) => n(r.short_qty) > 0).map((r) => ({ ...r, qty: n(r.short_qty) }));
  // `link`: this stage's job id; `links`: the job(s) of the stage before that this line came from.
  const ids = (...vals) => [...new Set(vals.flatMap((v) => String(v || "").split(",")).map((v) => v.trim()).filter(Boolean))];
  // A PICKED_PACKED (pick-pack) picking line is packed in full in that job.
  // RetailPilot may then split part of it into cartons with packing jobs
  // (GRN: 373 pick-packed, 3 packing jobs of 120 into cartons, 13 straight
  // into a crate) - those packing jobs only split what is already packed:
  // they are not packed again (their shortages still count as lost). Found
  // by the packing line's picking_job, or on days pulled before job links by
  // the same document + article + store as a pick-pack line.
  const pickPackJobs = new Set();
  const pickPackLanes = new Set();
  for (const r of J("PICKING", (x) => n(x.pick_pack))) {
    if (r.job_id) pickPackJobs.add(`${r.job_id}|${r.article_id}|${r.to_store || ""}`);
    if (r.stage_id) pickPackLanes.add(`${r.stage_id}|${r.article_id}|${r.to_store || ""}`);
  }
  const splitsPickPack = (r) =>
    (r.picking_job && pickPackJobs.has(`${r.picking_job}|${r.article_id}|${r.to_store || ""}`)) ||
    (!r.picking_job && r.stage_id && pickPackLanes.has(`${r.stage_id}|${r.article_id}|${r.to_store || ""}`));
  // System packing jobs (no person on them) can also split goods a person
  // already packed into cartons (leaf broom: picked 20, packed 20 by a
  // packer, then 4 system packing jobs of 5 - packing adds up to 40). When a
  // person's packing of a picking job already covers what was picked, its
  // unassigned packing jobs are those splits and are not packed again.
  const groupOf = (r, job) => (job ? `J|${job}|${r.article_id}|${r.to_store || ""}` : r.stage_id ? `S|${r.stage_id}|${r.article_id}|${r.to_store || ""}` : null);
  const pickedQty = new Map();
  for (const r of J("PICKING", (x) => !n(x.pick_pack))) {
    for (const k of [groupOf(r, r.job_id), groupOf(r, null)].filter(Boolean)) pickedQty.set(k, (pickedQty.get(k) || 0) + n(r.qty) + n(r.short_qty));
  }
  // Only when a PERSON's packing already covers what was picked: system
  // packing jobs alone are the packing (gold winner 1L: picked 120, 13
  // system packing jobs of 10, no person's packing - those 13 are real).
  const personPacked = new Map();
  const packGroup = (r) => (r.picking_job && pickedQty.has(groupOf(r, r.picking_job)) ? groupOf(r, r.picking_job) : groupOf(r, null));
  for (const r of J("PACKING", (x) => x.worked_by)) {
    const k = packGroup(r);
    if (k) personPacked.set(k, (personPacked.get(k) || 0) + n(r.qty) + n(r.short_qty));
  }
  const cartonSplit = (r) => {
    if (r.worked_by) return false;
    const k = packGroup(r);
    return Boolean(k && pickedQty.has(k) && (personPacked.get(k) || 0) >= pickedQty.get(k) - 1e-6);
  };
  const picked = J("PICKING", (r) => !n(r.pick_pack)).map((r) => ({ ...r, link: r.job_id || null }));
  const pickPacked = J("PICKING", (r) => n(r.pick_pack)).map((r) => ({ ...r, link: r.job_id || null }));
  // A packed line is reached by its own job, or - for cartons split from it - by its picking job.
  const packing = J("PACKING", (r) => !splitsPickPack(r) && !cartonSplit(r)).map((r) => ({ ...r, link: ids(r.job_id, r.picking_job), links: ids(r.picking_job) }));
  const splitShort = J("PACKING", (r) => splitsPickPack(r) && n(r.short_qty) > 0).map((r) => ({ ...r, qty: n(r.short_qty), links: ids(r.picking_job) }));
  const verification = J("VERIFICATION").map((r) => ({ ...r, links: ids(r.unloading_job) }));
  const loaded = B("LOADING").map((r) => ({ ...r, links: ids(r.packing_jobs, r.picking_job) }));
  // Boxes written off at loading (outside the normal flow): their goods leave "packed, not yet loaded" -
  // found by the same links as a loaded box - and are listed as an exception, not as stuck.
  const writtenOff = B("WRITEOFF").map((r) => ({ ...r, links: ids(r.packing_jobs, r.picking_job) }));
  const unloaded = B("UNLOADING").map((r) => ({ ...r, link: r.job_id || null }));
  const today = (rows) => r3(rows.filter((r) => r.report_date === date && !staysPut(r)).reduce((s, r) => s + n(r.qty), 0));
  const T = (rows) => rows.filter(isNew);
  const C = (k) => (carried && carried[k]) || [];
  const gaps = [
    gap({ key: "to_pack", label: "Picked, not yet packed", unit: "qty", strict: true, ins: T(picked), outs: T([...packing, ...shortOf(packing)]), lost: T(shortOf(packing)), date, carried: C("to_pack") }),
    gap({ key: "to_load", label: "Packed, not yet loaded", unit: "qty", ins: T([...packing, ...pickPacked]), outs: T([...loaded, ...splitShort, ...writtenOff]), lost: T(splitShort), date, carried: C("to_load") }),
    gap({ key: "to_verify", label: "Unloaded, not yet verified", unit: "qty", ins: T(unloaded), outs: T([...verification, ...shortOf(verification)]), lost: T(shortOf(verification)), date, carried: C("to_verify") }),
  ];
  // Days the chain cannot follow by job state (uploaded files, or pulled before states were kept).
  // ... or by job link (loading boxes pulled before the packing job was kept).
  const noState = [
    ...new Set([
      ...(jobs || []).filter((r) => r.report_type === "PICKING" && n(r.no_state) > 0 && isNew(r)).map((r) => r.report_date),
      ...(boxes || []).filter((r) => r.report_type === "LOADING" && n(r.no_link) > 0 && isNew(r)).map((r) => r.report_date),
    ]),
  ].sort();
  return {
    date,
    from: BOX_CHAIN_FROM,
    stages: {
      picked: today([...picked, ...pickPacked]),
      packed: today([...packing, ...pickPacked]),
      loaded: today(loaded),
      unloaded: today(unloaded),
      verified: today(verification),
    },
    gaps,
    days_without_state: noState,
  };
}

module.exports = { STUCK_DAYS, buildStageChain, follow };
