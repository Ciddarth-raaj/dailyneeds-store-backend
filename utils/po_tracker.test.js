/**
 * PO Tracker - row mapping and the usecase cache.
 *
 *   node --test utils/po_tracker.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./po_tracker");
const usecaseFactory = require("../usecase/po_tracker");

const ROW = {
  po_ref: "PO-1", po_slug: "po1", store_id: "wh", store: "Warehouse", supplier_id: "9", trade_name: "Acme",
  raised_by: "Ravi", status: "PARTIALLY_FULFILLED", po_date: "2026-11-10T00:00:00Z", validity_date: "2026-11-14",
  expired: "Yes", days_past_validity: "2", older_pos_ignored: "3", net_amount: "1200.50", lines: "4", open_lines: "1",
  pending_qty: "5", pending_value: "100.25", ordered_qty: "40", received_qty: "35", qty_fill_pct: "87.5", value_fill_pct: "90.1",
};

describe("mapPurchaseOrders", () => {
  it("maps numbers, dates and expired, and keeps a repeated PO once", () => {
    const [po, ...rest] = P.mapPurchaseOrders([ROW, ROW]);
    assert.equal(rest.length, 0);
    assert.equal(po.supplier, "Acme");
    assert.equal(po.po_date, "2026-11-10");
    assert.equal(po.expired, true);
    assert.equal(po.net_amount, 1200.5);
    assert.equal(po.qty_fill_pct, 87.5);
    assert.equal(po.older_pos_ignored, 3);
  });
  it("leaves fill blank when the query does", () => {
    const [po] = P.mapPurchaseOrders([{ ...ROW, status: "APPROVED", expired: "No", qty_fill_pct: null }]);
    assert.equal(po.expired, false);
    assert.equal(po.qty_fill_pct, null);
  });
});

describe("usecase", () => {
  it("reuses one answer until refresh", async () => {
    let calls = 0;
    const uc = usecaseFactory({ isConfigured: () => true, queryAll: async () => (calls++, [ROW]) });
    assert.equal((await uc.list()).data.orders.length, 1);
    await uc.list();
    assert.equal(calls, 1);
    await uc.list({ refresh: true });
    assert.equal(calls, 2);
  });
  it("answers 502 when RetailPilot fails", async () => {
    const uc = usecaseFactory({ isConfigured: () => true, queryAll: async () => { throw new Error("down"); } });
    assert.equal((await uc.list()).code, 502);
  });
});
