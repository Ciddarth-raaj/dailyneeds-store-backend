/**
 * The 9:15 am Open returns Telegram message: every return whose goods are
 * back with the supplier and not yet settled (GET
 * /business-dashboard/purchase-returns `open`), one line per supplier per
 * location, oldest first - the same list as the Business Dashboard's Open
 * returns drawer.
 *
 * PURE: rows in, text out. Telegram HTML; every name is escaped.
 */
const { esc, inr, istDay } = require("./invoice_pipeline_report");

/** "09:15" in India time. */
const istClock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

const AGE_AMBER = 7;
const AGE_RED = 15;
// Telegram's limit is 4096 characters; the rest is summarised as "+N more".
const MAX_CHARS = 3900;

const ageIcon = (d) => (d === null || d === undefined ? "⚪" : d > AGE_RED ? "🔴" : d > AGE_AMBER ? "🟠" : "🟢");

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

/** { text, summary } for the open returns as of nowMs. */
function buildMessage(rows, stores, nowMs) {
  const groups = groupOpen(rows, stores);
  const total = groups.reduce((s, g) => s + g.value, 0);
  const claims = groups.reduce((s, g) => s + g.claims, 0);
  const suppliers = new Set((rows || []).map((r) => r.supplier_id || r.supplier_name)).size;
  const red = groups.filter((g) => g.age_days > AGE_RED);
  const amber = groups.filter((g) => g.age_days > AGE_AMBER && g.age_days <= AGE_RED);
  const sum = (gs) => gs.reduce((s, g) => s + g.value, 0);
  const summary = { claims, suppliers, value: Math.round(total * 100) / 100, oldest_days: groups.length ? groups[0].age_days : null, lines: groups.length };

  const head = [
    `<b>↩️ Open returns — ${esc(istDay(nowMs))}, ${esc(istClock(nowMs))}</b>`,
    "Goods back with the supplier, not yet settled as a debit note or a replacement.",
  ];
  if (!groups.length) return { text: [...head, "", "✅ No open returns."].join("\n"), summary };
  head.push(
    "",
    `<b>${inr(total)}</b> · ${claims} claims · ${suppliers} suppliers${summary.oldest_days !== null ? ` · oldest ${summary.oldest_days}d` : ""}`,
    `🔴 Over ${AGE_RED} days: ${red.length} (${inr(sum(red))}) · 🟠 ${AGE_AMBER + 1}–${AGE_RED} days: ${amber.length} (${inr(sum(amber))})`,
    ""
  );
  let text = head.join("\n");
  let shown = 0;
  for (const g of groups) {
    const line = `${ageIcon(g.age_days)} <b>${g.age_days === null ? "—" : `${g.age_days}d`}</b> · ${inr(g.value)} · ${esc(g.supplier)} · ${esc(g.location)}${
      g.claims > 1 ? ` (${g.claims} claims)` : ""
    }`;
    const more = `\n… +${groups.length - shown - 1} more on the Business Dashboard`;
    if (text.length + line.length + 1 + more.length > MAX_CHARS) {
      text += `\n… +${groups.length - shown} more on the Business Dashboard`;
      return { text, summary };
    }
    text += `\n${line}`;
    shown += 1;
  }
  return { text, summary };
}

module.exports = { groupOpen, buildMessage, MAX_CHARS };
