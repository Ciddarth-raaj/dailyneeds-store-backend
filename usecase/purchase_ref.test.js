const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { PurchaseRefUsecase } = require("./purchase_ref");

function makeUsecase({ onBuild } = {}) {
  let calls = 0;
  const productSalesRepo = {
    listAvgSalesLast3Months: async () => {
      calls += 1;
      if (onBuild) await onBuild(calls);
      return [{ product_id: 1, avg_sales: 12 }];
    },
  };
  const purchaseRefRepo = {
    listProductsWithSupplierByIds: async () =>
      new Map([
        [1, { name: "Rice", supplier_name: "Acme", image_link: "img.png" }],
      ]),
  };
  const stockReceivedRepo = {
    listLatestGrnPricingByProduct: async () =>
      new Map([[1, { mrp: 100, net_cost: 80 }]]),
  };
  const stockHoldingReportRepo = {
    getCurrentStockTotalsByDate: async () => new Map([[1, 5]]),
  };

  const usecase = new PurchaseRefUsecase(
    purchaseRefRepo,
    productSalesRepo,
    stockReceivedRepo,
    stockHoldingReportRepo
  );
  return { usecase, buildCount: () => calls };
}

describe("listPurchaseRef", () => {
  it("joins sales, product, pricing and stock into one row per product", async () => {
    const { usecase } = makeUsecase();
    const { rows, built_at } = await usecase.listPurchaseRef();
    assert.deepEqual(rows, [
      {
        product_id: 1,
        name: "Rice",
        image_url: "img.png",
        supplier_name: "Acme",
        mrp: 100,
        net_cost: 80,
        avg_sales: 12,
        current_stock: 5,
      },
    ]);
    assert.ok(!Number.isNaN(Date.parse(built_at)));
  });

  it("serves a fresh cache without rebuilding", async () => {
    const { usecase, buildCount } = makeUsecase();
    await usecase.listPurchaseRef();
    await usecase.listPurchaseRef();
    await usecase.listPurchaseRef();
    assert.equal(buildCount(), 1);
  });

  it("collapses concurrent cold callers into a single build", async () => {
    const { usecase, buildCount } = makeUsecase({
      onBuild: () => new Promise((r) => setTimeout(r, 20)),
    });
    const results = await Promise.all([
      usecase.listPurchaseRef(),
      usecase.listPurchaseRef(),
      usecase.listPurchaseRef(),
    ]);
    assert.equal(buildCount(), 1);
    results.forEach((res) => assert.equal(res.rows.length, 1));
  });

  it("rebuilds when the cache has aged past the TTL, serving the stale rows meanwhile", async () => {
    const { usecase, buildCount } = makeUsecase();
    const first = await usecase.listPurchaseRef();
    // Age the cache past the TTL.
    usecase._cache.builtAt -= 60 * 60 * 1000;
    const agedAt = new Date(usecase._cache.builtAt).toISOString();

    const stale = await usecase.listPurchaseRef();
    assert.equal(stale.built_at, agedAt, "stale rows served immediately");
    assert.deepEqual(stale.rows, first.rows);

    await usecase._building;
    assert.equal(buildCount(), 2);
    const fresh = await usecase.listPurchaseRef();
    assert.notEqual(fresh.built_at, agedAt);
  });

  it("waits for a rebuild once the cache is past the hard stale limit", async () => {
    const { usecase, buildCount } = makeUsecase();
    await usecase.listPurchaseRef();
    usecase._cache.builtAt -= 24 * 60 * 60 * 1000;
    const agedAt = new Date(usecase._cache.builtAt).toISOString();

    const res = await usecase.listPurchaseRef();
    assert.equal(buildCount(), 2);
    assert.notEqual(res.built_at, agedAt);
  });

  it("rebuilds on force even when the cache is fresh", async () => {
    const { usecase, buildCount } = makeUsecase();
    await usecase.listPurchaseRef();
    await usecase.listPurchaseRef({ force: true });
    assert.equal(buildCount(), 2);
  });

  it("keeps serving the last good rows when a background rebuild fails", async () => {
    const { usecase } = makeUsecase({
      onBuild: (n) => {
        if (n > 1) throw new Error("gofrugal down");
      },
    });
    const first = await usecase.listPurchaseRef();
    usecase._cache.builtAt -= 60 * 60 * 1000;

    const stale = await usecase.listPurchaseRef();
    assert.deepEqual(stale.rows, first.rows);
    await assert.rejects(usecase.refresh(), /gofrugal down/);
  });
});
