/**
 * The box chain: every box followed from the day it is loaded until the day
 * it is unloaded, from BOX_CHAIN_FROM onwards, so a day reads as a running
 * ledger that always adds up:
 *
 *   open from earlier days + loaded today - unloaded today = still open
 *
 * A box is its box id AND the store it is going to: box ids (carton
 * barcodes) are reused, the same id going to several stores on one day.
 *
 * Loads and unloads of one box are paired in date order: each unloading
 * closes the earliest still-open loading of that box on or before its day.
 * An unloading with no open loading is "unloaded, not loaded" (loaded
 * before BOX_CHAIN_FROM, or never on a loading report).
 *
 * Pure: the usecase reads box summaries (one row per day per box) and this
 * pairs them.
 */

const BOX_CHAIN_FROM = "2026-10-10";

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const keyOf = (b) => `${b.box_id}|${b.planned_to_store || ""}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * @param loads   [{ report_date, box_id, planned_to_store, from_store, job_type, truck_no, articles, qty, value, finished_at }]
 * @param unloads [{ report_date, box_id, planned_to_store, unloaded_store, from_store, job_type, truck_no, articles, qty, value, finished_at }]
 * @param date    the day looked at; loads and unloads after it are ignored
 */
function buildChain({ loads, unloads, date }) {
  const byKey = new Map();
  for (const l of loads || []) {
    if (l.report_date > date) continue;
    const k = keyOf(l);
    if (!byKey.has(k)) byKey.set(k, { loads: [], unloads: [] });
    byKey.get(k).loads.push({ ...l, closed_by: null });
  }
  for (const u of unloads || []) {
    if (u.report_date > date) continue;
    const k = keyOf(u);
    if (!byKey.has(k)) byKey.set(k, { loads: [], unloads: [] });
    byKey.get(k).unloads.push(u);
  }

  const opening = []; // loaded before `date`, still open at the start of `date`
  const loadedToday = [];
  const closedOld = []; // unloaded today, loaded on an earlier day
  const closedToday = []; // unloaded today, loaded today
  const stillOpen = []; // not unloaded by the end of `date`
  const notLoaded = []; // unloaded today, no open loading to pair with
  const wrongStore = []; // unloaded today at a store other than planned

  const entry = (l, extra = {}) => ({
    box_id: l.box_id,
    from_store: l.from_store || null,
    to_store: l.planned_to_store || null,
    job_type: l.job_type || null,
    truck_no: l.truck_no || null,
    loaded_on: l.report_date,
    loaded_at: l.finished_at || null,
    articles: n(l.articles),
    qty: n(l.qty),
    value: r2(l.value),
    ...extra,
  });

  for (const box of byKey.values()) {
    box.loads.sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)) || String(a.finished_at || "").localeCompare(String(b.finished_at || "")));
    box.unloads.sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)) || String(a.finished_at || "").localeCompare(String(b.finished_at || "")));
    for (const u of box.unloads) {
      const l = box.loads.find((x) => !x.closed_by && x.report_date <= u.report_date);
      if (l) l.closed_by = u;
      if (u.report_date !== date) continue;
      if (!l) {
        notLoaded.push({
          box_id: u.box_id,
          from_store: u.from_store || null,
          to_store: u.planned_to_store || null,
          unloaded_store: u.unloaded_store || null,
          job_type: u.job_type || null,
          truck_no: u.truck_no || null,
          unloaded_at: u.finished_at || null,
          articles: n(u.articles),
          qty: n(u.qty),
          value: r2(u.value),
        });
        continue;
      }
      const e = entry(l, { unloaded_on: u.report_date, unloaded_at: u.finished_at || null, unloaded_store: u.unloaded_store || null, days_late: daysBetween(l.report_date, u.report_date), unloaded_qty: n(u.qty) });
      if (l.report_date < date) closedOld.push(e);
      else closedToday.push(e);
      if (u.unloaded_store && l.planned_to_store && u.unloaded_store !== l.planned_to_store) wrongStore.push(e);
    }
    for (const l of box.loads) {
      const openAtStart = l.report_date < date && (!l.closed_by || l.closed_by.report_date >= date);
      if (openAtStart) opening.push(entry(l, { days_open: daysBetween(l.report_date, date) }));
      if (l.report_date === date) loadedToday.push(l);
      if (!l.closed_by) stillOpen.push(entry(l, { days_open: daysBetween(l.report_date, date) }));
    }
  }

  const byAge = (a, b) => String(a.loaded_on).localeCompare(String(b.loaded_on)) || b.qty - a.qty;
  stillOpen.sort(byAge);
  opening.sort(byAge);
  closedOld.sort(byAge);
  const sum = (list, f) => r2(list.reduce((s, x) => s + n(x[f]), 0));
  const trucks = new Set(loadedToday.filter((l) => l.truck_no).map((l) => l.truck_no));
  return {
    date,
    from: BOX_CHAIN_FROM,
    opening: { boxes: opening.length, qty: sum(opening, "qty"), value: sum(opening, "value") },
    loaded: { boxes: loadedToday.length, qty: sum(loadedToday, "qty"), trucks: trucks.size },
    unloaded: {
      boxes: closedToday.length + closedOld.length,
      from_today: closedToday.length,
      from_earlier: closedOld.length,
      qty: sum([...closedToday, ...closedOld], "unloaded_qty"),
    },
    still_open: { boxes: stillOpen.length, qty: sum(stillOpen, "qty"), value: sum(stillOpen, "value"), loaded_today: stillOpen.filter((x) => x.loaded_on === date).length, older: stillOpen.filter((x) => x.loaded_on < date).length, oldest_days: stillOpen.length ? Math.max(...stillOpen.map((x) => x.days_open)) : 0 },
    not_loaded: { boxes: notLoaded.length, qty: sum(notLoaded, "qty") },
    wrong_store: { boxes: wrongStore.length },
    lists: { still_open: stillOpen, closed_old: closedOld, not_loaded: notLoaded, wrong_store: wrongStore, opening },
  };
}

module.exports = { BOX_CHAIN_FROM, buildChain, keyOf };
