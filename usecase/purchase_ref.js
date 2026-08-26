const logger = require("../utils/logger");

class PurchaseRefUsecase {
  constructor(purchaseRefRepo, productSalesRepo, stockReceivedRepo) {
    this.purchaseRefRepo = purchaseRefRepo;
    this.productSalesRepo = productSalesRepo;
    this.stockReceivedRepo = stockReceivedRepo;
  }

  /**
   * Products with sales in the trailing 3 months, each with their average
   * monthly sales, latest GRN MRP/net cost, and assigned supplier name.
   */
  async listPurchaseRef() {
    try {
      const avgSalesRows = await this.productSalesRepo.listAvgSalesLast3Months();
      const productIds = avgSalesRows.map((row) => row.product_id);

      const [productMap, grnPricingMap] = await Promise.all([
        this.purchaseRefRepo.listProductsWithSupplierByIds(productIds),
        this.stockReceivedRepo.listLatestGrnPricingByProduct(),
      ]);

      return avgSalesRows.map((row) => {
        const product = productMap.get(row.product_id) || null;
        const pricing = grnPricingMap.get(row.product_id) || null;
        return {
          product_id: row.product_id,
          name: product?.name ?? null,
          supplier_name: product?.supplier_name ?? null,
          mrp: pricing?.mrp ?? null,
          net_cost: pricing?.net_cost ?? null,
          avg_sales: row.avg_sales,
        };
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PURCHASE_REF",
        code: "USECASE.PURCHASE_REF.LIST",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (purchaseRefRepo, productSalesRepo, stockReceivedRepo) =>
  new PurchaseRefUsecase(purchaseRefRepo, productSalesRepo, stockReceivedRepo);
