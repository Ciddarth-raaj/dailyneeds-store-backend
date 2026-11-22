/**
 * Warehouse Health - the warehouse manager's dashboard under Invoice
 * Pipeline, and its 9 am Telegram summary. Built from the Warehouse Daily
 * Reports (pulled from RetailPilot every night), for one day (default
 * yesterday), with pickers over the month to that day.
 *
 * Pure: the usecase reads, this turns what was read into what is shown, so
 * the page and the Telegram message always say the same thing.
 */

const ACCURACY_TARGET = 0.98;
const LABEL = { PICKING: "Picking", PACKING: "Packing", VERIFICATION: "Verification", LOADING: "Loading", UNLOADING: "Unloading" };

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const fmt = (v) => Math.round(n(v)).toLocaleString("en-IN");
const rupees = (v) => {
  const x = n(v);
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2)} Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(2)} L`;
  return `₹${fmt(x)}`;
};
const title = (s) => {
  const t = String(s || "").trim();
  return t.length <= 3 ? t.toUpperCase() : t.replace(/\b\w/g, (c) => c.toUpperCase());
};
const blankJob = () => ({ lines: 0, done_lines: 0, actual_qty: 0, actual_value: 0, short_lines: 0, short_qty: 0, short_value: 0, open_lines: 0, returned_qty: 0 });

function addDays(day, k) {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
}
const monthStart = (day) => `${day.slice(0, 8)}01`;
const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** A RetailPilot user id (or several, comma-separated) as names where HR has mapped them. */
function staffLabel(ids, names) {
  return String(ids || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => (names && names[id] ? names[id] : id))
    .join(", ");
}

/** Box lines (from reconcileBoxes) -> one row per box with an issue, worst first. */
function boxIssues(lines) {
  const by = new Map();
  for (const l of lines || []) {
    if (!["NOT_ON_TRUCK", "NOT_UNLOADED", "WRONG_STORE", "QTY_DIFF", "NOT_LOADED"].includes(l.status)) continue;
    const k = `${l.report_date}|${l.box_id}|${l.status}`;
    const b = by.get(k) || {
      status: l.status,
      box_id: l.box_id,
      store: l.planned_to_store || l.unloaded_store || null,
      unloaded_store: l.unloaded_store || null,
      truck_no: l.truck_no || null,
      job_type: l.job_type || null,
      articles: 0,
      qty: 0,
      value: 0,
      items: [],
    };
    b.articles += 1;
    // The units at stake: the difference when quantities differ, else the whole line.
    const q = l.status === "QTY_DIFF" ? Math.abs(n(l.loaded_qty) - n(l.unloaded_qty)) : n(l.loaded_qty == null ? l.unloaded_qty : l.loaded_qty);
    b.qty += q;
    b.value += q * n(l.nlc);
    if (b.items.length < 100) b.items.push({ article_id: l.article_id, article_name: l.article_name || null, qty: q, value: r2(q * n(l.nlc)) });
    by.set(k, b);
  }
  const order = { NOT_ON_TRUCK: 0, NOT_UNLOADED: 1, WRONG_STORE: 2, QTY_DIFF: 3, NOT_LOADED: 4 };
  return [...by.values()].map((b) => ({ ...b, value: r2(b.value) })).sort((a, b) => order[a.status] - order[b.status] || b.qty - a.qty);
}

/**
 * Picker table for the month: what each picker picked (finished lines,
 * units, NLC value) and the shortages stores found in their picking.
 * Accuracy = 1 - mistake lines / lines picked; below ACCURACY_TARGET is
 * flagged. Lines with no recorded picker are left out.
 */
function pickers(work, mistakes, names) {
  const by = new Map();
  for (const w of work || []) {
    if (!w.worked_by) continue;
    const p = by.get(w.worked_by) || { id: w.worked_by, lines: 0, qty: 0, value: 0, mistake_lines: 0, mistake_qty: 0, mistake_value: 0, mistakes: [] };
    p.lines += n(w.done_lines);
    p.qty += n(w.actual_qty);
    p.value = r2(p.value + n(w.actual_value));
    by.set(w.worked_by, p);
  }
  for (const m of mistakes || []) {
    if (!m.worked_by) continue;
    const p = by.get(m.worked_by) || { id: m.worked_by, lines: 0, qty: 0, value: 0, mistake_lines: 0, mistake_qty: 0, mistake_value: 0, mistakes: [] };
    p.mistake_lines += 1;
    p.mistake_qty += n(m.short_qty);
    p.mistake_value = r2(p.mistake_value + n(m.short_qty) * n(m.nlc));
    if (p.mistakes.length < 50) {
      p.mistakes.push({ date: m.report_date, store: m.to_store, article_id: m.article_id, article_name: m.article_name, short_qty: n(m.short_qty), value: r2(n(m.short_qty) * n(m.nlc)) });
    }
    by.set(m.worked_by, p);
  }
  return [...by.values()]
    .map((p) => {
      const accuracy = p.lines > 0 ? Math.max(0, 1 - p.mistake_lines / p.lines) : null;
      return { ...p, name: staffLabel(p.id, names), mapped: Boolean(names && names[p.id]), accuracy, below_target: accuracy != null && accuracy < ACCURACY_TARGET };
    })
    .sort((a, b) => b.lines - a.lines || b.value - a.value);
}

/** Pickers split by the kind of picking job: STA on its own, everything else (Alloc, GRN, DAMG, ...) together. */
const isSta = (t) => String(t || "").toUpperCase() === "STA";
const PICKER_GROUPS = [
  { key: "sta", label: "STA", has: isSta },
  { key: "other", label: "Others (Alloc, GRN, DAMG)", has: (t) => !isSta(t) },
];
function pickerGroups(work, mistakes, names) {
  return PICKER_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    rows: pickers((work || []).filter((w) => g.has(w.job_type)), (mistakes || []).filter((m) => g.has(m.job_type)), names),
  }));
}

/**
 * Everything the dashboard shows for `date`, from what the usecase read.
 * With `boxChain` (utils/wh_box_chain.js, from BOX_CHAIN_FROM) Unloading is
 * the running ledger of boxes: open from earlier days + loaded - unloaded =
 * still open.
 */
function buildHealth(args) {
  const h = withStuck(withStageChain(withBoxChain(buildHealthBase(args), args.boxChain), args.stageChain, args.staffNames), args.stuckCartons);
  // Where the stored chain stands: final, or being worked out / redone (with progress).
  h.chain_status = args.chainStatus || null;
  return h;
}

/**
 * Stuck cartons, live from RetailPilot: packed into a carton, a loading job
 * made, not loaded for more than 2 days. Not tied to the day looked at.
 */
function withStuck(h, s) {
  if (!s) return h;
  if (!s.ok) {
    h.stuck_cartons = { ok: false, msg: s.msg };
    return h;
  }
  const cartons = s.cartons || [];
  const units = cartons.reduce((t, c) => t + n(c.units), 0);
  const value = r2(cartons.reduce((t, c) => t + n(c.value), 0));
  h.stuck_cartons = { ok: true, at: s.at, stuck_days: s.stuck_days, cartons: cartons.slice(0, 300), count: cartons.length, units, value, oldest_days: cartons.length ? cartons[0].days : 0, packer_note: s.packer_note || null };
  if (cartons.length) {
    h.need_you.unshift({
      key: "stuck_cartons",
      tone: "red",
      text: `Stuck cartons: ${cartons.length} packed, loading job open more than ${s.stuck_days} days (${fmt(units)} units · ${rupees(value)} · oldest ${cartons[0].days} days)`,
    });
  }
  return h;
}

/**
 * The site's other direction, below the main chain: at the warehouse, what
 * the stores sent to it (returns); at a store, what the store itself sent.
 * Shown only when something moved or waits; what needs a look is added to
 * "things need you", named by the title.
 */
function withSecondChain(h, result, { title: heading, direction, staffNames }) {
  h.second = null;
  if (!result || !result.stage) return h;
  const mini = { tiles: { unloading: {}, loading: {} }, flow: {}, need_you: [] };
  withStageChain(withBoxChain(mini, result.box), { ...result.stage, days_without_state: [] }, staffNames);
  const sc = mini.stage_chain;
  const b = sc.boxes;
  const moved = Object.entries(sc.stages).some(([k, v]) => !k.endsWith("_boxes") && n(v) > 0) || sc.gaps.some((g) => n(g.stands) > 0 || n(g.arrived) > 0) || (b && (b.loaded.boxes || b.unloaded.boxes || b.still_open.boxes));
  if (!moved) return h;
  h.second = { title: heading, direction, stage_chain: sc, unloading: mini.tiles.unloading };
  for (const i of mini.need_you) h.need_you.push({ ...i, key: `second_${i.key}`, text: `${heading} - ${i.text}` });
  return h;
}

function withStageChain(h, sc, staffNames) {
  if (!sc) return h;
  // The stage chain heads the page: what stands between each two stages tonight.
  const box = h.tiles.unloading.chain;
  // Names of whoever found a shortage (RetailPilot user ids, as HR has mapped them).
  for (const g of sc.gaps || []) for (const l of (g.lost && g.lost.list) || []) l.worker_name = l.worked_by ? staffLabel(l.worked_by, staffNames) : null;
  h.stage_chain = {
    from: sc.from,
    stages: { ...sc.stages, loaded_boxes: box ? box.loaded.boxes : null, unloaded_boxes: box ? box.unloaded.boxes : null },
    gaps: sc.gaps,
    boxes: box || null,
    days_without_state: sc.days_without_state,
  };
  const add = [];
  for (const g of sc.gaps) {
    if (g.stuck) add.push({ key: `chain_${g.key}`, tone: "red", text: `${g.label}: ${g.stuck} line${g.stuck === 1 ? "" : "s"} waiting more than 2 days (oldest ${g.oldest_days} days)` });
    const skipped = { to_pack: "Packed with no picking record", to_load: "Loaded with no packing record", to_verify: "Verified with no unloading record" }[g.key];
    if (g.jumped.lines) add.push({ key: `chain_${g.key}`, tone: "amber", text: `${skipped}: ${g.jumped.lines} line${g.jumped.lines === 1 ? "" : "s"} (${fmt(g.jumped.qty)} qty)` });
  }
  h.need_you.unshift(...add);
  return h;
}

function withBoxChain(h, c) {
  if (!c) return h;
  const asBox = (b, status) => ({ ...b, status, store: b.to_store, items: b.items || [] });
  const stillOpen = c.lists.still_open.map((b) => asBox(b, "NOT_UNLOADED"));
  const wrong = c.lists.wrong_store.map((b) => asBox(b, "WRONG_STORE"));
  const notLoaded = c.lists.not_loaded.map((b) => ({ ...b, status: "NOT_LOADED", store: b.to_store, items: b.items || [] }));
  h.tiles.unloading = {
    chain: {
      from: c.from,
      opening: c.opening,
      loaded: c.loaded,
      unloaded: c.unloaded,
      still_open: c.still_open,
      not_loaded: c.not_loaded,
      wrong_store: c.wrong_store,
      missing_days: c.missing_days || [],
    },
    loaded_boxes: c.loaded.boxes,
    unloaded_boxes: c.unloaded.boxes,
    problems: c.still_open.boxes + c.wrong_store.boxes + c.not_loaded.boxes,
    not_unloaded: c.still_open.boxes,
    wrong_store: c.wrong_store.boxes,
    not_loaded: c.not_loaded.boxes,
    still_open: stillOpen.slice(0, 300),
    closed_old: c.lists.closed_old.map((b) => asBox(b, "CLOSED_LATE")).slice(0, 300),
    list: [...stillOpen, ...wrong, ...notLoaded].slice(0, 300),
    waiting: [],
  };
  h.flow.unloaded_boxes = c.unloaded.boxes;
  h.flow.not_unloaded_boxes = c.still_open.boxes;
  h.flow.not_unloaded = stillOpen.slice(0, 200);
  // Loading counts the same box trips as the chain (box ids are reused).
  h.tiles.loading.boxes = c.loaded.boxes;
  h.tiles.loading.trucks = c.loaded.trucks;
  h.tiles.loading.on_truck = c.loaded.boxes - (c.loaded.no_truck || 0);
  h.flow.loading_list_boxes = c.loaded.boxes;
  h.flow.on_truck_boxes = h.tiles.loading.on_truck;
  h.flow.trucks = c.loaded.trucks;
  h.need_you = h.need_you.filter((i) => i.key !== "unloading");
  const at = h.need_you.findIndex((i) => i.key === "verification");
  const add = [];
  if (c.still_open.boxes) {
    add.push({
      key: "unloading",
      tone: "red",
      text: `Unloading: ${c.still_open.boxes} box${c.still_open.boxes === 1 ? "" : "es"} loaded and not unloaded (${fmt(c.still_open.qty)} qty${c.still_open.older ? `, ${c.still_open.older} from earlier days, oldest ${c.still_open.oldest_days} day${c.still_open.oldest_days === 1 ? "" : "s"}` : ""})`,
    });
  }
  if (c.wrong_store.boxes) add.push({ key: "unloading", tone: "red", text: `Unloading: ${c.wrong_store.boxes} box${c.wrong_store.boxes === 1 ? "" : "es"} unloaded at the wrong store` });
  if (c.not_loaded.boxes) add.push({ key: "unloading", tone: "amber", text: `Unloading: ${c.not_loaded.boxes} box${c.not_loaded.boxes === 1 ? "" : "es"} unloaded with no loading since ${dayText(c.from)}` });
  h.need_you.splice(at < 0 ? h.need_you.length : at, 0, ...add);
  return h;
}

function buildHealthBase({ writeoffLines, date, uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines: rawBoxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames }) {
  // The day looked at is over: a box put on a truck and not unloaded is a
  // problem, even if the next day's unloading is not pulled yet - not "still
  // awaiting". Only damage / returns going back to the warehouse are apart.
  // Unloading is scanned by box, so it answers only box questions: was the
  // box unloaded, and where. An article missing or short inside an unloaded
  // box is for store verification (Yet to verify / found short), not an
  // unloading problem.
  const opened = (rawBoxLines || []).map((l) => (l.status === "OPEN" ? { ...l, status: "NOT_UNLOADED" } : l));
  const someUnloaded = new Set(opened.filter((l) => l.unloaded_qty != null).map((l) => `${l.report_date}|${l.box_id}`));
  const boxLines = opened.map((l) => {
    if (l.status === "QTY_DIFF") return { ...l, status: "OK" };
    if (l.status === "NOT_UNLOADED" && someUnloaded.has(`${l.report_date}|${l.box_id}`)) return { ...l, status: "OK" };
    return l;
  });
  const reports = Object.fromEntries(Object.keys(LABEL).map((k) => [k, (uploads || []).some((u) => u.report_type === k)]));
  const job = Object.fromEntries(["PICKING", "PACKING", "VERIFICATION"].map((k) => [k, blankJob()]));
  for (const s of summary || []) if (job[s.report_type]) for (const f of Object.keys(blankJob())) job[s.report_type][f] = n(s[f]);

  // Picking write-off by job type (GRN / STA / ...), most lines first
  const jt = (t) => String(t || "Other").toUpperCase();
  const writeoffByType = (byJobType || [])
    .filter((r) => r.report_type === "PICKING" && n(r.short_lines))
    .map((r) => ({ job_type: jt(r.job_type), lines: n(r.short_lines), qty: n(r.short_qty), value: r2(r.short_value) }))
    .sort((a, b) => b.lines - a.lines);

  // Boxes
  const issues = boxIssues(boxLines);
  const countBy = (st) => issues.filter((b) => b.status === st).length;
  const loaded = (boxLines || []).filter((l) => l.status !== "NOT_LOADED");
  // A box is its box id AND the store it is going to: box ids are reused.
  const listBoxes = new Set(loaded.map((l) => `${l.report_date}|${l.box_id}|${l.planned_to_store || ""}`));
  const onTruck = new Set(loaded.filter((l) => l.truck_no).map((l) => `${l.report_date}|${l.box_id}|${l.planned_to_store || ""}`));
  // Unloading, by box id, from ONE set of boxes so the numbers always add up:
  // boxes on trucks (damage returns apart) = unloaded + not unloaded.
  const boxOf = (l) => String(l.box_id);
  const onTruckIds = new Set(loaded.filter((l) => l.truck_no).map(boxOf));
  const returnIds = new Set(loaded.filter((l) => l.status === "RETURN").map(boxOf));
  const unloadedIds = new Set((boxLines || []).filter((l) => l.unloaded_qty != null).map(boxOf));
  const listIds = new Set(loaded.map(boxOf));
  const expected = [...onTruckIds].filter((id) => !returnIds.has(id));
  const unloadedOf = expected.filter((id) => unloadedIds.has(id));
  const notUnloadedIds = new Set(expected.filter((id) => !unloadedIds.has(id)));
  const unloaded = new Set(unloadedOf);
  const boxEntry = (lines, status) => {
    const l0 = lines[0];
    const e = { box_id: l0.box_id, status, store: l0.planned_to_store || l0.unloaded_store || null, unloaded_store: l0.unloaded_store || null, truck_no: l0.truck_no || null, job_type: l0.job_type || null, articles: 0, qty: 0, value: 0, items: [] };
    for (const l of lines) {
      const q = n(l.loaded_qty == null ? l.unloaded_qty : l.loaded_qty);
      e.articles += 1;
      e.qty += q;
      e.value = r2(e.value + q * n(l.nlc));
      if (e.items.length < 100) e.items.push({ article_id: l.article_id, article_name: l.article_name || null, qty: q, value: r2(q * n(l.nlc)) });
    }
    return e;
  };
  const linesOf = (pred) => {
    const m = new Map();
    for (const l of boxLines || []) if (pred(l)) m.set(boxOf(l), [...(m.get(boxOf(l)) || []), l]);
    return m;
  };
  const notUnloadedList = [...linesOf((l) => l.status !== "NOT_LOADED" && notUnloadedIds.has(boxOf(l))).values()].map((ls) => boxEntry(ls, "NOT_UNLOADED"));
  const wrongStoreList = [...linesOf((l) => l.status === "WRONG_STORE" && expected.includes(boxOf(l))).values()].map((ls) => boxEntry(ls, "WRONG_STORE"));
  const notLoadedList = [...linesOf((l) => l.status === "NOT_LOADED" && !listIds.has(boxOf(l))).values()].map((ls) => boxEntry(ls, "NOT_LOADED"));
  const returnList = [...linesOf((l) => l.status === "RETURN" && !unloadedIds.has(boxOf(l))).values()].map((ls) => boxEntry(ls, "RETURN"));
  const gap = [...notUnloadedList, ...returnList].sort((x, y) => y.qty - x.qty);
  const trucks = new Set(loaded.filter((l) => l.truck_no).map((l) => l.truck_no));

  // Yet to verify (verification lines still open), by where they are to be verified
  const pending = (yetToVerify || []).map((r) => ({
    to_store: r.to_store,
    from_store: r.from_store,
    article_id: r.article_id,
    article_name: r.article_name,
    qty: Math.max(0, n(r.advised_qty) - n(r.actual_qty)),
    value: r2(Math.max(0, n(r.advised_qty) - n(r.actual_qty)) * n(r.nlc)),
    is_return: Boolean(r.to_store && r.from_store && r.to_store === "warehouse"),
  }));
  const pendingQty = pending.reduce((s, r) => s + r.qty, 0);

  // Remarks
  const rm = { WRITE_OFF: { total: 0, pending: 0, backlog: 0 }, VERIFICATION: { total: 0, pending: 0, backlog: 0 } };
  for (const r of remarks || []) if (rm[r.page]) rm[r.page] = { total: n(r.total), pending: n(r.pending), backlog: n(r.backlog) };

  // Stores
  const stores = new Map();
  const store = (name) => {
    const k = name || "(unknown)";
    if (!stores.has(k)) stores.set(k, { store: k, picking_short_qty: 0, picking_short_lines: 0, picking_short_value: 0, picking_by_type: {}, verification_short_qty: 0, yet_to_verify_qty: 0, box_issues: 0, open_lines: 0 });
    return stores.get(k);
  };
  for (const s of byStore || []) {
    const st = store(s.to_store);
    if (s.report_type === "PICKING") {
      st.picking_short_qty += n(s.short_qty);
      st.picking_short_lines += n(s.short_lines);
      st.picking_short_value = r2(st.picking_short_value + n(s.short_value));
      if (n(s.short_lines)) {
        const t = jt(s.job_type);
        const cur = st.picking_by_type[t] || { lines: 0, value: 0 };
        st.picking_by_type[t] = { lines: cur.lines + n(s.short_lines), value: r2(cur.value + n(s.short_value)) };
      }
    }
    if (s.report_type === "VERIFICATION") st.verification_short_qty += n(s.short_qty);
    st.open_lines += n(s.open_lines);
  }
  for (const p of pending) store(p.to_store).yet_to_verify_qty += p.qty;
  for (const b of issues) store(b.store).box_issues += 1;
  const storeRows = [...stores.values()]
    .filter((s) => s.picking_short_qty || s.verification_short_qty || s.yet_to_verify_qty || s.box_issues || s.open_lines || s.store !== "warehouse")
    .map((s) => ({ ...s, name: title(s.store), needs_look: Boolean(s.box_issues || s.verification_short_qty || s.yet_to_verify_qty) }))
    .sort((a, b) => b.picking_short_lines - a.picking_short_lines || b.picking_short_value - a.picking_short_value);

  // Trend: picking write-off per day over the 7 days, with which days have a Picking report
  const pickedDays = new Set((trendUploads || []).filter((u) => u.report_type === "PICKING").map((u) => u.report_date));
  const trendRows = [];
  for (let d = addDays(date, -6); d <= date; d = addDays(d, 1)) {
    const t = (trend || []).find((x) => x.report_date === d && x.report_type === "PICKING");
    trendRows.push({ date: d, has_report: pickedDays.has(d), short_lines: t ? n(t.short_lines) : 0, short_qty: t ? n(t.short_qty) : 0, short_value: t ? r2(t.short_value) : 0 });
  }

  const items = [];
  // Picking write-off is counted in lines (articles short), not units.
  if (job.PICKING.short_lines) items.push({ key: "writeoff", tone: "red", text: `Picking write-off ${fmt(job.PICKING.short_lines)} line${job.PICKING.short_lines === 1 ? "" : "s"} · ${rupees(job.PICKING.short_value)} (${fmt(job.PICKING.short_qty)} qty)${writeoffByType.length > 1 || (writeoffByType[0] && writeoffByType[0].job_type !== "OTHER") ? ` - ${writeoffByType.map((t) => `${t.job_type} ${fmt(t.lines)}`).join(", ")}` : ""}` });
  if (countBy("NOT_ON_TRUCK")) items.push({ key: "loading", tone: "red", text: `Loading: ${countBy("NOT_ON_TRUCK")} box${countBy("NOT_ON_TRUCK") === 1 ? "" : "es"} on the loading list but not on a truck` });
  const lost = notUnloadedList.length + wrongStoreList.length;
  if (lost) items.push({ key: "unloading", tone: "red", text: `Unloading: ${lost} box${lost === 1 ? "" : "es"} not right (not unloaded or wrong store)` });
  if (job.VERIFICATION.short_lines) items.push({ key: "verification", tone: "red", text: `Stores found ${fmt(job.VERIFICATION.short_lines)} line${job.VERIFICATION.short_lines === 1 ? "" : "s"} short at verification` });
  if (pending.length) items.push({ key: "verification", tone: "amber", text: `${fmt(pendingQty)} qty yet to verify` });
  // Remarks (written the next day) and jobs still open (every night) are normal: not listed here.

  const monthPickers = pickers(pickerWork, pickerMistakes, staffNames);
  const monthPickerGroups = pickerGroups(pickerWork, pickerMistakes, staffNames);
  return {
    date,
    month_from: monthStart(date),
    accuracy_target: ACCURACY_TARGET,
    reports,
    missing_reports: Object.keys(LABEL).filter((k) => !reports[k]).map((k) => LABEL[k]),
    need_you: items,
    tiles: {
      writeoff: {
        // Every line: what (article), where (from -> store), who (picker), when (job finished), which job / document.
        list: (writeoffLines || [])
          .map((l) => ({
            article_id: l.article_id,
            article_name: l.article_name || null,
            department: l.department || null,
            job_type: String(l.job_type || "Other").toUpperCase(),
            from_store: l.from_store || null,
            to_store: l.to_store || null,
            advised_qty: n(l.advised_qty),
            picked_qty: n(l.actual_qty),
            short_qty: n(l.short_qty),
            nlc: l.nlc == null ? null : n(l.nlc),
            value: r2(n(l.short_qty) * n(l.nlc)),
            picker: l.worked_by || null,
            picker_name: l.worked_by ? staffLabel(l.worked_by, staffNames) : null,
            picker_mapped: Boolean(l.worked_by && staffNames && staffNames[l.worked_by]),
            finished_at: l.finished_at || null,
            job_id: l.job_id || null,
            stage_id: l.stage_id || null,
          }))
          .sort((a, b) => b.value - a.value || b.short_qty - a.short_qty),
        lines: job.PICKING.short_lines, qty: job.PICKING.short_qty, value: r2(job.PICKING.short_value), by_job_type: writeoffByType, packing_lines: job.PACKING.short_lines, packing_qty: job.PACKING.short_qty, packing_value: r2(job.PACKING.short_value) },
      boxes: { not_on_truck: countBy("NOT_ON_TRUCK"), not_unloaded: countBy("NOT_UNLOADED"), wrong_store: countBy("WRONG_STORE"), qty_diff: countBy("QTY_DIFF"), not_loaded: countBy("NOT_LOADED"), list: issues.slice(0, 200) },
      // Loading and unloading, each on its own.
      loading: { boxes: listBoxes.size, on_truck: onTruck.size, trucks: trucks.size, not_on_truck: countBy("NOT_ON_TRUCK"), list: issues.filter((x) => x.status === "NOT_ON_TRUCK").slice(0, 200) },
      unloading: {
        loaded_boxes: expected.length,
        unloaded_boxes: unloadedOf.length,
        problems: notUnloadedList.length + wrongStoreList.length + notLoadedList.length,
        not_unloaded: notUnloadedList.length,
        wrong_store: wrongStoreList.length,
        not_loaded: notLoadedList.length,
        list: [...notUnloadedList.sort((x, y) => y.qty - x.qty), ...wrongStoreList, ...notLoadedList].slice(0, 200),
        // On a truck, not unloaded, and not a problem: damage / returns going back to the warehouse.
        waiting: returnList.slice(0, 200),
      },
      remarks: { write_off: rm.WRITE_OFF, verification: rm.VERIFICATION },
      jobs: { picking_open: job.PICKING.open_lines, packing_open: job.PACKING.open_lines, verification_open: job.VERIFICATION.open_lines, by_store: storeRows.filter((s) => s.open_lines).map((s) => ({ name: s.name, open_lines: s.open_lines })) },
      verification: { short_qty: job.VERIFICATION.short_qty, short_lines: job.VERIFICATION.short_lines, short_value: r2(job.VERIFICATION.short_value), verified_lines: job.VERIFICATION.done_lines, yet_to_verify_qty: pendingQty, yet_to_verify: pending.slice(0, 200) },
    },
    flow: {
      picked_lines: job.PICKING.done_lines,
      picked_value: r2(job.PICKING.actual_value),
      picking_short_lines: job.PICKING.short_lines,
      packed_lines: job.PACKING.done_lines,
      packing_short_lines: job.PACKING.short_lines,
      loading_list_boxes: listBoxes.size,
      on_truck_boxes: onTruck.size,
      trucks: trucks.size,
      unloaded_boxes: unloaded.size,
      not_unloaded_boxes: gap.length,
      not_unloaded: gap.slice(0, 200),
      verified_lines: job.VERIFICATION.done_lines,
      verification_short_lines: job.VERIFICATION.short_lines,
    },
    stores: storeRows,
    repeats: (repeats || []).filter((a) => n(a.days_short) >= 2).slice(0, 10),
    trend: trendRows,
    pickers: monthPickers,
    picker_groups: monthPickerGroups,
  };
}

/** The 9 am Telegram message (plain text). */
/** The report's name: "Pick Pack Daily Report – Warehouse", "Pick Pack Daily Report – ECR". */
function reportName(site, siteName) {
  return `Pick Pack Daily Report – ${site && site !== "warehouse" ? siteName || title(site) : "Warehouse"}`;
}

function formatTelegram(h) {
  const lines = [`${reportName(h.site, h.site_name)} · ${dayText(h.date)}`];
  if (h.missing_reports.length === 5) return `${lines[0]}\nNo reports for this day yet.`;
  lines.push(h.need_you.length ? `${h.need_you.length} thing${h.need_you.length === 1 ? "" : "s"} need you:` : "All clear.");
  for (const i of h.need_you) lines.push(`- ${i.text}`);
  const pending = h.tiles.verification.yet_to_verify;
  if (pending.length) {
    const where = new Map();
    for (const p of pending) {
      const k = p.is_return ? `${title(p.to_store)} (returns)` : title(p.to_store);
      where.set(k, (where.get(k) || 0) + p.qty);
    }
    lines.push(`Yet to verify at: ${[...where].map(([s, q]) => `${s} ${fmt(q)}`).join(", ")}`);
  }
  if (h.repeats.length) lines.push(`Short again and again: ${h.repeats.slice(0, 5).map((a) => title(a.article_name || a.article_id)).join(", ")}`);
  // Pickers are on the dashboard only, not in the message.
  if (h.missing_reports.length) lines.push(`Not pulled yet: ${h.missing_reports.join(", ")}`);
  return lines.join("\n");
}

module.exports = { ACCURACY_TARGET, addDays, monthStart, staffLabel, boxIssues, pickers, pickerGroups, buildHealth, withSecondChain, formatTelegram, title, reportName };
