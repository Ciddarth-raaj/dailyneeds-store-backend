/**
 * RetailPilot SPECTRA rows -> DNDS mirror rows (sa_rp_session, sa_rp_line,
 * sa_rp_adjustment). Pure. Timestamps are stored in UTC with microseconds.
 * row_hash is the sha1 of the source row, so re-reading an unchanged row is
 * a no-op.
 *
 * Booked difference of a count: RetailPilot writes a zero-quantity STK_ADJ
 * "finalize marker" (session.marker_ledger_slug) whose traceability carries
 *   { audit: { counted_by, count_session }, value: { net: { delta_qty, delta_landing } } }
 * That net is the session's var_qty / var_value (review only: it is never an
 * input to incentives or rankings).
 */
const crypto = require("crypto");
const { toUtc } = require("./stock_audit_queries");

const sha1 = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");
const ts = (v) => (v == null || v === "" ? null : toUtc(v).sql);
const num = (v) => (v == null || v === "" ? null : Number(v));
const json = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  return v;
};

/** @param outletOf (rpStoreId) => outlet_id | null */
function sessionRow(r, outletOf) {
  return {
    rp_slug: String(r.slug),
    rp_store_id: String(r.store_id),
    outlet_id: outletOf(String(r.store_id)),
    article_id: Number(r.article_id),
    stock_location: r.stock_location || null,
    status: String(r.status),
    initiated_by: r.initiated_by || null,
    finalized_by: r.finalized_by || null,
    started_at: ts(r.started_at),
    finalized_at: ts(r.finalized_at),
    rp_updated_at: ts(r.updated_at),
    net_adj_action: r.net_adj_action || null,
    marker_ledger_slug: r.marker_ledger_slug || null,
    recount_slug: r.recount_slug || null,
    cancel_reason: r.cancel_reason || null,
    row_hash: sha1(r),
  };
}

function lineRow(r) {
  const cells = json(r.snapshot_cells);
  return {
    rp_slug: String(r.slug),
    session_slug: String(r.session_slug),
    stock_location: r.stock_location || null,
    batch_id: r.batch_id || null,
    mrp: num(r.mrp),
    counted_qty: num(r.counted_qty),
    snapshot_qty: num(r.snapshot_qty),
    snapshot_cells: cells == null ? null : JSON.stringify(cells),
    source: r.source || null,
    holding_type: r.holding_type || null,
    status: r.status || null,
    rp_created_at: ts(r.created_at),
    rp_updated_at: ts(r.updated_at),
    row_hash: sha1(r),
  };
}

function adjustmentRow(r) {
  const t = json(r.traceability);
  const session = t && t.audit && t.audit.count_session ? String(t.audit.count_session) : null;
  const net = t && t.value && t.value.net ? t.value.net : null;
  return {
    rp_ledger_slug: String(r.slug),
    session_slug: session,
    is_marker: session && Number(r.quantity) === 0 ? 1 : 0,
    rp_store_id: String(r.store_id),
    article_id: Number(r.article_id),
    batch_id: r.batch_id || null,
    stock_location: r.stock_location || null,
    quantity: Number(r.quantity) || 0,
    net_landing_cost: num(r.net_landing_cost),
    mrp: num(r.mrp),
    traceability: t == null ? null : JSON.stringify(t),
    ts: ts(r.ts),
    row_hash: sha1(r),
    // the session's booked difference, from its finalize marker
    var_qty: net && net.delta_qty != null ? Number(net.delta_qty) : null,
    var_value: net && net.delta_landing != null ? Number(net.delta_landing) : null,
  };
}

/** Sync issues for one page of sessions. */
function sessionIssues(rows, { isMappedUser, isMappedStore, staleBefore }) {
  const out = [];
  for (const s of rows) {
    if (!isMappedStore(s.rp_store_id)) out.push({ kind: "UNMAPPED_STORE", rp_ref: s.rp_store_id, detail: "RetailPilot store not in Branch Master (outlets.retailpilot_id)" });
    const user = s.finalized_by || s.initiated_by;
    if (s.status === "FINALIZED" && user && !isMappedUser(user)) out.push({ kind: "UNMAPPED_USER", rp_ref: user, detail: `Finalized counts at ${s.rp_store_id}` });
    if (s.status === "IN_PROGRESS" && s.started_at && staleBefore && s.started_at < staleBefore) out.push({ kind: "STALE_IN_PROGRESS", rp_ref: s.rp_slug, detail: `In progress since ${s.started_at} UTC at ${s.rp_store_id}` });
  }
  return out;
}

module.exports = { sessionRow, lineRow, adjustmentRow, sessionIssues, sha1 };
