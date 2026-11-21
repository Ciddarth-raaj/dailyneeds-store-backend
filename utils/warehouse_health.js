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
    };
    b.articles += 1;
    // The units at stake: the difference when quantities differ, else the whole line.
    const q = l.status === "QTY_DIFF" ? Math.abs(n(l.loaded_qty) - n(l.unloaded_qty)) : n(l.loaded_qty == null ? l.unloaded_qty : l.loaded_qty);
    b.qty += q;
    b.value += q * n(l.nlc);
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
    by.set(w.worked_by, { id: w.worked_by, lines: n(w.done_lines), qty: n(w.actual_qty), value: r2(w.actual_value), mistake_lines: 0, mistake_qty: 0, mistake_value: 0, mistakes: [] });
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

/** Everything the dashboard shows for `date`, from what the usecase read. */
function buildHealth({ date, uploads, summary, byJobType, byStore, yetToVerify, remarks, boxLines, repeats, trend, trendUploads, pickerWork, pickerMistakes, staffNames }) {
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
  const listBoxes = new Set(loaded.map((l) => `${l.report_date}|${l.box_id}`));
  const onTruck = new Set(loaded.filter((l) => l.truck_no).map((l) => `${l.report_date}|${l.box_id}`));
  const unloaded = new Set((boxLines || []).filter((l) => l.unloaded_qty != null).map((l) => `${l.unload_date}|${l.box_id}`));
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

  const openLines = job.PICKING.open_lines + job.PACKING.open_lines;
  const items = [];
  // Picking write-off is counted in lines (articles short), not units.
  if (job.PICKING.short_lines) items.push({ key: "writeoff", tone: "red", text: `Picking write-off ${fmt(job.PICKING.short_lines)} line${job.PICKING.short_lines === 1 ? "" : "s"} · ${rupees(job.PICKING.short_value)} (${fmt(job.PICKING.short_qty)} qty)${writeoffByType.length > 1 || (writeoffByType[0] && writeoffByType[0].job_type !== "OTHER") ? ` - ${writeoffByType.map((t) => `${t.job_type} ${fmt(t.lines)}`).join(", ")}` : ""}` });
  if (countBy("NOT_ON_TRUCK")) items.push({ key: "boxes", tone: "red", text: `${countBy("NOT_ON_TRUCK")} box${countBy("NOT_ON_TRUCK") === 1 ? "" : "es"} on the loading list but not on a truck` });
  const lost = countBy("NOT_UNLOADED") + countBy("WRONG_STORE") + countBy("QTY_DIFF");
  if (lost) items.push({ key: "boxes", tone: "red", text: `${lost} box${lost === 1 ? "" : "es"} not delivered right (not unloaded, wrong store or quantity differs)` });
  if (job.VERIFICATION.short_lines) items.push({ key: "verification", tone: "red", text: `Stores found ${fmt(job.VERIFICATION.short_lines)} line${job.VERIFICATION.short_lines === 1 ? "" : "s"} short at verification` });
  if (pending.length) items.push({ key: "verification", tone: "amber", text: `${fmt(pendingQty)} qty yet to verify` });
  if (rm.WRITE_OFF.pending + rm.VERIFICATION.pending) items.push({ key: "remarks", tone: rm.WRITE_OFF.backlog + rm.VERIFICATION.backlog ? "red" : "amber", text: `${rm.WRITE_OFF.pending + rm.VERIFICATION.pending} lines without remark` });
  if (openLines) items.push({ key: "jobs", tone: "amber", text: `${fmt(openLines)} picking / packing lines still open` });

  const monthPickers = pickers(pickerWork, pickerMistakes, staffNames);
  return {
    date,
    month_from: monthStart(date),
    accuracy_target: ACCURACY_TARGET,
    reports,
    missing_reports: Object.keys(LABEL).filter((k) => !reports[k]).map((k) => LABEL[k]),
    need_you: items,
    tiles: {
      writeoff: { lines: job.PICKING.short_lines, qty: job.PICKING.short_qty, value: r2(job.PICKING.short_value), by_job_type: writeoffByType, packing_lines: job.PACKING.short_lines, packing_qty: job.PACKING.short_qty, packing_value: r2(job.PACKING.short_value) },
      boxes: { not_on_truck: countBy("NOT_ON_TRUCK"), not_unloaded: countBy("NOT_UNLOADED"), wrong_store: countBy("WRONG_STORE"), qty_diff: countBy("QTY_DIFF"), not_loaded: countBy("NOT_LOADED"), list: issues.slice(0, 200) },
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
      verified_lines: job.VERIFICATION.done_lines,
      verification_short_lines: job.VERIFICATION.short_lines,
    },
    stores: storeRows,
    repeats: (repeats || []).filter((a) => n(a.days_short) >= 2).slice(0, 10),
    trend: trendRows,
    pickers: monthPickers,
  };
}

/** The 9 am Telegram message (plain text). */
function formatTelegram(h) {
  const lines = [`Warehouse Health - ${dayText(h.date)}`];
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
  const below = h.pickers.filter((p) => p.below_target);
  if (below.length) lines.push(`Pickers below ${Math.round(h.accuracy_target * 100)}% this month: ${below.slice(0, 5).map((p) => `${p.name} ${(Math.floor(p.accuracy * 1000) / 10).toFixed(1)}%`).join(", ")}`);
  if (h.missing_reports.length) lines.push(`Not pulled yet: ${h.missing_reports.join(", ")}`);
  return lines.join("\n");
}

module.exports = { ACCURACY_TARGET, addDays, monthStart, staffLabel, boxIssues, pickers, buildHealth, formatTelegram };
