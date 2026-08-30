const logger = require("../utils/logger");

/**
 * Union of HQ (Offers V2) and Offers V3 active-offer product ids, mirroring
 * Price Checker's attachHqOfferStatus. Returns a Set of string product ids.
 */
async function findActiveOfferProductIds(
  productIds,
  hqOffersRepo,
  offersV3Repo
) {
  if (!productIds.length || (!hqOffersRepo && !offersV3Repo)) {
    return new Set();
  }
  const [hqActiveIds, v3ActiveIds] = await Promise.all([
    hqOffersRepo ? hqOffersRepo.listActiveOfferProductIds(productIds) : [],
    offersV3Repo
      ? offersV3Repo.getItemCodesWithAnyActiveOffer(productIds)
      : [],
  ]);
  return new Set([...hqActiveIds, ...v3ActiveIds].map(String));
}

function tagOfferProducts(items, activeOfferProductIds) {
  items.forEach((item) => {
    item.is_offer_product =
      item.product_id != null &&
      activeOfferProductIds.has(String(item.product_id));
  });
  return items;
}

class GrnUsecase {
  constructor(stockReceivedRepo, priceCheckerRepo, hqOffersRepo, offersV3Repo) {
    this.stockReceivedRepo = stockReceivedRepo;
    this.priceCheckerRepo = priceCheckerRepo;
    this.hqOffersRepo = hqOffersRepo;
    this.offersV3Repo = offersV3Repo;
  }

  async listGrnHeaders(filters = {}) {
    try {
      return await this.stockReceivedRepo.listGrnHeaders(filters);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.LIST_GRN_HEADERS",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async getGrnDetailByRefno(refno) {
    try {
      const detail = await this.stockReceivedRepo.listGrnDetailByRefno(refno);
      if (!detail) return detail;

      const productIds = [
        ...new Set(
          detail.items.map((item) => item.product_id).filter((id) => id != null)
        ),
      ];
      const activeOfferProductIds = await findActiveOfferProductIds(
        productIds,
        this.hqOffersRepo,
        this.offersV3Repo
      );
      tagOfferProducts(detail.items, activeOfferProductIds);

      return detail;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.GRN_DETAIL",
        description: err.toString(),
        category: "",
        ref: { refno },
      });
      throw err;
    }
  }

  async listGrnIssues(filters = {}) {
    try {
      const items = await this.stockReceivedRepo.listGrnDetailItemsByDateRange(
        filters.from_date,
        filters.to_date
      );

      const productIds = [
        ...new Set(
          items.map((item) => item.product_id).filter((id) => id != null)
        ),
      ];
      const [batches, activeOfferProductIds] = await Promise.all([
        this.priceCheckerRepo
          ? this.priceCheckerRepo.listGroupedItemsByProductIds(productIds)
          : [],
        findActiveOfferProductIds(
          productIds,
          this.hqOffersRepo,
          this.offersV3Repo
        ),
      ]);
      tagOfferProducts(items, activeOfferProductIds);

      const priceCheckerItemsByProduct = {};
      batches.forEach((batch) => {
        if (batch.product_id == null) return;
        const key = String(batch.product_id);
        if (!priceCheckerItemsByProduct[key]) {
          priceCheckerItemsByProduct[key] = [];
        }
        priceCheckerItemsByProduct[key].push(batch);
      });

      return { items, price_checker_items_by_product: priceCheckerItemsByProduct };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.LIST_GRN_ISSUES",
        description: err.toString(),
        category: "",
        ref: { filters },
      });
      throw err;
    }
  }
}

module.exports = (stockReceivedRepo, priceCheckerRepo, hqOffersRepo, offersV3Repo) => {
  return new GrnUsecase(stockReceivedRepo, priceCheckerRepo, hqOffersRepo, offersV3Repo);
};
