/**
 * The end-of-day Invoice pipeline report: the Invoice pipeline (what
 * GET /warehouse-flow/flow returns) as one A4 page set, for the 9 pm PDF sent
 * to the Purchase Telegram group.
 *
 * PURE: data in, HTML out. No network, no fonts or images fetched - the logo
 * is passed in as a data URI and the font is the system's - so the render
 * never waits on, or fails for, anything outside the server.
 */

const STEP_ORDER = ["gate_pass", "inspection", "grn", "allocation"];

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

/** What a row is called in the report: invoice number, else gate pass, else inspection. */
function refText(r) {
  if (r.kind === "allocation" || r.kind === "document") {
    const parts = [r.invoice_no ? `Inv ${r.invoice_no}` : "Invoice (no number yet)"];
    if (r.gate_pass) parts.push(r.gate_pass);
    return parts.join(" · ");
  }
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

/** What a step's date means. */
const SINCE_LABEL = {
  gate_pass: "In at",
  inspection: "Started",
  grn: "Uploaded",
  allocation: "GRN entered",
  no_invoice: "Inspected",
  written_off: "Written off",
};

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
  out.written_off = (attention.get("written_off") && attention.get("written_off").rows.length) || 0;
  return out;
}

function tableHtml(stepKey, rows, storeName, nowMs) {
  if (!rows.length) return `<p class="none">Nothing here.</p>`;
  const body = rows
    .slice()
    .sort(byOldest)
    .map((r) => {
      const h = hoursSince(r.since, nowMs);
      const late = (h || 0) >= 24;
      const extra = [];
      if (stepKey === "allocation" && r.retries) extra.push(`${r.retries} retr${r.retries === 1 ? "y" : "ies"}`);
      if (r.invoice_amount !== null && r.invoice_amount !== undefined && stepKey === "allocation") extra.push(inr(r.invoice_amount));
      return `<tr class="${late ? "late" : ""}">
  <td class="sup">${esc(r.supplier_name || r.supplier_id || "Unknown supplier")}</td>
  <td class="ref">${esc(refText(r))}${extra.length ? `<div class="sub">${esc(extra.join(" · "))}</div>` : ""}</td>
  <td>${esc(storeName(r.store))}</td>
  <td class="nw">${esc(istTime(r.since))}</td>
  <td class="nw num">${esc(ageText(h))}</td>
  <td>${esc(statusText(stepKey, r))}</td>
</tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr><th>Supplier</th><th>Invoice / gate pass</th><th>Store</th><th>${esc(SINCE_LABEL[stepKey] || "Since")}</th><th class="num">Waiting</th><th>Status</th></tr></thead>
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
  const stages = new Map((((flow && flow.stages) || [])).map((s) => [s.key, s]));
  const attention = new Map((((flow && flow.attention) || [])).map((a) => [a.key, a]));

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

  const section = (title, stepKey, rows, note) => `
<h2>${esc(title)} <span class="count">${rows.length}</span></h2>
${note ? `<p class="note">${esc(note)}</p>` : ""}
${tableHtml(stepKey, rows, storeName, nowMs)}`;

  const stepRows = (k) => (stages.get(k) && stages.get(k).ok ? stages.get(k).rows || [] : []);
  const stepNote = (k) => (stages.get(k) && !stages.get(k).ok ? `Could not be read from RetailPilot: ${stages.get(k).error || "unknown error"}` : null);
  const grnRows = stepRows("grn");
  const allocRows = stepRows("allocation");

  const grnSections = sum.grn.stages
    .map((st) =>
      section(
        `GRN · ${st.label}`,
        "grn",
        grnRows.filter((r) => String(r.doc_state || r.state || "").toLowerCase() === st.state),
        null
      )
    )
    .join("");

  const sections = [
    section("1 · Gate pass — not inspected", "gate_pass", stepRows("gate_pass"), stepNote("gate_pass")),
    section("2 · Inspection — in progress", "inspection", stepRows("inspection"), stepNote("inspection")),
    stages.get("grn") && !stages.get("grn").ok ? section("3 · GRN", "grn", [], stepNote("grn")) : grnSections || section("3 · GRN", "grn", [], null),
    section("4 · Allocation — not allocated", "allocation", allocRows.filter((r) => !r.allocated), stepNote("allocation")),
    section("4 · Allocation — allocated", "allocation", allocRows.filter((r) => r.allocated), null),
  ];
  const noInvoice = attention.get("no_invoice");
  if (noInvoice && noInvoice.ok && noInvoice.rows.length) {
    sections.push(section("Inspected, invoice not uploaded", "no_invoice", noInvoice.rows, null));
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice pipeline — ${esc(istDay(nowMs))}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a202c; font-size: 10.5px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #6b46c1; padding-bottom: 6px; margin-bottom: 10px; }
  header img { height: 28px; }
  h1 { font-size: 17px; margin: 0; color: #44337a; }
  .meta { color: #4a5568; font-size: 10px; text-align: right; }
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
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; color: #4a5568; border-bottom: 1px solid #cbd5e0; padding: 3px 4px; }
  td { border-bottom: 1px solid #edf2f7; padding: 3px 4px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  tr.late td { background: #fffaf0; }
  tr.late td.num { color: #c05621; font-weight: bold; }
  .sup { font-weight: bold; text-transform: capitalize; }
  .ref { word-break: break-all; }
  .sub { color: #718096; font-size: 9.5px; }
  .nw { white-space: nowrap; }
  .num { text-align: right; }
  footer { margin-top: 12px; color: #a0aec0; font-size: 9px; }
</style></head>
<body>
<header>
  <div>${logoDataUri ? `<img src="${esc(logoDataUri)}" alt="Daily Needs">` : ""}<h1>Invoice pipeline — end of day</h1></div>
  <div class="meta">${esc(istDay(nowMs))}<br>As at ${esc(istTime(new Date(nowMs).toISOString()))} · all stores<br>Live from RetailPilot</div>
</header>
<div class="cards">${cards}</div>
<p class="extra">Inspected, invoice not uploaded: <b>${sum.no_invoice}</b> &nbsp;·&nbsp; Written off (last 30 days): <b>${sum.written_off}</b> &nbsp;·&nbsp; Rows waiting over 24h are shaded.</p>
${sections.join("\n")}
<footer>Oldest first in every list. Generated by dnds.co.in from RetailPilot.</footer>
</body></html>`;
  return { html, summary: sum };
}

/** The Telegram caption: the headline numbers on one line each. */
function captionText(summary, nowMs) {
  const s = summary;
  const grn = s.grn.stages.map((st) => `${st.label} ${st.count}`).join(", ");
  return [
    `📦 Invoice pipeline — ${istDay(nowMs)}`,
    `Gate pass ${s.gate_pass.count} · Inspection ${s.inspection.count}`,
    `GRN ${s.grn.count}${grn ? ` (${grn})` : ""}`,
    `Allocation: not allocated ${s.allocation.not_allocated}, allocated ${s.allocation.allocated}`,
    `Over 24h: GRN ${s.grn.over_day}, allocation ${s.allocation.over_day}`,
  ]
    .join("\n")
    .slice(0, 1000);
}

module.exports = { buildReport, captionText, summarize, ageText, istTime, istDay, inr, esc };
