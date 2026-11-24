/**
 * The 9:15 am Open returns PDF for Telegram: every return whose goods are
 * back with the supplier and not yet settled (GET
 * /business-dashboard/purchase-returns `open`), one line per supplier per
 * location, oldest first - the same list as the Business Dashboard's Open
 * returns drawer.
 *
 * PURE: rows in, HTML / text out - no network, the logo is passed in as a
 * data URI. Every name is escaped. Styled like the Invoice pipeline PDF.
 */
const { esc, inr, istDay } = require("./invoice_pipeline_report");

/** "09:15" in India time. */
const istClock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

const AGE_AMBER = 7;
const AGE_RED = 15;

/**
 * Open rows -> [{ supplier, location, claims, value, age_days, raised_on }],
 * one per supplier per location; age and date are the oldest claim's.
 */
function groupOpen(rows, stores) {
  const name = new Map((stores || []).map((s) => [s.key, s.name]));
  const by = new Map();
  for (const r of rows || []) {
    const k = `${r.supplier_id || r.supplier_name}|${r.store}`;
    const g = by.get(k) || { supplier: r.supplier_name, location: name.get(r.store) || r.store, claims: 0, value: 0, age_days: null, raised_on: null };
    g.claims += 1;
    g.value = Math.round((g.value + (Number(r.amount) || 0)) * 100) / 100;
    if (r.raised_on && (!g.raised_on || r.raised_on < g.raised_on)) {
      g.raised_on = r.raised_on;
      g.age_days = r.age_days;
    }
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1) || b.value - a.value);
}

const bandOf = (d) => (d === null || d === undefined ? "" : d > AGE_RED ? "red" : d > AGE_AMBER ? "amber" : "");

/** "15 Oct 2026" for a YYYY-MM-DD day. */
const longDay = (day) => {
  if (!day) return "—";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};

/** Headline figures for the PDF's cards. */
function summarize(rows, stores) {
  const groups = groupOpen(rows, stores);
  const value = (gs) => Math.round(gs.reduce((s, g) => s + g.value, 0) * 100) / 100;
  const claims = (gs) => gs.reduce((s, g) => s + g.claims, 0);
  const red = groups.filter((g) => bandOf(g.age_days) === "red");
  const amber = groups.filter((g) => bandOf(g.age_days) === "amber");
  const byLocation = new Map();
  for (const g of groups) {
    const l = byLocation.get(g.location) || { location: g.location, claims: 0, value: 0 };
    l.claims += g.claims;
    l.value = Math.round((l.value + g.value) * 100) / 100;
    byLocation.set(g.location, l);
  }
  return {
    groups,
    value: value(groups),
    claims: claims(groups),
    suppliers: new Set((rows || []).map((r) => r.supplier_id || r.supplier_name)).size,
    oldest_days: groups.length ? groups[0].age_days : null,
    red: { lines: red.length, claims: claims(red), value: value(red) },
    amber: { lines: amber.length, claims: claims(amber), value: value(amber) },
    locations: [...byLocation.values()].sort((a, b) => b.value - a.value),
  };
}

/** { html, summary } - the A4 PDF's HTML. */
function buildReport(rows, stores, { nowMs = Date.now(), logoDataUri = null } = {}) {
  const sum = summarize(rows, stores);
  const card = (label, value, sub, tone = "") =>
    `<div class="card ${tone}"><div class="cl">${esc(label)}</div><div class="cv">${esc(value)}</div>${sub ? `<div class="cs">${sub}</div>` : ""}</div>`;
  const cards = [
    card("Open returns", inr(sum.value), `${sum.claims} claims · ${sum.suppliers} suppliers`, "open"),
    card(`Over ${AGE_RED} days`, inr(sum.red.value), `${sum.red.claims} claims`, "red"),
    card(`${AGE_AMBER + 1}–${AGE_RED} days`, inr(sum.amber.value), `${sum.amber.claims} claims`, "amber"),
    card("Oldest", sum.oldest_days === null ? "—" : `${sum.oldest_days} days`, sum.groups.length ? esc(sum.groups[0].supplier) : "none open"),
  ].join("");

  const lines = sum.groups
    .map(
      (g, i) => `<tr class="${bandOf(g.age_days)}">
  <td class="num">${i + 1}</td>
  <td class="sup">${esc(g.supplier)}</td>
  <td>${esc(g.location)}</td>
  <td class="num">${g.claims}</td>
  <td class="num nw">${esc(inr(g.value))}</td>
  <td class="nw">${esc(longDay(g.raised_on))}</td>
  <td class="num age">${g.age_days === null ? "—" : `${g.age_days}d`}</td>
</tr>`
    )
    .join("\n");
  const locations = sum.locations
    .map((l) => `<tr><td>${esc(l.location)}</td><td class="num">${l.claims}</td><td class="num nw">${esc(inr(l.value))}</td></tr>`)
    .join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Open returns — ${esc(istDay(nowMs))}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a202c; font-size: 10.5px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0 0 10px; border-bottom: 3px solid #553c9a; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; }
  .logo { width: 178px; height: 48px; overflow: hidden; flex: none; }
  .logo img { height: 48px; margin-left: -31px; display: block; }
  .title { border-left: 1px solid #cbd5e0; margin-left: 14px; padding-left: 14px; }
  h1 { font-size: 19px; margin: 0; color: #322659; letter-spacing: .01em; }
  .kicker { font-size: 9.5px; color: #718096; text-transform: uppercase; letter-spacing: .12em; margin-top: 3px; }
  .meta { text-align: right; font-size: 9.5px; color: #4a5568; line-height: 1.5; }
  .meta .day { font-size: 13px; font-weight: bold; color: #1a202c; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px; }
  .card { border: 1px solid #e2e8f0; border-left: 4px solid #6b46c1; border-radius: 4px; padding: 6px 8px; }
  .card.open { border-left-color: #c05621; } .card.red { border-left-color: #c53030; } .card.amber { border-left-color: #dd6b20; }
  .cl { font-size: 9.5px; color: #4a5568; font-weight: bold; text-transform: uppercase; letter-spacing: .02em; }
  .cv { font-size: 20px; font-weight: bold; margin: 2px 0; }
  .card.open .cv { color: #c05621; } .card.red .cv { color: #c53030; }
  .cs { font-size: 9.5px; color: #2d3748; line-height: 1.45; }
  p.note { margin: 2px 0 8px; color: #4a5568; }
  h2 { font-size: 12.5px; margin: 14px 0 4px; color: #2d3748; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; border: 1.5px solid #4a5568; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; color: #1a202c; background: #e2e8f0; border: 1px solid #718096; padding: 4px 5px; }
  td { border: 1px solid #a0aec0; padding: 4px 5px; vertical-align: top; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  tr.red td { background: #fff5f5; } tr.red td.age { color: #c53030; font-weight: bold; }
  tr.amber td { background: #fffaf0; } tr.amber td.age { color: #c05621; font-weight: bold; }
  table.loc { width: 50%; }
  .sup { font-weight: bold; }
  .num { text-align: right; } th.num { text-align: right; }
  .nw { white-space: nowrap; }
  p.none { color: #718096; }
  footer { margin-top: 12px; color: #a0aec0; font-size: 9px; }
</style></head>
<body>
<header>
  <div class="brand">${logoDataUri ? `<div class="logo"><img src="${esc(logoDataUri)}" alt="Daily Needs"></div><div class="title">` : `<div>`}<h1>Open Returns</h1><div class="kicker">Purchase returns not yet settled · All stores</div></div></div>
  <div class="meta"><div class="day">${esc(istDay(nowMs))}</div>As at ${esc(istClock(nowMs))}<br>Source: RetailPilot</div>
</header>
<div class="cards">${cards}</div>
<p class="note">Every return whose goods have already been handed back to the supplier but which the supplier has not yet settled as a debit note or a replacement, however long ago it was raised. Age = days since the return claim was raised; amber after ${AGE_AMBER} days, red after ${AGE_RED}. Value = the claimed amount.</p>
${
  sum.groups.length
    ? `<h2>By supplier — oldest first</h2>
<table>
<thead><tr><th class="num">#</th><th>Supplier</th><th>Location</th><th class="num">Claims</th><th class="num">Value</th><th>Raised on</th><th class="num">Age</th></tr></thead>
<tbody>
${lines}
</tbody>
<tfoot><tr><th></th><th>Total</th><th></th><th class="num">${sum.claims}</th><th class="num">${esc(inr(sum.value))}</th><th></th><th></th></tr></tfoot>
</table>
<h2>By location</h2>
<table class="loc">
<thead><tr><th>Location</th><th class="num">Claims</th><th class="num">Value</th></tr></thead>
<tbody>
${locations}
</tbody>
</table>`
    : `<p class="none">No open returns.</p>`
}
<footer>Also on dnds.co.in → Dashboard → Business → Open returns. Generated from RetailPilot.</footer>
</body></html>`;
  return { html, summary: sum };
}

module.exports = { groupOpen, summarize, buildReport };
