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
 * Only POs on the tracker now (the latest per supplier and store) count.
 */
function buildSummary({ orders, chasedToday, previousBySlug, today }) {
  const chasedSet = new Set(chasedToday || []);
  const prev = previousBySlug || new Map();
  let chased = 0;
  let chasedValue = 0;
  let notChased = 0;
  let notChasedValue = 0;
  for (const o of orders || []) {
    if (chasedSet.has(o.po_slug)) {
      if (needsFollowUp(o, prev.get(o.po_slug) || null, today)) {
        chased += 1;
        chasedValue += Number(o.pending_value) || 0;
      }
    } else if (o.needs_followup) {
      notChased += 1;
      notChasedValue += Number(o.pending_value) || 0;
    }
  }
  return { today, due: chased + notChased, chased, chased_value: chasedValue, not_chased: notChased, not_chased_value: notChasedValue };
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

/** Plain text (no Markdown), so no supplier or name can break parsing. */
function formatMessage(s) {
  const head = `📦 PO Follow-up · ${dayLabel(s.today)}`;
  if (!s.due) return `${head}\n\n✅ Nothing was due for follow-up today.`;
  const po = (n) => `${n} / ${s.due} PO${s.due === 1 ? "" : "s"}`;
  return [
    head,
    "",
    `✅ Chased: ${po(s.chased)} (${pct(s.chased, s.due)}%)`,
    `⚠️ Not chased: ${po(s.not_chased)} (${s.due ? 100 - pct(s.chased, s.due) : 0}%)${s.not_chased ? ` · ${lakhs(s.not_chased_value)} pending` : ""}`,
  ].join("\n");
}

function formatFailure(today, error) {
  return `📦 PO Follow-up · ${dayLabel(today)}\n\n⚠️ Today's summary could not be built: ${error}`;
}

module.exports = { buildSummary, formatMessage, formatFailure, lakhs };
