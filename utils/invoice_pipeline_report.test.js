/**
 * The end-of-day Invoice pipeline report: its HTML, its caption, and the
 * build -> upload -> Telegram run (with the PDF, S3 and Telegram faked).
 *
 *   node --test utils/invoice_pipeline_report.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const R = require("./invoice_pipeline_report");
const reportFactory = require("../usecase/invoice_pipeline_report");

const NOW = Date.parse("2026-11-17T15:30:00Z"); // 9:00 pm IST
const FLOW = {
  stores: [
    { key: "outlet:2", name: "Warehouse" },
    { key: "outlet:3", name: "Kathirkamam" },
  ],
  stages: [
    { key: "gate_pass", label: "Gate pass", ok: true, rows: [{ ref: "GP-1", kind: "gate_pass", gate_pass: "GP-1", supplier_name: "sunlife", store: "outlet:2", since: "2026-11-15T05:00:00Z" }] },
    { key: "inspection", label: "Inspection", ok: true, rows: [] },
    {
      key: "grn",
      label: "GRN",
      ok: true,
      rows: [
        { ref: "d1", kind: "document", doc_state: "no_template", invoice_no: "GST/405", gate_pass: "GP-9", supplier_name: "Acme <Foods>", store: "outlet:2", since: "2026-11-17T14:00:00Z" },
        { ref: "d2", kind: "document", doc_state: "cost_qc_failed", invoice_no: "HUL/1", supplier_name: "Hindustan Unilever", store: "outlet:2", since: "2026-11-14T10:00:00Z" },
        { ref: "d3", kind: "document", doc_state: "no_template", invoice_no: "X/2", supplier_name: "Zed", store: "outlet:3", since: "2026-11-16T10:00:00Z" },
      ],
    },
    {
      key: "allocation",
      label: "Allocation",
      ok: true,
      rows: [
        { ref: "INV-a", kind: "allocation", invoice_no: "HUL/9", supplier_name: "Hindustan Unilever", store: "outlet:2", since: "2026-11-10T10:00:00Z", allocated: false, retries: 3, invoice_amount: 48250.5 },
        { ref: "INV-b", kind: "allocation", invoice_no: "AMF/1", supplier_name: "Aachi", store: "outlet:2", since: "2026-11-17T12:00:00Z", allocated: true, retries: 0 },
      ],
    },
    { key: "ready_to_dispatch", label: "Ready to dispatch", ok: false, built: false, rows: [] },
  ],
  attention: [
    { key: "no_invoice", ok: true, rows: [{ ref: "GP-7", kind: "gate_pass", gate_pass: "GP-7", supplier_name: "Vittala", store: "outlet:2", since: "2026-11-16T09:00:00Z" }] },
    { key: "written_off", ok: true, rows: [{ ref: "IN-5" }, { ref: "IN-6" }] },
  ],
};

describe("report", () => {
  it("summarises each step, GRN by RetailPilot stage, allocation split", () => {
    const s = R.summarize(FLOW, NOW);
    assert.deepEqual([s.gate_pass.count, s.gate_pass.over_day], [1, 1]);
    assert.deepEqual(s.grn.stages, [
      { state: "no_template", label: "Yet to start", count: 2 },
      { state: "cost_qc_failed", label: "Cost variance detected", count: 1 },
    ]);
    assert.equal(s.grn.over_day, 2);
    assert.deepEqual([s.allocation.not_allocated, s.allocation.allocated], [1, 1]);
    assert.deepEqual([s.no_invoice, s.written_off], [1, 2]);
  });

  it("the HTML lists every row oldest first, escapes what it prints, and fetches nothing", () => {
    const { html } = R.buildReport(FLOW, { nowMs: NOW });
    assert.match(html, /Invoice pipeline — end of day/);
    assert.match(html, /Acme &lt;Foods&gt;/);
    assert.doesNotMatch(html, /Acme <Foods>/);
    assert.doesNotMatch(html, /https?:\/\//, "no external fonts or images");
    const yet = html.slice(html.indexOf("GRN · Yet to start"));
    assert.ok(yet.indexOf("X/2") < yet.indexOf("GST/405"), "16 Nov before 17 Nov");
    assert.match(html, /3 retries · ₹48,251/);
    assert.match(html, /Inspected, invoice not uploaded/);
  });

  it("attention required: everything over 48h from every step, oldest first, at the top", () => {
    const rows = R.attentionRows(FLOW, NOW);
    assert.deepEqual(rows.map((r) => [r.ref, r.step]), [
      ["INV-a", "allocation"],
      ["d2", "grn"],
      ["GP-1", "gate_pass"],
    ]);
    assert.equal(R.summarize(FLOW, NOW).attention, 3);
    const { html } = R.buildReport(FLOW, { nowMs: NOW });
    const att = html.indexOf("Attention required — waiting over 48h");
    assert.ok(att > 0 && att < html.indexOf("1 · Gate pass — not inspected"), "before the step lists");
    assert.match(html, /<tr class="critical">/);
    assert.match(html, /<tr class="late">/, "24-48h rows stay orange");
  });

  it("nothing over 48h says so", () => {
    const fresh = { ...FLOW, stages: FLOW.stages.map((s) => ({ ...s, rows: (s.rows || []).filter((r) => Date.parse(r.since) > NOW - 47 * 3600000) })) };
    assert.deepEqual(R.attentionRows(fresh, NOW), []);
    assert.match(R.buildReport(fresh, { nowMs: NOW }).html, /Nothing has waited over 48 hours/);
    assert.match(R.captionText(R.summarize(fresh, NOW), NOW), /✅ Nothing waiting over 48h/);
  });

  it("a step RetailPilot could not read says so instead of showing nothing", () => {
    const broken = { ...FLOW, stages: FLOW.stages.map((s) => (s.key === "grn" ? { ...s, ok: false, error: "whitelist_violation", rows: [] } : s)) };
    const { html } = R.buildReport(broken, { nowMs: NOW });
    assert.match(html, /Could not be read from RetailPilot: whitelist_violation/);
  });

  it("the caption carries the headline numbers within Telegram's limit", () => {
    const text = R.captionText(R.summarize(FLOW, NOW), NOW);
    assert.match(text, /Invoice pipeline — 17 Nov 2026/);
    assert.match(text, /⚠️ Attention required: 3 waiting over 48h/);
    assert.match(text, /GRN 3 \(Yet to start 2, Cost variance detected 1\)/);
    assert.match(text, /not allocated 1, allocated 1/);
    assert.ok(text.length <= 1024);
  });
});

describe("run", () => {
  const deps = (over = {}) => {
    const sent = [];
    const uploads = [];
    return {
      sent,
      uploads,
      flow: { getFlow: async (args) => ({ code: 200, data: FLOW, args }) },
      pdf: { withBrowser: async (fn) => fn({ renderPdf: async (html) => Buffer.from(`PDF:${html.length}`) }) },
      s3: {
        uploadFile: async (p, name, type, buf) => {
          uploads.push({ name, type, size: buf.length });
          return `https://bucket.example/${name}`;
        },
      },
      telegram: { sendDocument: async (chat, url, caption) => sent.push({ chat, url, caption }) },
      chatId: -4668439381,
      now: () => NOW,
      ...over,
    };
  };

  it("builds, uploads and sends the PDF to the group with the caption", async () => {
    const d = deps();
    const r = await reportFactory(d).run({ trigger: "manual" });
    assert.equal(r.code, 200);
    assert.equal(d.uploads.length, 1);
    assert.match(d.uploads[0].name, /^invoice_pipeline\/eod_2026-11-17_\d+\.pdf$/);
    assert.equal(d.uploads[0].type, "application/pdf");
    assert.deepEqual(d.sent.map((s) => s.chat), [-4668439381]);
    assert.match(d.sent[0].caption, /Gate pass 1 · Inspection 0/);
  });

  it("one run at a time; no group or a failed read sends nothing", async () => {
    let release;
    const slow = deps({ flow: { getFlow: () => new Promise((res) => (release = () => res({ code: 200, data: FLOW }))) } });
    const uc = reportFactory(slow);
    const first = uc.run();
    assert.equal((await uc.run()).code, 409);
    release();
    assert.equal((await first).code, 200);

    assert.equal((await reportFactory(deps({ chatId: null })).run()).code, 400);
    const failing = deps({ flow: { getFlow: async () => ({ code: 502, msg: "RetailPilot down" }) } });
    const r = await reportFactory(failing).run();
    assert.equal(r.code, 502);
    assert.equal(failing.sent.length, 0);
  });

  it("a failure in Telegram is reported, not thrown", async () => {
    const d = deps({ telegram: { sendDocument: async () => { throw new Error("chat not found"); } } });
    const r = await reportFactory(d).run();
    assert.equal(r.code, 500);
    assert.match(r.msg, /chat not found/);
  });
});
