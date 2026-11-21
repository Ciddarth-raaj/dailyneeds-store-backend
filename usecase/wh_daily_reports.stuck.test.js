const test = require("node:test");
const assert = require("node:assert");
const make = require("./wh_daily_reports");

const repo = { productInfo: async () => new Map([[100500, { article_name: "surf excel detergent bar 800g" }]]), staffMap: async () => [{ rp_user_id: "tuxbOdI82lFA", employee_id: 9, employee_name: "Kumar" }] };
const spectra = (refuseRatio) => ({
  isConfigured: () => true,
  queryAll: async (q) => {
    if (/masterhub\.stores/.test(q)) return [{ slug: "st_vs", name: "Vallalar Salai" }];
    if (/box_ratio/.test(q)) {
      if (refuseRatio) throw new Error("SPECTRA error: whitelist_violation");
      return [{ box_id: "7186914543", joblet_id: "aj1", updated_at: "2026-10-16T13:38:00Z", pack_job: "job_62735109", destination: "st_vs", assigned_user: "tuxbOdI82lFA" }];
    }
    if (/state = 'LOADING'/.test(q)) {
      assert.match(q, /< DATE '2026-11-19'/); // more than 2 days
      return [{ load_job: "job_88669842", job_type: "GRN", created_at: "2026-10-16T13:40:00Z", joblet: "bj1", box_id: "7186914543", origin: "wh1", destination: "st_vs", article_id: "100500", qty: "20" }];
    }
    if (/inventory_batches/.test(q)) return [{ article_id: "100500", stock_value: "110", stock_qty: "2", avg_nlc: "55" }];
    return [];
  },
});

test("stuck cartons: names, NLC value, packer name; cached", async () => {
  const uc = make(repo, () => "2026-11-21", spectra(false));
  const r = await uc.stuckCartons();
  assert.strictEqual(r.ok, true);
  const c = r.cartons[0];
  assert.deepStrictEqual([c.carton, c.days, c.units, c.value, c.packer_name, c.items[0].article_name], ["7186914543", 36, 20, 1100, "Kumar", "surf excel detergent bar 800g"]);
  assert.strictEqual(await uc.stuckCartons(), r);
});

test("RetailPilot refusing box_ratio leaves the packer out, not the cartons", async () => {
  const uc = make(repo, () => "2026-11-21", spectra(true));
  const r = await uc.stuckCartons();
  assert.deepStrictEqual([r.ok, r.cartons.length, r.cartons[0].packer], [true, 1, null]);
  assert.match(r.packer_note, /whitelist_violation/);
});
