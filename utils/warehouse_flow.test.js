/**
 * Warehouse Flow - stage 1 (gate pass): the queries, one row per pass, the
 * store scope on the list and on one pass, and the routes' guard.
 *
 *   node --test utils/warehouse_flow.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const W = require("./warehouse_flow");
const { storeResolver } = require("./business_dashboard");
const usecaseFactory = require("../usecase/warehouse_flow");
const routesFactory = require("../routes/warehouse_flow");

const BRANCHES = [
  { outlet_id: 2, outlet_name: "Warehouse", retailpilot_id: "wh" },
  { outlet_id: 3, outlet_name: "Kathirkamam", retailpilot_id: "kathir" },
];

const PASS_ROWS = [
  { slug: "GP-1", status: "OPEN", store_id: "wh", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-1", inspection_state: "IN_PROGRESS", invoice_amount: "1500.5" },
  { slug: "GP-1", status: "OPEN", store_id: "wh", supplier_id: 42, vehicle_number: "PY01AB1234", entry_time: "2026-11-14T06:00:00Z", inspection_slug: "IN-2", inspection_state: "DONE" },
  { slug: "GP-2", status: "OPEN", store_id: "kathir", supplier_id: "9", entry_time: "2026-11-15T04:30:00Z", inspection_slug: null },
];

const INSPECTION_ROWS = [
  { slug: "IN-1", state: "IN_PROGRESS", store_id: "wh", supplier_id: 42, created_at: "2026-11-15T05:00:00Z", gatepass_slug: "GP-1", gate_status: "OPEN" },
  { slug: "IN-9", state: "COMPLETED", store_id: "kathir", supplier_id: "9", created_at: "2026-11-14T05:00:00Z", updated_at: "2026-11-14T08:00:00Z", invoice_id: null },
  { slug: "IN-7", state: "WRITTEN_OFF", store_id: "wh", supplier_id: "9", created_at: "2026-11-10T05:00:00Z", updated_at: "2026-11-10T06:00:00Z" },
];

const DOCUMENT_ROWS = [
  { slug: "doc-1", state: "no_template", store_id: "kathir", supplier_id: "9", document_id: "INV-77", gatepass_slug: "GP-2", uploaded_at: "2026-11-15T05:00:00Z" },
  { slug: "doc-2", state: "pricing_review_pending", store_id: "kathir", supplier_id: "9", document_id: "INV-78", gatepass_slug: null, uploaded_at: "2026-11-14T05:00:00Z" },
];

const ALLOCATION_ROWS = [
  { slug: "INV-aaa", invoice_id: "HUL/5520", allocation_status: "STAGED", store_id: "wh", supplier_id: 42, created_at: "2026-11-14T06:00:00Z", updated_at: "2026-11-15T06:00:00Z", total_net: "48250.5", alloc_retries: 3 },
  { slug: "INV-bbb", invoice_id: "AMF/0990", allocation_status: "SYNCED", store_id: "kathir", supplier_id: "9", created_at: "2026-11-15T04:00:00Z", total_net: 1200, alloc_retries: 0, po_slug: "PO-77" },
];

const fakeSpectra = (handler) => ({
  isConfigured: () => true,
  queries: [],
  async queryAll(q) {
    this.queries.push(q);
    return handler(q);
  },
});

const runway = () =>
  fakeSpectra((q) => {
    if (/masterhub\.vendors/.test(q)) return [{ id: "42", name: "Acme Foods" }];
    if (/allocation_status IN/.test(q)) return ALLOCATION_ROWS;
    if (/invoice_documents/.test(q)) return DOCUMENT_ROWS.filter((d) => !/gatepass_slug = '/.test(q) || q.includes(`'${d.gatepass_slug}'`));
    if (/grn_inspection_details/.test(q)) return [{ grn_inspection_id: "IN-1", lines: 12, invoice_qty: 100, inspected_qty: 96, free_qty: 4, rejected_qty: 2 }];
    if (/g\.slug = 'GP-1'/.test(q)) return PASS_ROWS.slice(0, 2);
    if (/g\.slug = 'GP-2'/.test(q)) return PASS_ROWS.slice(2);
    if (/i\.slug = 'IN-9'/.test(q)) return INSPECTION_ROWS.slice(1, 2);
    if (/i\.state NOT IN/.test(q)) return INSPECTION_ROWS;
    if (/g\.status = 'OPEN'/.test(q)) return PASS_ROWS;
    return [];
  });

describe("queries", () => {
  it("open passes only, oldest first, with their inspections", () => {
    const q = W.buildOpenGatePassesQuery();
    assert.match(q, /FROM public\.gate_passes g/);
    assert.match(q, /WHERE g\.status = 'OPEN'/);
    assert.match(q, /ON i\.gatepass_slug = g\.slug/);
    assert.match(q, /ORDER BY g\.entry_time/);
  });

  it("only a plain slug is ever put in a query", () => {
    assert.match(W.buildGatePassQuery("GP-251229-ABCDEFG-001"), /g\.slug = 'GP-251229-ABCDEFG-001'/);
    assert.throws(() => W.buildGatePassQuery("GP-1' OR '1'='1"));
    assert.equal(W.buildInspectionTotalsQuery([]), null);
    assert.equal(W.buildInspectionTotalsQuery(["x'; DROP TABLE y; --"]), null);
    assert.match(W.buildInspectionTotalsQuery(["IN-1", "IN-1", "IN-2"]), /IN \('IN-1', 'IN-2'\)/);
  });
});

describe("mapping", () => {
  it("one row per pass, supplier named, inspections collected, age to now or to exit", () => {
    const { resolve } = storeResolver(BRANCHES);
    const now = Date.parse("2026-11-15T06:00:00Z");
    const rows = W.mapGatePassRows(
      [...PASS_ROWS, { slug: "GP-3", status: "closed", store_id: "wh", entry_time: "2026-11-15T01:00:00Z", exit_time: "2026-11-15T03:30:00Z" }],
      [{ id: "42", name: "Acme Foods" }],
      resolve,
      now
    );
    assert.deepEqual(rows.map((r) => [r.slug, r.store, r.open_hours, r.inspections.length]), [
      ["GP-1", "outlet:2", 24, 2],
      ["GP-2", "outlet:3", 1.5, 0],
      ["GP-3", "outlet:2", 2.5, 0],
    ]);
    assert.equal(rows[0].supplier_name, "Acme Foods");
    assert.equal(rows[0].inspections[0].invoice_amount, 1500.5);
    assert.equal(rows[2].status, "CLOSED");
  });
});

describe("classifyFlow", () => {
  const pass = (slug, inspections, status = "OPEN") => ({ slug, status, store: "outlet:2", inspections, entry_time: "2026-11-14T06:00:00Z" });
  const insp = (slug, state, extra = {}) => ({ slug, state, store: "outlet:2", created_at: "2026-11-14T07:00:00Z", updated_at: "2026-11-14T09:00:00Z", ...extra });
  const doc = (slug, state, gate_pass, extra = {}) => ({
    slug,
    state,
    gate_pass,
    store: "outlet:2",
    uploaded_at: "2026-11-14T10:00:00Z",
    done: state === "digitized",
    dropped: ["cancelled", "duplicate_invoice"].includes(state),
    grn_started: state !== "no_template",
    ...extra,
  });

  it("places by what happened; GRN is one row per invoice waiting", () => {
    const out = W.classifyFlow(
      [
        pass("GP-wait", []),
        pass("GP-direct", []),
        pass("GP-doing", [insp("A", "IN_PROGRESS")]),
        pass("GP-3inv", [insp("B", "COMPLETED")]),
        pass("GP-no-invoice", [insp("C", "COMPLETED")]),
        pass("GP-all-done", [insp("D", "COMPLETED")]),
        pass("GP-rejected", [insp("E", "WRITTEN_OFF")]),
        pass("GP-closed", [], "CLOSED"),
      ],
      [insp("A", "IN_PROGRESS", { gate_pass: "GP-doing" }), insp("E", "WRITTEN_OFF", { gate_pass: "GP-rejected" })],
      [
        doc("d1", "no_template", "GP-direct"),
        doc("d2", "no_template", "GP-3inv", { uploaded_at: "2026-11-14T08:00:00Z" }),
        doc("d3", "cost_qc_failed", "GP-3inv"),
        doc("d4", "pricing_review_pending", "GP-3inv"),
        doc("d5", "digitized", "GP-3inv"),
        doc("d6", "digitized", "GP-all-done"),
        doc("d7", "cancelled", "GP-no-invoice"),
        doc("d8", "manual_entry_started", "GP-closed"),
        doc("d9", "no_template", null),
      ]
    );
    const refs = (k) => out[k].map((r) => r.ref);
    assert.deepEqual(refs("gate_pass"), ["GP-wait"]);
    assert.deepEqual(refs("inspection"), ["A"]);
    assert.deepEqual(refs("grn"), ["d1", "d2", "d3", "d4", "d8", "d9"], "each invoice; the GRN'd one is gone");
    assert.deepEqual(
      out.grn.map((r) => [r.gate_pass, r.grn_started]),
      [["GP-direct", false], ["GP-3inv", false], ["GP-3inv", true], ["GP-3inv", true], ["GP-closed", true], [null, false]]
    );
    assert.deepEqual([out.grn[1].since, out.grn[1].invoices, out.grn[1].inspection], ["2026-11-14T08:00:00Z", 1, "B"]);
    assert.deepEqual(refs("no_invoice"), ["GP-no-invoice"]);
    assert.deepEqual(refs("written_off"), ["E"]);
  });

  it("documents map their state to started / done / dropped", () => {
    const { resolve } = storeResolver(BRANCHES);
    const [a, b, c, d] = W.mapDocumentRows(
      [
        { slug: "x1", state: "no_template", store_id: "wh", document_id: "GST/405", gatepass_slug: "GP-1", uploaded_at: "2026-11-14T10:00:00+05:30" },
        { slug: "x2", state: "cost_qc_failed", store_id: "wh" },
        { slug: "x3", state: "digitized", store_id: "wh" },
        { slug: "x4", state: "cancelled", store_id: "wh" },
      ],
      [],
      resolve
    );
    assert.deepEqual([a.grn_started, a.invoice_no, a.gate_pass, a.store, a.uploaded_at], [false, "GST/405", "GP-1", "outlet:2", "2026-11-14T04:30:00.000Z"]);
    assert.deepEqual([b.grn_started, b.done], [true, false]);
    assert.deepEqual([c.done, d.dropped], [true, true]);
  });

  it("the documents query names its columns and takes waiting ones and those on open passes", () => {
    const q = W.buildDocumentsQuery();
    assert.doesNotMatch(q, /SELECT \*/);
    assert.doesNotMatch(q, /extracted_data/);
    assert.match(q, /d\.state NOT IN \('digitized', 'cancelled', 'duplicate_invoice'\)/);
    assert.match(q, /OR g\.status = 'OPEN'/);
    assert.doesNotMatch(q, /GROUP BY/);
    assert.match(W.buildGatePassDocumentsQuery("GP-1"), /d\.gatepass_slug = 'GP-1'/);
    assert.throws(() => W.buildGatePassDocumentsQuery("x' OR 1=1"));
  });

  it("the inspections query takes unfinished, GRN-pending and recent write-offs", () => {
    const q = W.buildActiveInspectionsQuery();
    assert.match(q, /i\.state NOT IN \('COMPLETED', 'WRITTEN_OFF'\)/);
    assert.match(q, /i\.state = 'COMPLETED' AND i\.invoice_id IS NULL/);
    assert.match(q, /CURRENT_DATE - 30/);
    assert.doesNotMatch(q, /GROUP BY/);
  });
});

describe("allocation", () => {
  it("one row per invoice: staged is not allocated, synced is allocated", () => {
    const { resolve } = storeResolver(BRANCHES);
    const rows = W.mapAllocationRows(ALLOCATION_ROWS, [{ id: "42", name: "Acme Foods" }], resolve);
    assert.deepEqual(
      rows.map((r) => [r.ref, r.invoice_no, r.supplier_name, r.store, r.allocated, r.invoices_grn_started, r.retries, r.invoice_amount]),
      [
        ["INV-aaa", "HUL/5520", "Acme Foods", "outlet:2", false, 0, 3, 48250.5],
        ["INV-bbb", "AMF/0990", null, "outlet:3", true, 1, 0, 1200],
      ]
    );
    assert.equal(rows[1].po, "PO-77");
    const q = W.buildAllocationQuery();
    assert.match(q, /h\.allocation_status IN \('STAGED', 'SYNCED'\)/);
    assert.doesNotMatch(q, /SELECT \*/);
    assert.doesNotMatch(q, /GROUP BY/);
  });
});

describe("usecase", () => {
  it("each stage holds what has happened to it, in scope", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const all = await uc.getFlow({ store_ids: null });
    const rows = (key) => all.data.stages.find((x) => x.key === key).rows.map((r) => r.ref);
    assert.deepEqual(all.data.stages.map((x) => [x.key, x.built]), [
      ["gate_pass", true],
      ["inspection", true],
      ["grn", true],
      ["allocation", true],
      ["ready_to_dispatch", false],
    ]);
    assert.deepEqual(rows("allocation"), ["INV-aaa", "INV-bbb"]);
    assert.deepEqual(rows("gate_pass"), [], "GP-2 has its invoice uploaded, so it is at GRN");
    assert.deepEqual(rows("inspection"), ["IN-1"]);
    assert.deepEqual(rows("grn"), ["doc-1", "doc-2"], "one row per invoice, with or without a gate pass");
    assert.deepEqual(all.data.attention.map((x) => [x.key, x.rows.map((r) => r.ref)]), [
      ["no_invoice", []],
      ["written_off", ["IN-7"]],
    ]);
    const own = await uc.getFlow({ store_ids: [3] });
    assert.deepEqual(own.data.stages.map((x) => x.rows.map((r) => r.ref)), [[], [], ["doc-1", "doc-2"], ["INV-bbb"], []]);
    assert.deepEqual(own.data.stores.map((x) => x.key), ["outlet:3"]);
  });

  it("one pass comes with its inspection totals; another branch's pass is not found", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const r = await uc.getGatePass({ slug: "GP-1", store_ids: null });
    assert.equal(r.code, 200);
    assert.equal(r.data.store_name, "Warehouse");
    assert.deepEqual(r.data.inspections[0].totals, { lines: 12, invoice_qty: 100, inspected_qty: 96, free_qty: 4, rejected_qty: 2 });
    assert.equal(r.data.inspections[1].totals, null);
    assert.equal((await uc.getGatePass({ slug: "GP-1", store_ids: [3] })).code, 404);
    assert.equal((await uc.getGatePass({ slug: "bad slug!" })).code, 422);
  });

  it("a gate pass's detail lists its invoices", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const r = await uc.getGatePass({ slug: "GP-2", store_ids: null });
    assert.equal(r.code, 200);
    assert.deepEqual(r.data.documents.map((d) => [d.invoice_no, d.state, d.grn_started]), [["INV-77", "no_template", false]]);
    assert.equal(r.data.documents_error, null);
  });

  it("one inspection, in scope only", async () => {
    const uc = usecaseFactory(runway(), async () => BRANCHES);
    const r = await uc.getInspection({ slug: "IN-9", store_ids: [3] });
    assert.equal(r.code, 200);
    assert.deepEqual([r.data.state, r.data.store_name, r.data.grn_started], ["COMPLETED", "Kathirkamam", false]);
    assert.equal((await uc.getInspection({ slug: "IN-9", store_ids: [2] })).code, 404);
    assert.equal((await uc.getInspection({ slug: "x y" })).code, 422);
  });

  it("RetailPilot refusing the list is reported, not thrown", async () => {
    const broken = fakeSpectra(() => {
      throw new Error("SPECTRA error: whitelist_violation");
    });
    const r = await usecaseFactory(broken, async () => BRANCHES).getFlow({});
    assert.equal(r.data.stages[0].ok, false);
    assert.match(r.data.stages[0].error, /whitelist_violation/);
  });
});

describe("routes", () => {
  const serve = (dashboards) => {
    const app = express();
    app.use("/warehouse-flow", routesFactory(usecaseFactory(runway(), async () => BRANCHES), dashboards).getRouter());
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  };
  const get = (server, path) =>
    new Promise((resolve, reject) => {
      http
        .get({ port: server.address().port, path }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        })
        .on("error", reject);
    });

  it("are behind the Business Dashboard key and scope", async () => {
    const seen = [];
    const dashboards = {
      requireDashboardAccess: (key) => (req, res, next) => {
        seen.push(key);
        req.dashboardScope = { kind: "OWN_STORE", store_ids: [3] };
        req.dashboardStoreIds = [3];
        next();
      },
      storeIdsFor: (req) => req.dashboardStoreIds,
    };
    const server = await serve(dashboards);
    try {
      const flow = await get(server, "/warehouse-flow/flow");
      assert.equal(flow.status, 200);
      assert.deepEqual(flow.body.data.stages[2].rows.map((r) => r.ref), ["doc-1", "doc-2"]);
      assert.equal(flow.body.dashboard_scope.kind, "OWN_STORE");
      assert.equal((await get(server, "/warehouse-flow/gate-pass/GP-1")).status, 404);
      assert.equal((await get(server, "/warehouse-flow/gate-pass/GP-2")).status, 200);
      assert.ok(seen.every((k) => k === "view_sales_dashboard"));
    } finally {
      server.close();
    }
  });

  it("refuse whoever the guard refuses", async () => {
    const server = await serve({
      requireDashboardAccess: () => (req, res) => res.status(403).json({ code: 403, msg: "no" }),
      storeIdsFor: () => [],
    });
    try {
      assert.equal((await get(server, "/warehouse-flow/flow")).status, 403);
    } finally {
      server.close();
    }
  });
});
