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

describe("needsFollowUp", () => {
  const TODAY = "2026-11-16";
  const po = (o) => ({ status: "APPROVED", po_date: "2026-11-10", ...o });
  it("only approved POs at least 2 days old", () => {
    assert.equal(P.needsFollowUp(po(), null, TODAY), true);
    assert.equal(P.needsFollowUp(po({ po_date: "2026-11-14" }), null, TODAY), true);
    assert.equal(P.needsFollowUp(po({ po_date: "2026-11-15" }), null, TODAY), false);
    assert.equal(P.needsFollowUp(po({ status: "PARTIALLY_FULFILLED" }), null, TODAY), false);
    assert.equal(P.needsFollowUp(po({ status: "FULFILLED" }), null, TODAY), false);
  });
  it("a remark clears it until its next date, or for 2 days", () => {
    assert.equal(P.needsFollowUp(po(), { created_day: "2026-11-15" }, TODAY), false);
    assert.equal(P.needsFollowUp(po(), { created_day: "2026-11-14" }, TODAY), true);
    assert.equal(P.needsFollowUp(po(), { created_day: "2026-11-10", next_follow_up_date: "2026-11-18" }, TODAY), false);
    assert.equal(P.needsFollowUp(po(), { created_day: "2026-11-15", next_follow_up_date: "2026-11-16" }, TODAY), true);
  });
});

describe("follow-ups usecase", () => {
  const spectra = { isConfigured: () => true, queryAll: async () => [{ ...ROW, status: "APPROVED", po_date: "2026-11-10" }] };
  const store = () => {
    const rows = [];
    return {
      rows,
      async add(r) { const row = { ...r, po_followup_id: rows.length + 1, created_at: "2026-11-16T05:00:00Z", created_by_name: "Prashanth" }; rows.push(row); return row; },
      async forPo(slug) { return rows.filter((r) => r.po_slug === slug).reverse(); },
      async forSupplier() { return []; },
      async latestFor(slugs) { return slugs.map((s) => rows.filter((r) => r.po_slug === s).pop()).filter(Boolean).map((r) => ({ ...r, remark_count: 1 })); },
    };
  };
  it("lists POs needing follow-up, and a remark clears it", async () => {
    const f = store();
    const uc = usecaseFactory(spectra, f, () => Date.now(), () => "2026-11-16");
    assert.equal((await uc.list()).data.orders[0].needs_followup, true);
    const add = await uc.addFollowup({ slug: "po1", channel: "CALL", remark: " Truck on Friday ", promised_delivery_date: "2026-11-21", employee_id: 7 });
    assert.equal(add.code, 200);
    assert.equal(f.rows[0].remark, "Truck on Friday");
    assert.equal(f.rows[0].supplier_id, "9");
    const after = (await uc.list()).data.orders[0];
    assert.equal(after.needs_followup, false);
    assert.equal(after.last_followup.promised_delivery_date, "2026-11-21");
    assert.equal((await uc.followups({ slug: "po1" })).data.remarks.length, 1);
  });
  it("refuses bad input and POs not on the tracker", async () => {
    const uc = usecaseFactory(spectra, store(), () => Date.now(), () => "2026-11-16");
    assert.equal((await uc.addFollowup({ slug: "po1", channel: "CALL", remark: "  ", employee_id: 7 })).code, 422);
    assert.equal((await uc.addFollowup({ slug: "po1", channel: "SMS", remark: "x", employee_id: 7 })).code, 422);
    assert.equal((await uc.addFollowup({ slug: "po1", channel: "CALL", remark: "x", next_follow_up_date: "2026-11-01", employee_id: 7 })).code, 422);
    assert.equal((await uc.addFollowup({ slug: "zzz", channel: "CALL", remark: "x", employee_id: 7 })).code, 404);
    assert.equal((await uc.addFollowup({ slug: "po1", channel: "CALL", remark: "x" })).code, 403);
  });
});

describe("routes", () => {
  const express = require("express");
  const http = require("http");
  const routesFactory = require("../routes/po_tracker");
  const call = (app, method, url, body) =>
    new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const req = http.request({ port: srv.address().port, path: url, method, headers: { "content-type": "application/json" } }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => (srv.close(), resolve({ status: res.statusCode, body: JSON.parse(d || "{}") })));
        });
        req.end(body ? JSON.stringify(body) : undefined);
      });
    });
  const appWith = (held) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => ((req.decoded = { employee_id: 7 }), next()));
    const permissions = { require: (k) => (req, res, next) => (held.includes(k) ? next() : res.status(403).json({ code: 403 })) };
    const usecase = { addFollowup: async (a) => ({ code: 200, data: a }), list: async () => ({ code: 200, data: {} }) };
    app.use("/po-tracker", routesFactory(usecase, permissions).getRouter());
    return app;
  };
  it("adding needs add_po_followup; viewing needs view_po_tracker", async () => {
    assert.equal((await call(appWith(["view_po_tracker"]), "POST", "/po-tracker/p1/followups", { channel: "CALL", remark: "x" })).status, 403);
    assert.equal((await call(appWith([]), "GET", "/po-tracker")).status, 403);
    const ok = await call(appWith(["add_po_followup"]), "POST", "/po-tracker/p1/followups", { channel: "CALL", remark: "x" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.employee_id, 7);
    assert.equal((await call(appWith(["add_po_followup"]), "POST", "/po-tracker/p1/followups", { channel: "FAX", remark: "x" })).status, 422);
  });
});
