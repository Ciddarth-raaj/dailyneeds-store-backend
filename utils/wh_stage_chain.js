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
 * "Moved on" includes what the next stage recorded short (lost). Matching:
 * the next stage takes from the same document + article + store, oldest
 * first; where it has no document (cartons, uploaded files) or nothing is
 * waiting under it, from any document of that article + store, oldest
 * first. What the next stage records with nothing waiting for it at all
 * "jumped" a stage. Goods that stay put (from = to store) never move on and
 * are left out. Loaded -> Unloaded is followed by box in utils/wh_box_chain.js.
 *
 * Pure: the usecase reads utils' stageFlows and this follows them.
 */
const { BOX_CHAIN_FROM } = require("./wh_box_chain");

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
function follow(ins, outs, cutoff) {
  const layers = new Map(); // exact key -> [{...in, left}]
  const byLane = new Map(); // lane -> Set(exact key)
  for (const e of ins) {
    if (e.report_date > cutoff || n(e.qty) <= 0) continue;
    const k = exact(e);
    if (!layers.has(k)) layers.set(k, []);
    layers.get(k).push({ ...e, left: n(e.qty) });
    if (!byLane.has(lane(e))) byLane.set(lane(e), new Set());
    byLane.get(lane(e)).add(k);
  }
  for (const list of layers.values()) list.sort((a, b) => a.report_date.localeCompare(b.report_date));
  const jumped = [];
  const take = (list, o, want) => {
    let need = want;
    for (const l of list) {
      if (need <= 0) break;
      if (l.left <= 0 || l.report_date > o.report_date) continue;
      const q = Math.min(l.left, need);
      l.left = r3(l.left - q);
      need = r3(need - q);
    }
    return need;
  };
  const sorted = outs.filter((o) => o.report_date <= cutoff && n(o.qty) > 0).sort((a, b) => a.report_date.localeCompare(b.report_date));
  for (const o of sorted) {
    let need = n(o.qty);
    if (o.stage_id && layers.has(exact(o))) need = take(layers.get(exact(o)), o, need);
    if (need > 0 && byLane.has(lane(o))) {
      const all = [...byLane.get(lane(o))].flatMap((k) => layers.get(k)).sort((a, b) => a.report_date.localeCompare(b.report_date));
      need = take(all, o, need);
    }
    if (need > 0) jumped.push({ ...o, qty: need });
  }
  const waiting = [];
  for (const list of layers.values()) for (const l of list) if (l.left > 0) waiting.push(l);
  return { waiting, jumped };
}

function gap({ key, label, unit, ins, outs, lost, date }) {
  const I = ins.filter((e) => !staysPut(e));
  const O = outs.filter((e) => !staysPut(e));
  const prev = follow(I, O, addDays(date, -1));
  const cur = follow(I, O, date);
  const sum = (list, f = "left") => r3(list.reduce((s, x) => s + n(x[f]), 0));
  const fromEarlier = sum(prev.waiting);
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
    stuck: list.filter((l) => l.days >= 2).length,
    lost: { qty: r3(lostToday.reduce((s, e) => s + n(e.qty), 0)), value: r2(lostToday.reduce((s, e) => s + n(e.qty) * n(e.nlc), 0)), lines: lostToday.length },
    jumped: { qty: r3(jumpedToday.reduce((s, j) => s + j.qty, 0)), lines: jumpedToday.length, list: jumpedToday.slice(0, 200) },
    list: list.slice(0, 300),
  };
}

/**
 * @param jobs  stageFlows().jobs: { report_type, report_date, stage_id, article_id, article_name, from_store, to_store, pick_pack, qty, short_qty, nlc, no_state }
 * @param boxes stageFlows().boxes: { report_type, report_date, stage_id, article_id, article_name, from_store, to_store, qty, nlc }
 */
function buildStageChain({ jobs, boxes, date }) {
  const J = (t, pred = () => true) => (jobs || []).filter((r) => r.report_type === t && pred(r));
  const B = (t) => (boxes || []).filter((r) => r.report_type === t);
  const shortOf = (rows) => rows.filter((r) => n(r.short_qty) > 0).map((r) => ({ ...r, qty: n(r.short_qty) }));
  const picked = J("PICKING", (r) => !n(r.pick_pack));
  const pickPacked = J("PICKING", (r) => n(r.pick_pack));
  const packing = J("PACKING");
  const verification = J("VERIFICATION");
  const loaded = B("LOADING");
  const unloaded = B("UNLOADING");
  const today = (rows) => r3(rows.filter((r) => r.report_date === date && !staysPut(r)).reduce((s, r) => s + n(r.qty), 0));
  const gaps = [
    gap({ key: "to_pack", label: "Picked, not yet packed", unit: "qty", ins: picked, outs: [...packing, ...shortOf(packing)], lost: shortOf(packing), date }),
    gap({ key: "to_load", label: "Packed, not yet loaded", unit: "qty", ins: [...packing, ...pickPacked], outs: loaded, lost: [], date }),
    gap({ key: "to_verify", label: "Unloaded, not yet verified", unit: "qty", ins: unloaded, outs: [...verification, ...shortOf(verification)], lost: shortOf(verification), date }),
  ];
  // Days the chain cannot follow by job state (uploaded files, or pulled before states were kept).
  const noState = [...new Set((jobs || []).filter((r) => r.report_type === "PICKING" && n(r.no_state) > 0).map((r) => r.report_date))].sort();
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

module.exports = { buildStageChain, follow };
