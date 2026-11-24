/**
 * The end-of-day Invoice pipeline report: the step tiles and everything
 * waiting over 48 hours (from what GET /warehouse-flow/flow returns), for the
 * 9:10 am PDF sent to the Purchase Telegram group. The full step lists are on the
 * Invoice Pipeline page, not in the PDF.
 *
 * PURE: data in, HTML out. No network, no fonts or images fetched - the logo
 * is passed in as a data URI and the font is the system's - so the render
 * never waits on, or fails for, anything outside the server.
 */

const STEP_ORDER = ["gate_pass", "inspection", "grn", "allocation"];

/** Waiting this long or more is "attention required". */
const ATTENTION_HOURS = 48;

// RetailPilot's GRN stages, in the order an invoice moves through them.
const GRN_STAGES = [
  ["no_template", "Yet to start"],
  ["header_captured", "Header captured"],
  ["inspection_link_pending", "Inspection link pending"],
  ["manual_entry_started", "Manual entry started"],
  ["pricing_review_pending", "Pricing review pending"],
  ["cost_qc_failed", "Cost variance detected"],
];
const GRN_STAGE_TEXT = new Map(GRN_STAGES);

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const titleCase = (s) =>
  String(s || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

const stageText = (state) => GRN_STAGE_TEXT.get(String(state || "").toLowerCase()) || titleCase(state) || "—";

/** "45m", "5h 20m", "2d 3h". */
function ageText(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "—";
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "17 Nov, 9:04 pm" in India time. */
function istTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "17 Nov 2026" in India time. */
function istDay(ms) {
  return new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

/** "₹1,23,456" - whole rupees, Indian grouping. */
function inr(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "";
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const hoursSince = (iso, nowMs) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 3600000) : null;
};

/** Oldest first; a row with no date last. */
function byOldest(a, b) {
  const ta = Date.parse(a.since);
  const tb = Date.parse(b.since);
  const okA = Number.isFinite(ta);
  const okB = Number.isFinite(tb);
  if (okA !== okB) return okA ? -1 : 1;
  if (okA && ta !== tb) return ta - tb;
  return String(a.ref || "").localeCompare(String(b.ref || ""));
}

/**
 * What a row is called in the report: its supplier invoice number. A row with
 * no invoice yet (a gate pass, an inspection) shows its gate pass, else its
 * inspection - the gate pass is not repeated beside an invoice.
 */
function refText(r) {
  if (r.kind === "allocation" || r.kind === "document") return r.invoice_no || "(number not read yet)";
  if (r.gate_pass) return r.gate_pass;
  return `Inspection ${r.ref}`;
}

/** A row's status in its step. */
function statusText(stepKey, r) {
  if (stepKey === "gate_pass") return "No inspection yet";
  if (stepKey === "inspection") return titleCase(r.state) || "In progress";
  if (stepKey === "grn") return stageText(r.doc_state || r.state);
  if (stepKey === "allocation") return r.allocated ? "Allocated" : "Not allocated";
  if (stepKey === "no_invoice") return "Invoice not uploaded";
  if (stepKey === "written_off") return "Written off";
  return titleCase(r.state);
}

/**
 * Everything waiting ATTENTION_HOURS or more, from every step (and inspected
 * passes with no invoice uploaded), oldest first, each tagged with its step.
 */
function attentionRows(flow, nowMs) {
  const out = [];
  const take = (stepKey, rows) =>
    (rows || []).forEach((r) => {
      const h = hoursSince(r.since, nowMs);
      if (h !== null && h >= ATTENTION_HOURS) out.push({ ...r, step: stepKey });
    });
  ((flow && flow.stages) || []).forEach((s) => {
    if (s.ok && STEP_ORDER.includes(s.key)) take(s.key, s.rows);
  });
  const noInvoice = ((flow && flow.attention) || []).find((a) => a.key === "no_invoice");
  if (noInvoice && noInvoice.ok) take("no_invoice", noInvoice.rows);
  return out.sort(byOldest);
}

/**
 * The numbers at the top: per step, how many and how many over 24h; GRN by
 * RetailPilot stage; Allocation not allocated / allocated.
 */
function summarize(flow, nowMs) {
  const stages = (flow && flow.stages) || [];
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const over = (rows) => rows.filter((r) => (hoursSince(r.since, nowMs) || 0) >= 24).length;
  const out = {};
  STEP_ORDER.forEach((k) => {
    const s = byKey.get(k);
    const rows = (s && s.rows) || [];
    out[k] = { label: s ? s.label : k, ok: Boolean(s && s.ok), error: (s && s.error) || null, count: rows.length, over_day: over(rows) };
  });
  const grnRows = (byKey.get("grn") && byKey.get("grn").rows) || [];
  const counts = new Map();
  grnRows.forEach((r) => {
    const st = String(r.doc_state || r.state || "").toLowerCase();
    counts.set(st, (counts.get(st) || 0) + 1);
  });
  const known = GRN_STAGES.map(([st]) => st).filter((st) => counts.has(st));
  const other = [...counts.keys()].filter((st) => st && !GRN_STAGE_TEXT.has(st)).sort();
  out.grn.stages = [...known, ...other].map((st) => ({ state: st, label: stageText(st), count: counts.get(st) }));
  const allocRows = (byKey.get("allocation") && byKey.get("allocation").rows) || [];
  out.allocation.not_allocated = allocRows.filter((r) => !r.allocated).length;
  out.allocation.allocated = allocRows.filter((r) => r.allocated).length;
  const attention = new Map(((flow && flow.attention) || []).map((a) => [a.key, a]));
  out.no_invoice = (attention.get("no_invoice") && attention.get("no_invoice").rows.length) || 0;
  out.attention = attentionRows(flow, nowMs).length;
  out.written_off = (attention.get("written_off") && attention.get("written_off").rows.length) || 0;
  return out;
}

/**
 * The attention list in sections - invoices at GRN, allocation, and anything
 * not yet an invoice (gate pass, inspection, invoice not uploaded) - each
 * grouped by status in the order work moves through it, oldest first within
 * a status. Empty sections and statuses are left out.
 */
function attentionSections(rows) {
  const SECTIONS = [
    { key: "grn", title: "Invoices — GRN", ref: "Invoice", since: "Uploaded", steps: ["grn"] },
    { key: "allocation", title: "Allocation", ref: "Invoice", since: "GRN entered", steps: ["allocation"] },
    { key: "before_invoice", title: "Gate pass & inspection", ref: "Gate pass", since: "Since", steps: ["gate_pass", "inspection", "no_invoice"] },
  ];
  const statusOrder = [
    ...GRN_STAGES.map(([, label]) => label),
    "Not allocated",
    "Allocated",
    "No inspection yet",
    "Invoice not uploaded",
  ];
  const rank = (label) => {
    const i = statusOrder.indexOf(label);
    return i === -1 ? statusOrder.length : i;
  };
  return SECTIONS.map((sec) => {
    const groups = new Map();
    rows
      .filter((r) => sec.steps.includes(r.step))
      .forEach((r) => {
        const label = statusText(r.step, r);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(r);
      });
    const list = [...groups.entries()]
      .map(([status, rs]) => ({ status, rows: rs.slice().sort(byOldest) }))
      .sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status));
    return { ...sec, count: list.reduce((n, g) => n + g.rows.length, 0), groups: list };
  }).filter((sec) => sec.count);
}

function sectionHtml(sec, storeName, nowMs) {
  const rowHtml = (r) => {
    const h = hoursSince(r.since, nowMs);
    const extra = [];
    if (r.step === "allocation" && r.retries) extra.push(`${r.retries} retr${r.retries === 1 ? "y" : "ies"}`);
    if (r.step === "allocation" && r.invoice_amount !== null && r.invoice_amount !== undefined) extra.push(inr(r.invoice_amount));
    return `<tr class="critical">
  <td class="sup">${esc(r.supplier_name || r.supplier_id || "Unknown supplier")}</td>
  <td class="ref">${esc(refText(r))}${extra.length ? `<div class="sub">${esc(extra.join(" · "))}</div>` : ""}</td>
  <td>${esc(storeName(r.store))}</td>
  <td class="nw">${esc(istTime(r.since))}</td>
  <td class="nw num">${esc(ageText(h))}</td>
</tr>`;
  };
  const body = sec.groups
    .map((g) => `<tr class="grp"><td colspan="5">${esc(g.status)} <span class="gc">${g.rows.length}</span></td></tr>\n${g.rows.map(rowHtml).join("\n")}`)
    .join("\n");
  return `<h3>${esc(sec.title)} <span class="count">${sec.count}</span></h3>
<table class="grouped">
<colgroup><col class="c-sup"><col class="c-ref"><col class="c-store"><col class="c-since"><col class="c-wait"></colgroup>
<thead><tr><th>Supplier</th><th>${esc(sec.ref)}</th><th>Store</th><th>${esc(sec.since)}</th><th class="num">Waiting</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

/**
 * @param flow      the `data` of GET /warehouse-flow/flow (all stores)
 * @param opts.nowMs     when the report is taken
 * @param opts.logoDataUri  optional data: URI of the Daily Needs logo
 * @returns {{ html, summary }}
 */
function buildReport(flow, { nowMs = Date.now(), logoDataUri = null } = {}) {
  const stores = new Map(((flow && flow.stores) || []).map((s) => [s.key, s.name]));
  const storeName = (key) => stores.get(key) || key || "—";
  const sum = summarize(flow, nowMs);

  const card = (label, value, sub, tone = "") =>
    `<div class="card ${tone}"><div class="cl">${esc(label)}</div><div class="cv">${esc(value)}</div>${sub ? `<div class="cs">${sub}</div>` : ""}</div>`;
  const overText = (n) => (n ? `<span class="warn">${n} over 24h</span>` : "none over 24h");
  const unavailable = (k) => (sum[k].ok ? null : `<span class="warn">not available</span>`);

  const cards = [
    card("1 · Gate pass", sum.gate_pass.count, unavailable("gate_pass") || overText(sum.gate_pass.over_day)),
    card("2 · Inspection", sum.inspection.count, unavailable("inspection") || overText(sum.inspection.over_day)),
    card(
      "3 · GRN (invoices)",
      sum.grn.count,
      unavailable("grn") || sum.grn.stages.map((s) => `${esc(s.label)}: <b>${s.count}</b>`).join("<br>") || "none"
    ),
    card(
      "4 · Allocation (invoices)",
      sum.allocation.count,
      unavailable("allocation") || `Not allocated: <b>${sum.allocation.not_allocated}</b><br>Allocated: <b>${sum.allocation.allocated}</b>`
    ),
  ].join("");

  const urgent = attentionRows(flow, nowMs);
  const attentionHtml = `
<div class="attention">
<h2><span class="bang">!</span> Attention required — waiting over ${ATTENTION_HOURS}h <span class="count">${urgent.length}</span></h2>
${urgent.length ? attentionSections(urgent).map((sec) => sectionHtml(sec, storeName, nowMs)).join("\n") : `<p class="none">Nothing has waited over ${ATTENTION_HOURS} hours.</p>`}
</div>`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice pipeline — ${esc(istDay(nowMs))}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a202c; font-size: 10.5px; margin: 0; }
  /* Letterhead: logo | title, the report date on the right, a brand rule under. */
  header { display: flex; justify-content: space-between; align-items: center; padding: 0 0 10px; border-bottom: 3px solid #553c9a; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; }
  /* The logo PNG carries wide transparent margins (13% each side): crop them. */
  .logo { width: 178px; height: 48px; overflow: hidden; flex: none; }
  .logo img { height: 48px; margin-left: -31px; display: block; }
  .title { border-left: 1px solid #cbd5e0; margin-left: 14px; padding-left: 14px; }
  h1 { font-size: 19px; margin: 0; color: #322659; letter-spacing: .01em; }
  .kicker { font-size: 9.5px; color: #718096; text-transform: uppercase; letter-spacing: .12em; margin-top: 3px; }
  .meta { text-align: right; font-size: 9.5px; color: #4a5568; line-height: 1.5; }
  .meta .day { font-size: 13px; font-weight: bold; color: #1a202c; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
  .card { border: 1px solid #e2e8f0; border-left: 4px solid #6b46c1; border-radius: 4px; padding: 6px 8px; }
  .cl { font-size: 9.5px; color: #4a5568; font-weight: bold; text-transform: uppercase; letter-spacing: .02em; }
  .cv { font-size: 22px; font-weight: bold; margin: 2px 0; }
  .cs { font-size: 9.5px; color: #2d3748; line-height: 1.45; }
  .warn { color: #c05621; font-weight: bold; }
  .extra { font-size: 10px; color: #2d3748; margin: 0 0 6px; }
  h2 { font-size: 12.5px; margin: 14px 0 4px; color: #2d3748; page-break-after: avoid; }
  h2 .count { display: inline-block; background: #edf2f7; border-radius: 9px; padding: 0 7px; font-size: 10.5px; color: #4a5568; }
  p.note, p.none { margin: 2px 0 6px; color: #718096; }
  p.note { color: #c05621; }
  /* A clear grid: an outer box, every cell ruled, a shaded header row. */
  table { width: 100%; border-collapse: collapse; border: 1.5px solid #4a5568; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; color: #1a202c; background: #e2e8f0; border: 1px solid #718096; padding: 4px 5px; }
  td { border: 1px solid #a0aec0; padding: 4px 5px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  tr.critical td { background: #fff5f5; }
  tr.critical td.num { color: #c53030; font-weight: bold; }
  .attention { margin: 10px 0 4px; }
  h3 { font-size: 11.5px; margin: 10px 0 4px; color: #322659; page-break-after: avoid; }
  h3 .count { display: inline-block; background: #e9d8fd; border-radius: 9px; padding: 0 7px; font-size: 10px; color: #44337a; }
  /* Every section's table lines up: same column widths. */
  table.grouped { table-layout: fixed; }
  col.c-sup { width: 34%; } col.c-ref { width: 22%; } col.c-store { width: 14%; } col.c-since { width: 18%; } col.c-wait { width: 12%; }
  tr.grp td { background: #edf2f7; font-weight: bold; color: #2d3748; border-top: 1.5px solid #718096; page-break-after: avoid; }
  tr.grp .gc { font-weight: normal; color: #4a5568; }
  .attention h2 { color: #c53030; margin-top: 8px; }
  .bang { display: inline-block; width: 15px; height: 15px; line-height: 15px; border-radius: 50%; background: #c53030; color: #fff; text-align: center; font-size: 11px; margin-right: 4px; vertical-align: 1px; }
  .sup { font-weight: bold; text-transform: capitalize; }
  .ref { overflow-wrap: anywhere; }
  .sub { color: #718096; font-size: 9.5px; }
  .nw { white-space: nowrap; }
  .num { text-align: right; }
  footer { margin-top: 12px; color: #a0aec0; font-size: 9px; }
</style></head>
<body>
<header>
  <div class="brand">${logoDataUri ? `<div class="logo"><img src="${esc(logoDataUri)}" alt="Daily Needs"></div><div class="title">` : `<div>`}<h1>Invoice Pipeline</h1><div class="kicker">End-of-day report · All stores</div></div></div>
  <div class="meta"><div class="day">${esc(istDay(nowMs))}</div>As at ${esc(istTime(new Date(nowMs).toISOString()))}<br>Source: RetailPilot</div>
</header>
<div class="cards">${cards}</div>
<p class="extra">Inspected, invoice not uploaded: <b>${sum.no_invoice}</b> &nbsp;·&nbsp; Written off (last 30 days): <b>${sum.written_off}</b></p>
${attentionHtml}
<footer>Oldest first. The full lists are on dnds.co.in → Dashboard → Invoice Pipeline. Generated from RetailPilot.</footer>
</body></html>`;
  return { html, summary: sum };
}

/** The Telegram caption: the headline numbers on one line each. */
function captionText(summary, nowMs) {
  const s = summary;
  const grn = s.grn.stages.map((st) => `${st.label} ${st.count}`).join(", ");
  return [
    `📦 Invoice pipeline — ${istDay(nowMs)}`,
    s.attention ? `⚠️ Attention required: ${s.attention} waiting over ${ATTENTION_HOURS}h` : `✅ Nothing waiting over ${ATTENTION_HOURS}h`,
    `Gate pass ${s.gate_pass.count} · Inspection ${s.inspection.count}`,
    `GRN ${s.grn.count}${grn ? ` (${grn})` : ""}`,
    `Allocation: not allocated ${s.allocation.not_allocated}, allocated ${s.allocation.allocated}`,
    `Over 24h: GRN ${s.grn.over_day}, allocation ${s.allocation.over_day}`,
  ]
    .join("\n")
    .slice(0, 1000);
}

module.exports = { attentionSections, ATTENTION_HOURS, attentionRows, buildReport, captionText, summarize, ageText, istTime, istDay, inr, esc };
