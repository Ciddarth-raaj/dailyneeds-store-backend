const { needsFollowUp } = require("./po_tracker");

/**
 * The 7 pm PO follow-up summary: of the POs that needed chasing today, how
 * many were chased and how many were not.
 *
 *   due today   = chased today (and due when chased) + still due at 7 pm
 *   chased      = a remark today on a PO that was due before it - judged with
 *                 the PO's last remark from BEFORE today, so a remark on a PO
 *                 that was not due yet does not count
 *   not chased  = needs_followup at 7 pm (the PO Tracker's own flag)
 *
 * Each counted separately for Awaiting delivery and Expired.
 *
 * Only POs on the tracker now (the latest per supplier and store) count.
 */
/** Awaiting delivery (still valid) or Expired (past validity), as on the PO Tracker. */
const groupOf = (o) => (Number(o.days_past_validity) > 0 ? "expired" : "awaiting");

const emptyGroup = () => ({ due: 0, chased: 0, chased_value: 0, not_chased: 0, not_chased_value: 0 });

function buildSummary({ orders, chasedToday, previousBySlug, today }) {
  const chasedSet = new Set(chasedToday || []);
  const prev = previousBySlug || new Map();
  const groups = { awaiting: emptyGroup(), expired: emptyGroup() };
  for (const o of orders || []) {
    if (o.stopped) continue; // follow-up stopped: not chased, so not counted either way
    const g = groups[groupOf(o)];
    if (chasedSet.has(o.po_slug)) {
      if (needsFollowUp(o, prev.get(o.po_slug) || null, today)) {
        g.chased += 1;
        g.chased_value += Number(o.pending_value) || 0;
      }
    } else if (o.needs_followup) {
      g.not_chased += 1;
      g.not_chased_value += Number(o.pending_value) || 0;
    }
  }
  for (const g of Object.values(groups)) g.due = g.chased + g.not_chased;
  return { today, due: groups.awaiting.due + groups.expired.due, awaiting: groups.awaiting, expired: groups.expired };
}

const lakhs = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  if (n >= 1e3) return `₹${Math.round(n / 1e3)}k`;
  return `₹${Math.round(n)}`;
};
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
const dayLabel = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function groupLines(icon, label, g) {
  if (!g.due) return [`${icon} ${label}: nothing due`];
  const po = (n) => `${n} / ${g.due}`;
  const chasedPct = pct(g.chased, g.due);
  return [
    `${icon} ${label} (${g.due} due)`,
    `   ✅ Chased: ${po(g.chased)} (${chasedPct}%)`,
    `   ⚠️ Not chased: ${po(g.not_chased)} (${100 - chasedPct}%)${g.not_chased ? ` · ${lakhs(g.not_chased_value)} pending` : ""}`,
  ];
}

/** Plain text (no Markdown), so no supplier or name can break parsing. */
function formatMessage(s) {
  const head = `📦 PO Follow-up · ${dayLabel(s.today)}`;
  if (!s.due) return `${head}\n\n✅ Nothing was due for follow-up today.`;
  return [head, "", ...groupLines("🕒", "Awaiting delivery", s.awaiting), "", ...groupLines("🔴", "Expired", s.expired)].join("\n");
}

function formatFailure(today, error) {
  return `📦 PO Follow-up · ${dayLabel(today)}\n\n⚠️ Today's summary could not be built: ${error}`;
}

module.exports = { buildSummary, formatMessage, formatFailure, lakhs };
