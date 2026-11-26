const logger = require("../utils/logger");
const P = require("../utils/po_tracker");
const { istToday, istDateOf } = require("../utils/istDate");

/** How long one RetailPilot answer is reused (refresh=1 skips it). */
const TTL_MS = 2 * 60 * 1000;

/** A follow-up row as the page sees it. */
const followupOut = (r) =>
  r && {
    id: r.po_followup_id,
    po_slug: r.po_slug,
    po_ref: r.po_ref,
    kind: r.kind || "REMARK",
    stop_reason: r.stop_reason || null,
    channel: r.channel || null,
    remark: r.remark,
    promised_delivery_date: r.promised_delivery_date || null,
    next_follow_up_date: r.next_follow_up_date || null,
    created_by: r.created_by,
    created_by_name: r.created_by_name || null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    created_day: r.created_at ? istDateOf(new Date(r.created_at)) : null,
    remark_count: r.remark_count === undefined ? undefined : Number(r.remark_count),
  };

/**
 * PO Tracker (utils/po_tracker.js): POs live from RetailPilot runway, with
 * the team's follow-up remarks from our own po_followups table. The
 * RetailPilot read is cached; remarks are always read fresh.
 */
class PoTracker {
  constructor(spectra, followups, now = () => Date.now(), today = () => istToday()) {
    this.spectra = spectra;
    this.followupRepo = followups;
    this.now = now;
    this.today = today;
    this.cache = null;
  }

  async _orders(refresh) {
    if (!refresh && this.cache && this.now() - this.cache.at < TTL_MS) return this.cache;
    if (!this.spectra || !this.spectra.isConfigured()) throw Object.assign(new Error("RetailPilot is not configured"), { rp: true });
    try {
      const rows = await this.spectra.queryAll(P.PO_TRACKER_QUERY);
      this.cache = { at: this.now(), orders: P.mapPurchaseOrders(rows) };
      return this.cache;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PO_TRACKER",
        code: "USECASE.PO_TRACKER.LIST",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw Object.assign(err, { rp: true });
    }
  }

  async list({ refresh = false } = {}) {
    let cached;
    try {
      cached = await this._orders(refresh);
    } catch (err) {
      return { code: 502, msg: `RetailPilot: ${err.message}` };
    }
    const today = this.today();
    let latest = new Map();
    let stopped = new Map();
    let followupsError = null;
    if (this.followupRepo) {
      try {
        const slugs = cached.orders.map((o) => o.po_slug);
        const [rows, stops] = await Promise.all([this.followupRepo.latestFor(slugs), this.followupRepo.stopStateFor(slugs)]);
        latest = new Map(rows.map((r) => [r.po_slug, followupOut(r)]));
        stopped = new Map(stops.filter((r) => r.kind === "STOP").map((r) => [r.po_slug, followupOut(r)]));
      } catch (err) {
        followupsError = "Follow-up remarks could not be read";
      }
    }
    const orders = cached.orders.map((o) => {
      const last = latest.get(o.po_slug) || null;
      const stop = stopped.get(o.po_slug) || null;
      // A stopped PO is not chased: never due, and left out of the 7 pm summary.
      return { ...o, last_followup: last, stopped: stop, needs_followup: followupsError || stop ? false : P.needsFollowUp(o, last, today) };
    });
    return {
      code: 200,
      data: { fetched_at: new Date(cached.at).toISOString(), today, first_follow_up_after_days: P.FIRST_FOLLOW_UP_AFTER_DAYS, follow_up_after_days: P.FOLLOW_UP_AFTER_DAYS, followups_error: followupsError, orders },
    };
  }

  async _order(slug) {
    try {
      const cached = await this._orders(false);
      return cached.orders.find((o) => o.po_slug === slug) || null;
    } catch (err) {
      return null;
    }
  }

  /** One PO's remarks, and the supplier's remarks on its other POs. */
  async followups({ slug }) {
    const s = P.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid purchase order" };
    const order = await this._order(s);
    const remarks = await this.followupRepo.forPo(s);
    const supplierId = (order && order.supplier_id) || (remarks[0] && remarks[0].supplier_id) || null;
    const supplierRemarks = await this.followupRepo.forSupplier(supplierId, s);
    return { code: 200, data: { po_slug: s, order, remarks: remarks.map(followupOut), supplier_remarks: supplierRemarks.map(followupOut) } };
  }

  /** Is this PO's following stopped right now? */
  async _isStopped(slug) {
    const [state] = await this.followupRepo.stopStateFor([slug]);
    return Boolean(state && state.kind === "STOP");
  }

  /** Stop following a PO (stock from another vendor, vendor changed, not needed, other). */
  async stopFollowup({ slug, reason, note, employee_id }) {
    const s = P.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid purchase order" };
    if (!employee_id) return { code: 403, msg: "Only an employee login can stop a follow-up" };
    if (!P.STOP_REASONS.includes(reason)) return { code: 422, msg: "Choose why follow-up is being stopped" };
    const text = String(note || "").trim();
    if (reason === "OTHER" && !text) return { code: 422, msg: "Add a note saying why" };
    const order = await this._order(s);
    if (!order) return { code: 404, msg: "This PO is not on the PO Tracker. Refresh and try again." };
    if (await this._isStopped(s)) return { code: 422, msg: "Follow-up on this PO is already stopped" };
    const saved = await this.followupRepo.add({
      po_slug: s,
      po_ref: order.po_ref,
      supplier_id: order.supplier_id,
      supplier_name: order.supplier,
      store_id: order.store_id,
      kind: "STOP",
      stop_reason: reason,
      remark: text,
      created_by: employee_id,
    });
    return { code: 200, data: followupOut(saved) };
  }

  /** Follow a stopped PO again; the normal follow-up rule applies from now. */
  async resumeFollowup({ slug, note, employee_id }) {
    const s = P.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid purchase order" };
    if (!employee_id) return { code: 403, msg: "Only an employee login can resume a follow-up" };
    const order = await this._order(s);
    if (!order) return { code: 404, msg: "This PO is not on the PO Tracker. Refresh and try again." };
    if (!(await this._isStopped(s))) return { code: 422, msg: "Follow-up on this PO is not stopped" };
    const saved = await this.followupRepo.add({
      po_slug: s,
      po_ref: order.po_ref,
      supplier_id: order.supplier_id,
      supplier_name: order.supplier,
      store_id: order.store_id,
      kind: "RESUME",
      remark: String(note || "").trim(),
      created_by: employee_id,
    });
    return { code: 200, data: followupOut(saved) };
  }

  /** Add one remark. The PO must be on the tracker (the latest PO for its supplier and store). */
  async addFollowup({ slug, channel, remark, promised_delivery_date, next_follow_up_date, employee_id }) {
    const s = P.validSlug(slug);
    if (!s) return { code: 422, msg: "Invalid purchase order" };
    if (!employee_id) return { code: 403, msg: "Only an employee login can add a follow-up" };
    const text = String(remark || "").trim();
    if (!text) return { code: 422, msg: "Remark is required" };
    if (!P.CHANNELS.includes(channel)) return { code: 422, msg: "Choose how you followed up" };
    const today = this.today();
    if (next_follow_up_date && next_follow_up_date < today) return { code: 422, msg: "Next follow-up date cannot be in the past" };
    const order = await this._order(s);
    if (!order) return { code: 404, msg: "This PO is not on the PO Tracker. Refresh and try again." };
    const saved = await this.followupRepo.add({
      po_slug: s,
      po_ref: order.po_ref,
      supplier_id: order.supplier_id,
      supplier_name: order.supplier,
      store_id: order.store_id,
      channel,
      remark: text,
      promised_delivery_date: promised_delivery_date || null,
      next_follow_up_date: next_follow_up_date || null,
      created_by: employee_id,
    });
    return { code: 200, data: followupOut(saved) };
  }
}

module.exports = (spectra, followups, now, today) => new PoTracker(spectra, followups, now, today);
