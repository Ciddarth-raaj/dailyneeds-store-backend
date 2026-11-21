/**
 * Warehouse Health as an A4 PDF (HTML for services/pdf), sent on Telegram
 * with the 9 am summary. Built from the same object the dashboard shows
 * (utils/warehouse_health.buildHealth), so the PDF, the page and the message
 * always agree. Picking write-off is in lines first, values at NLC.
 */

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const n = (v) => Number(v) || 0;
const num = (v) => Math.round(n(v)).toLocaleString("en-IN");
const rupees = (v) => {
  const x = n(v);
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2)} Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(2)} L`;
  return `₹${num(x)}`;
};
const plural = (v, one, many = `${one}s`) => `${num(v)} ${n(v) === 1 ? one : many}`;
const title = (s) => {
  const t = String(s || "").trim();
  return t.length <= 3 ? t.toUpperCase() : t.replace(/\b\w/g, (c) => c.toUpperCase());
};
const pct = (v) => (v == null ? "—" : `${(Math.floor(v * 1000) / 10).toFixed(1)}%`);
const dayText = (d) =>
  d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const istTime = (ms) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const BOX_LABEL = {
  NOT_ON_TRUCK: "Not on a truck",
  NOT_UNLOADED: "Not unloaded",
  WRONG_STORE: "Wrong store",
  QTY_DIFF: "Quantity differs",
  NOT_LOADED: "Unloaded, not loaded",
  OPEN: "Awaiting unloading",
  RETURN: "Damage return",
  OK: "OK",
};
const typeSplit = (types) =>
  (Array.isArray(types) ? types : Object.entries(types || {}).map(([job_type, v]) => ({ job_type, ...v })))
    .filter((t) => t.lines)
    .sort((a, b) => b.lines - a.lines)
    .map((t) => `${esc(t.job_type)} ${num(t.lines)}`)
    .join(" · ");

/** A ruled table; cells already escaped HTML; `numCols` right-aligned. */
function table(head, rows, numCols = []) {
  if (!rows.length) return "";
  const th = head.map((h, i) => `<th${numCols.includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map((c, i) => `<td${numCols.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}
const section = (heading, body, note = "") => (body ? `<h2>${esc(heading)}</h2>${note ? `<p class="note">${note}</p>` : ""}${body}` : "");

function buildHtml(h, { nowMs = Date.now(), logoDataUri = null } = {}) {
  const t = h.tiles;
  const remarksPending = t.remarks.write_off.pending + t.remarks.verification.pending;
  const waitBy = new Map();
  for (const x of t.unloading.waiting || []) waitBy.set(x.status, (waitBy.get(x.status) || 0) + 1);
  const gapWaiting = [...waitBy].map(([st, c]) => `${num(c)} ${(BOX_LABEL[st] || st).toLowerCase()}`).join(" · ");
  const card = (label, value, sub, tone) =>
    `<div class="card ${tone}"><div class="cl">${esc(label)}</div><div class="cv">${esc(value)}</div><div class="cs">${sub}</div></div>`;
  const cards = [
    card(
      "Picking write-off",
      plural(t.writeoff.lines, "line"),
      `${rupees(t.writeoff.value)} at NLC · ${num(t.writeoff.qty)} qty${typeSplit(t.writeoff.by_job_type) ? `<br><b>${typeSplit(t.writeoff.by_job_type)}</b>` : ""}`,
      t.writeoff.lines ? "red" : "green"
    ),
    card(
      "Loading",
      plural(t.loading.not_on_truck, "problem"),
      `${num(t.loading.not_on_truck)} not on a truck<br>${plural(t.loading.boxes, "box", "boxes")} on ${plural(t.loading.trucks, "truck")}`,
      t.loading.not_on_truck ? "red" : "green"
    ),
    card(
      "Unloading",
      plural(t.unloading.problems, "problem"),
      t.unloading.chain
        ? `${num(t.unloading.chain.opening.boxes)} open from earlier + ${num(t.unloading.chain.loaded.boxes)} loaded<br>− ${num(t.unloading.chain.unloaded.boxes)} unloaded = <b>${num(t.unloading.chain.still_open.boxes)} still open</b>`
        : `${num(t.unloading.unloaded_boxes)} of ${num(t.unloading.loaded_boxes)} unloaded<br>${num(t.unloading.not_unloaded)} not unloaded · ${num(t.unloading.wrong_store)} wrong store${gapWaiting ? `<br>${esc(gapWaiting)}` : ""}`,
      t.unloading.problems ? "red" : "green"
    ),
    card(
      "Verification",
      plural(t.verification.short_lines, "line"),
      `short (${rupees(t.verification.short_value)})<br>${num(t.verification.yet_to_verify_qty)} qty yet to verify`,
      t.verification.short_lines ? "red" : t.verification.yet_to_verify_qty ? "amber" : "green"
    ),
    card("Remarks pending", num(remarksPending), `Write Off ${num(t.remarks.write_off.pending)}<br>Verification ${num(t.remarks.verification.pending)}`, remarksPending ? "amber" : "green"),
    card(
      "Jobs not finished",
      num(t.jobs.picking_open + t.jobs.packing_open),
      `picking ${num(t.jobs.picking_open)} · packing ${num(t.jobs.packing_open)}`,
      t.jobs.picking_open + t.jobs.packing_open ? "amber" : "green"
    ),
  ].join("");

  const needYou = h.need_you.length
    ? `<div class="need"><b>${h.need_you.length} thing${h.need_you.length === 1 ? "" : "s"} need you</b><ul>${h.need_you
        .map((i) => `<li class="${i.tone}">${esc(i.text)}</li>`)
        .join("")}</ul></div>`
    : `<div class="need clear"><b>All clear</b></div>`;

  const f = h.flow;
  const gapList = f.not_unloaded || [];
  const gapBy = new Map();
  for (const x of gapList) gapBy.set(x.status, (gapBy.get(x.status) || 0) + 1);
  const gapText = [...gapBy].map(([st, c]) => `${num(c)} ${(BOX_LABEL[st] || st).toLowerCase()}`).join(" · ");
  const gapProblem = gapList.some((x) => !["OPEN", "RETURN"].includes(x.status));
  const flow = `<div class="flow">${[
    ["1 · Picked", plural(f.picked_lines, "line"), `${rupees(f.picked_value)} · ${num(f.picking_short_lines)} short`],
    ["2 · Packed", plural(f.packed_lines, "line"), `${num(f.packing_short_lines)} short`],
    ["3 · Loading list", plural(f.loading_list_boxes, "box", "boxes"), `${num(f.on_truck_boxes)} on ${plural(f.trucks, "truck")}`],
    ["4 · Unloaded", plural(f.unloaded_boxes, "box", "boxes"), f.not_unloaded_boxes ? (gapProblem ? `<span class="warn">${esc(gapText)}</span>` : esc(gapText)) : "at stores"],
    ["5 · Verified", plural(f.verified_lines, "line"), `${num(f.verification_short_lines)} short`],
  ]
    .map(([l, v, s]) => `<div class="step"><div class="cl">${esc(l)}</div><div class="sv">${esc(v)}</div><div class="cs">${s}</div></div>`)
    .join("")}</div>`;

  const woStores = h.stores.filter((s) => s.picking_short_lines);
  const writeoff = table(
    ["Store", "Lines", "Split", "Value (NLC)", "Qty"],
    woStores.map((s) => ({ cells: [esc(s.name), num(s.picking_short_lines), typeSplit(s.picking_by_type), rupees(s.picking_short_value), num(s.picking_short_qty)] })),
    [1, 3, 4]
  );

  const boxRows = (list) =>
    list.map((x) => ({
      cls: ["OPEN", "RETURN"].includes(x.status) ? "" : "bad",
      cells: [
        `${esc(x.box_id)}${(x.items || []).length ? `<div class="sub">${x.items.slice(0, 12).map((it) => `${esc(it.article_name || it.article_id)} × ${num(it.qty)}`).join("<br>")}${x.items.length > 12 ? `<br>+${x.items.length - 12} more` : ""}</div>` : ""}`,
        esc(BOX_LABEL[x.status] || x.status), esc(title(x.store)), esc(x.truck_no || "—"), num(x.articles), num(x.qty), rupees(x.value)],
    }));
  const loadingT = table(["Box", "Problem", "Store", "Truck", "Articles", "Qty", "Value"], boxRows(t.loading.list || []), [4, 5, 6]);
  const unloadingT = table(["Box", "Problem", "Store", "Truck", "Articles", "Qty", "Value"], boxRows(t.unloading.list || []), [4, 5, 6]);
  const st = h.stuck_cartons;
  const stuckHtml = !st
    ? ""
    : !st.ok
      ? `<p class="note warn">Stuck cartons: could not read from RetailPilot.</p>`
      : section(
          `Stuck cartons - ${num(st.count)} packed, loading job open more than ${st.stuck_days} days${st.count ? ` · ${num(st.units)} units · ${rupees(st.value)}` : ""}`,
          st.count
            ? table(
                ["Carton", "To", "Waiting since", "Days", "Items", "Units", "Value", "Packed by", "Pack job / loading job"],
                st.cartons.slice(0, 60).map((c) => ({
                  cls: c.days >= 14 ? "bad" : "",
                  cells: [
                    `${esc(c.carton)}<div class="sub">${esc(c.job_type || "")}</div>`,
                    esc(title(c.to_store)),
                    esc((c.waiting_since || "").slice(0, 16)),
                    num(c.days),
                    esc(c.items.map((i) => `${i.article_name || i.article_id} × ${num(i.qty)}`).join("; ")),
                    num(c.units),
                    rupees(c.value),
                    esc(c.packer_name || c.packer || "—"),
                    `<span class="sub">${esc(c.pack_job || "—")} / ${esc(c.load_jobs.join(" + "))}</span>`,
                  ],
                })),
                [3, 5, 6]
              )
            : `<p class="note">No carton is stuck.</p>`,
          "Live from RetailPilot when the report was made."
        );
  const sc = h.stage_chain;
  const stageHtml = sc
    ? `<h2 style="margin-top:4px">Where everything stands tonight</h2>
${table(
  ["Waiting to be", "From earlier", "+ Arrived", "− Moved on", "= Tonight", "Oldest"],
  [
    ...sc.gaps.slice(0, 2).map((g) => ({ cls: g.stuck ? "bad" : "", cells: [`${esc(g.label)} <span class="sub">qty</span>`, num(g.from_earlier), num(g.arrived), num(g.moved_on), `<b>${num(g.stands)}</b>`, g.stands ? plural(g.oldest_days, "day") : "—"] })),
    ...(sc.boxes ? [{ cls: sc.boxes.still_open.boxes ? "bad" : "", cells: ['Loaded, not yet unloaded <span class="sub">boxes</span>', num(sc.boxes.opening.boxes), num(sc.boxes.loaded.boxes), num(sc.boxes.unloaded.boxes), `<b>${num(sc.boxes.still_open.boxes)}</b>`, sc.boxes.still_open.boxes ? plural(sc.boxes.still_open.oldest_days, "day") : "—"] }] : []),
    ...sc.gaps.slice(2).map((g) => ({ cls: g.stuck ? "bad" : "", cells: [`${esc(g.label)} <span class="sub">qty</span>`, num(g.from_earlier), num(g.arrived), num(g.moved_on), `<b>${num(g.stands)}</b>`, g.stands ? plural(g.oldest_days, "day") : "—"] })),
  ],
  [1, 2, 3, 4, 5]
)}
${sc.gaps
  .filter((g) => g.list.length)
  .map((g) =>
    section(
      `${g.label} - ${num(g.stands)} qty · ${rupees(g.value)}`,
      table(
        ["Article", "Document", "From → To", "Qty", "Value", "Waiting"],
        g.list.slice(0, 40).map((l) => ({ cls: l.days > 2 ? "bad" : "", cells: [esc(l.article_name || l.article_id), esc(l.stage_id || "—"), `${esc(title(l.from_store))} → ${esc(title(l.to_store))}`, num(l.qty), rupees(l.value), l.days ? plural(l.days, "day") : "today"] })),
        [3, 4, 5]
      ),
      g.list.length > 40 ? `Oldest 40 of ${g.list.length} lines - all on the dashboard.` : ""
    )
  )
  .join("")}`
    : "";
  const c = t.unloading.chain;
  const tripItems = (x) =>
    (x.items || []).length
      ? `<div class="sub">${x.items.slice(0, 12).map((it) => `${esc(it.article_name || it.article_id)} × ${num(it.qty)}`).join("<br>")}${x.items.length > 12 ? `<br>+${x.items.length - 12} more` : ""}</div>`
      : "";
  const tripRows = (list, f) =>
    list.map((x) => ({
      cls: n(x[f]) >= 2 ? "bad" : "",
      cells: [`${esc(x.box_id)}${tripItems(x)}`, `${esc(title(x.from_store))} → ${esc(title(x.to_store))}`, esc(x.truck_no || "—"), esc(dayText(x.loaded_on)), num(x[f]), num(x.articles), num(x.qty), rupees(x.value)],
    }));
  const chainHtml = c
    ? `<h2>Unloading - box chain since ${esc(dayText(c.from))}</h2>
${c.missing_days.length ? `<p class="note warn">${c.missing_days.length} day(s) since ${esc(dayText(c.from))} have no Loading or Unloading report - the chain may miss boxes.</p>` : ""}
${table(
  ["", "Boxes", ""],
  [
    { cells: ["Open from earlier days", num(c.opening.boxes), `${num(c.opening.qty)} qty`] },
    { cells: ["+ Loaded today", num(c.loaded.boxes), `on ${plural(c.loaded.trucks, "truck")}`] },
    { cells: ["− Unloaded today", num(c.unloaded.boxes), `${num(c.unloaded.from_today)} from today's loading · ${num(c.unloaded.from_earlier)} from earlier days`] },
    { cls: c.still_open.boxes ? "bad" : "", cells: ["<b>= Still open</b>", `<b>${num(c.still_open.boxes)}</b>`, c.still_open.boxes ? `${num(c.still_open.qty)} qty · ${rupees(c.still_open.value)}${c.still_open.older ? ` · oldest ${plural(c.still_open.oldest_days, "day")}` : ""}` : "nothing open"] },
  ],
  [1]
)}
${section("Still open - loaded, not unloaded", table(["Box", "From → To", "Truck", "Loaded", "Days open", "Articles", "Qty", "Value"], tripRows(t.unloading.still_open || [], "days_open"), [4, 5, 6, 7]))}
${section("Closed today - loaded on an earlier day", table(["Box", "From → To", "Truck", "Loaded", "Days late", "Articles", "Qty", "Value"], tripRows(t.unloading.closed_old || [], "days_late"), [4, 5, 6, 7]))}
${section("Unloaded at the wrong store / with no loading", unloadingT && (t.unloading.list || []).some((x) => x.status !== "NOT_UNLOADED") ? table(["Box", "Problem", "Store", "Truck", "Articles", "Qty", "Value"], boxRows((t.unloading.list || []).filter((x) => x.status !== "NOT_UNLOADED")), [4, 5, 6]) : "")}`
    : "";
  const waitingT = table(["Box", "Why", "To", "Truck", "Articles", "Qty", "Value"], boxRows(t.unloading.waiting || []), [4, 5, 6]);

  const yet = table(
    ["Where", "From", "Item", "Qty", "Value"],
    t.verification.yet_to_verify.map((p) => ({
      cells: [`${esc(title(p.to_store))}${p.is_return ? ' <span class="tag">Return to warehouse</span>' : ""}`, esc(title(p.from_store)), esc(p.article_name || p.article_id), num(p.qty), rupees(p.value)],
    })),
    [3, 4]
  );

  const remarks = table(
    ["Page", "Lines that day", "Without remark", "Older, still without (30 days)"],
    [
      { cells: ["Write Off", num(t.remarks.write_off.total), num(t.remarks.write_off.pending), num(t.remarks.write_off.backlog)] },
      { cells: ["Verification", num(t.remarks.verification.total), num(t.remarks.verification.pending), num(t.remarks.verification.backlog)] },
    ],
    [1, 2, 3]
  );

  const stores = table(
    ["Store", "Picking write-off", "Short at verification", "Yet to verify", "Box problems", "Open lines"],
    h.stores
      .filter((s) => s.store !== "warehouse" || s.needs_look)
      .map((s) => ({
        cls: s.needs_look ? "bad" : "",
        cells: [
          esc(s.name),
          s.picking_short_lines ? `${plural(s.picking_short_lines, "line")} · ${rupees(s.picking_short_value)}` : "—",
          s.verification_short_qty ? `${num(s.verification_short_qty)} qty` : "—",
          s.yet_to_verify_qty ? `${num(s.yet_to_verify_qty)} qty` : "—",
          s.box_issues ? num(s.box_issues) : "—",
          num(s.open_lines),
        ],
      })),
    [5]
  );

  const repeats = table(
    ["Item", "Days short", "Lines", "Value", "Stores"],
    h.repeats.map((a) => ({ cells: [esc(a.article_name || a.article_id), num(a.days_short), num(a.lines), rupees(a.short_value), esc(String(a.stores || "").split(",").map(title).join(", "))] })),
    [1, 2, 3]
  );

  const max = Math.max(1, ...h.trend.map((r) => r.short_lines));
  const trend = `<div class="trend">${h.trend
    .map(
      (r) =>
        `<div class="bar"><div class="bv">${r.has_report ? num(r.short_lines) : "—"}</div><div class="bb${r.has_report ? "" : " none"}" style="height:${r.has_report ? Math.max(3, Math.round((r.short_lines / max) * 60)) : 3}px"></div><div class="bd">${esc(
          new Date(`${r.date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", timeZone: "UTC" })
        )}</div></div>`
    )
    .join("")}</div>`;

  const pickers = table(
    ["Picker", "Lines", "Value (NLC)", "Accuracy", "Mistakes", "Mistake value"],
    h.pickers.map((p) => ({
      cls: p.below_target ? "bad" : "",
      cells: [`${esc(p.name)}${p.mapped ? "" : ' <span class="sub">not mapped</span>'}`, num(p.lines), rupees(p.value), `<b>${pct(p.accuracy)}</b>`, num(p.mistake_lines), p.mistake_value ? rupees(p.mistake_value) : "—"],
    })),
    [1, 2, 3, 4, 5]
  );

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Warehouse Health — ${esc(dayText(h.date))}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a202c; font-size: 10.5px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0 0 10px; border-bottom: 3px solid #553c9a; margin-bottom: 10px; }
  .brand { display: flex; align-items: center; }
  .logo { width: 178px; height: 48px; overflow: hidden; flex: none; }
  .logo img { height: 48px; margin-left: -31px; display: block; }
  .title { border-left: 1px solid #cbd5e0; margin-left: 14px; padding-left: 14px; }
  h1 { font-size: 19px; margin: 0; color: #322659; }
  .kicker { font-size: 9.5px; color: #718096; text-transform: uppercase; letter-spacing: .12em; margin-top: 3px; }
  .meta { text-align: right; font-size: 9.5px; color: #4a5568; line-height: 1.5; }
  .meta .day { font-size: 13px; font-weight: bold; color: #1a202c; }
  .need { border: 1px solid #feb2b2; background: #fff5f5; border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; }
  .need.clear { border-color: #9ae6b4; background: #f0fff4; }
  .need ul { margin: 4px 0 0; padding-left: 16px; }
  .need li { margin: 1px 0; }
  .need li.red { color: #9b2c2c; }
  .need li.amber { color: #9c4221; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
  .card { border: 1px solid #e2e8f0; border-left: 4px solid #38a169; border-radius: 4px; padding: 6px 8px; }
  .card.red { border-left-color: #e53e3e; }
  .card.amber { border-left-color: #dd6b20; }
  .cl { font-size: 9px; color: #4a5568; font-weight: bold; text-transform: uppercase; letter-spacing: .02em; }
  .cv { font-size: 19px; font-weight: bold; margin: 2px 0; }
  .cs { font-size: 9.5px; color: #2d3748; line-height: 1.45; }
  .flow { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .step { background: #f7fafc; border-radius: 4px; padding: 6px 8px; }
  .sv { font-size: 13px; font-weight: bold; margin: 2px 0; }
  .warn { color: #c05621; font-weight: bold; }
  h2 { font-size: 12.5px; margin: 14px 0 4px; color: #2d3748; page-break-after: avoid; }
  p.note { margin: 0 0 4px; color: #718096; font-size: 9.5px; }
  table { width: 100%; border-collapse: collapse; border: 1.5px solid #4a5568; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; background: #e2e8f0; border: 1px solid #718096; padding: 4px 5px; }
  td { border: 1px solid #a0aec0; padding: 4px 5px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  tr.bad td { background: #fff5f5; }
  .num { text-align: right; }
  .tag { display: inline-block; background: #e9d8fd; color: #44337a; border-radius: 3px; padding: 0 4px; font-size: 8.5px; font-weight: bold; }
  .sub { color: #718096; font-size: 9px; }
  .trend { display: flex; align-items: flex-end; gap: 10px; height: 95px; border-bottom: 1px solid #e2e8f0; padding-bottom: 2px; }
  .bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
  .bv { font-size: 9px; font-weight: bold; }
  .bb { width: 70%; max-width: 34px; background: #fc8181; border-radius: 2px; }
  .bb.none { background: #e2e8f0; }
  .bd { font-size: 8.5px; color: #718096; margin-top: 2px; }
  footer { margin-top: 12px; color: #a0aec0; font-size: 9px; }
</style></head>
<body>
<header>
  <div class="brand">${logoDataUri ? `<div class="logo"><img src="${esc(logoDataUri)}" alt="Daily Needs"></div><div class="title">` : `<div>`}<h1>Warehouse Health</h1><div class="kicker">Daily report · Values at NLC</div></div></div>
  <div class="meta"><div class="day">${esc(dayText(h.date))}</div>Made ${esc(istTime(nowMs))} IST<br>Source: RetailPilot</div>
</header>
${h.missing_reports.length ? `<p class="note">Not pulled yet for this day: ${esc(h.missing_reports.join(", "))}</p>` : ""}
${stageHtml}
${stuckHtml}
${needYou}
<div class="cards">${cards}</div>
<h2>Flow of goods</h2>${flow}
${section("Picking write-off by store", writeoff)}
${section("Loading - not on a truck", loadingT, "On the loading list, never put on a truck (still at the warehouse).")}
${chainHtml}
${t.unloading.chain ? "" : section("Unloading problems", unloadingT, "Checked by box: on a truck but not unloaded, unloaded at the wrong store, or unloaded but never loaded. Articles inside a box are checked at store verification.")}
${t.unloading.chain ? "" : section("Damage returns going back to the warehouse - not a problem", waitingT)}
${section("Yet to verify", yet)}
${section("Remarks pending", remarks)}
${section("Stores", stores)}
${section("Short again and again", repeats, "Picking write-off on 2 or more of the last 7 days - check the stock / bin.")}
<h2>Picking write-off, last 7 days (lines)</h2>${trend}
${section(
  `Pickers this month (${dayText(h.month_from)} to ${dayText(h.date)})`,
  pickers,
  `Mistakes = shortages the store found at verification in goods they picked. Below ${Math.round(h.accuracy_target * 100)}% accuracy is shaded.`
)}
<footer>The same figures are on dnds.co.in → Dashboard → Invoice Pipeline → Warehouse Health.</footer>
</body></html>`;
}

module.exports = { buildHtml };
