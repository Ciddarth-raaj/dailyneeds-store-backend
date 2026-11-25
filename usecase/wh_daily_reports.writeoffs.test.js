const test = require("node:test");
const assert = require("node:assert");
const make = require("./wh_daily_reports");

function setup(stored = 0) {
  const saved = [];
  const repo = {
    productInfo: async () => new Map([[127577, { article_name: "sri dairy milk halwa 200g" }]]),
    replaceWriteoffs: async (from, to, rows) => (saved.push({ from, to, rows }), rows.length),
    writeoffCount: async () => stored,
  };
  const queries = [];
  const spectra = {
    isConfigured: () => true,
    queryAll: async (q) => {
      queries.push(q);
      if (/masterhub\.stores/.test(q)) return [{ slug: "wh", name: "Warehouse" }, { slug: "mk", name: "Moolakulam" }];
      if (/LOADING_WRITEOFF/.test(q))
        return ["job_12134893", "job_12275517"].map((j, i) => ({ job_id: j, job_type: "ALLOC", updated_at: "2026-11-23T18:25:47.482885+05:30", box_row: `b${i}`, box_id: "127577", origin: "wh", destination: "mk", stage_id: "ADA-febc6cc0aff2", meta: { packing_job: "job_9" }, article_id: "127577", qty: "60" }));
      if (/inventory_batches/.test(q)) return [{ article_id: "127577", stock_value: "789.8", stock_qty: "10", avg_nlc: "78.98" }];
      return [];
    },
  };
  const uc = make(repo, () => "2026-11-25", spectra);
  const changed = [];
  uc.onChange = (d) => changed.push(d);
  return { uc, saved, queries, changed };
}

test("boxes written off at loading are pulled with names and NLC, stored, and the chain redone from that day", async () => {
  const { uc, saved, changed } = setup();
  const r = await uc.pullWriteoffs("2026-11-23", "2026-11-23");
  assert.deepStrictEqual([r.ok, r.rows], [true, 2]);
  assert.deepStrictEqual(saved[0].rows.map((x) => [x.box_id, x.job_id, x.qty, x.to_store, x.article_name, x.nlc]), [
    ["127577", "job_12134893", 60, "moolakulam", "sri dairy milk halwa 200g", 78.98],
    ["127577", "job_12275517", 60, "moolakulam", "sri dairy milk halwa 200g", 78.98],
  ]);
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(changed, ["2026-11-23"]);
});

test("the one-time catch-up runs only while nothing is stored", async () => {
  const empty = setup(0);
  assert.strictEqual((await empty.uc.backfillWriteoffs("2026-10-10")).ok, true);
  assert.match(empty.queries.find((q) => /LOADING_WRITEOFF/.test(q)), /BETWEEN DATE '2026-10-10' AND DATE '2026-11-25'/);
  const done = setup(5);
  assert.strictEqual(await done.uc.backfillWriteoffs("2026-10-10"), null);
});
