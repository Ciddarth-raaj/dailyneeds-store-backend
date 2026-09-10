const logger = require("../utils/logger");

function tagOfferProducts(items, activeOfferProductIds) {
  items.forEach((item) => {
    item.is_offer_product =
      item.product_id != null &&
      activeOfferProductIds.has(String(item.product_id));
  });
  return items;
}

/**
 * Fetches a hover-tooltip-friendly summary of each active offer (HQ/Offers
 * V2 name, Offers V3 item/batch offer_type+value) for the given product
 * ids. Returns a Map of string product id -> array of detail objects.
 */
async function findActiveOfferDetails(productIds, hqOffersRepo, offersV3Repo) {
  const map = new Map();
  if (!productIds.length) return map;

  const [hqDetails, v3Details] = await Promise.all([
    hqOffersRepo?.listActiveOfferDetailsForProductIds
      ? hqOffersRepo.listActiveOfferDetailsForProductIds(productIds)
      : [],
    offersV3Repo?.listActiveOfferDetailsForItemCodes
      ? offersV3Repo.listActiveOfferDetailsForItemCodes(productIds)
      : [],
  ]);

  (hqDetails || []).forEach((row) => {
    const key = String(row.product_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ source: "hq", offer_name: row.offer_name });
  });

  (v3Details || []).forEach((row) => {
    const key = String(row.item_code);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      source: "v3",
      scope: row.scope,
      offer_type: row.offer_type,
      value: row.value,
    });
  });

  return map;
}

function tagOfferDetails(items, offerDetailsByProductId) {
  items.forEach((item) => {
    item.offer_details =
      item.product_id != null
        ? offerDetailsByProductId.get(String(item.product_id)) ?? []
        : [];
  });
  return items;
}

// `detail.items` from listGrnDetailByRefno don't carry mmh_mrc_refno per row
// (they're all implicitly the one refno requested), so ignoredSlNos is scoped
// to that refno and keyed on mmd_mrc_sl_no alone.
function tagIgnoredItems(items, ignoredSlNos) {
  items.forEach((item) => {
    item.is_ignored = ignoredSlNos.has(String(item.mmd_mrc_sl_no));
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
      const [offerDetailsByProductId, ignoredRows] = await Promise.all([
        findActiveOfferDetails(productIds, this.hqOffersRepo, this.offersV3Repo),
        this.stockReceivedRepo.listIgnoredGrnIssueKeysByRefno(refno),
      ]);
      tagOfferProducts(detail.items, new Set(offerDetailsByProductId.keys()));
      tagOfferDetails(detail.items, offerDetailsByProductId);
      tagIgnoredItems(
        detail.items,
        new Set(ignoredRows.map((row) => String(row.mmd_mrc_sl_no)))
      );

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
      const [rawItems, ignoredRows] = await Promise.all([
        this.stockReceivedRepo.listGrnDetailItemsByDateRange(
          filters.from_date,
          filters.to_date
        ),
        this.stockReceivedRepo.listIgnoredGrnIssueKeys(),
      ]);

      const ignoredKeys = new Set(
        ignoredRows.map(
          (row) => `${row.mmh_mrc_refno}:${row.mmd_mrc_sl_no}`
        )
      );
      const items = rawItems.filter(
        (item) =>
          !ignoredKeys.has(`${item.mmh_mrc_refno}:${item.mmd_mrc_sl_no}`)
      );

      const productIds = [
        ...new Set(
          items.map((item) => item.product_id).filter((id) => id != null)
        ),
      ];
      const [batches, offerDetailsByProductId] = await Promise.all([
        this.offersV3Repo
          ? this.offersV3Repo.listGroupedItemsByProductIds(productIds)
          : [],
        findActiveOfferDetails(productIds, this.hqOffersRepo, this.offersV3Repo),
      ]);
      tagOfferProducts(items, new Set(offerDetailsByProductId.keys()));
      tagOfferDetails(items, offerDetailsByProductId);

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

  async ignoreGrnIssueItems(items, ignoredBy) {
    try {
      return await this.stockReceivedRepo.ignoreGrnIssueItems(items, ignoredBy);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.IGNORE_GRN_ISSUES",
        description: err.toString(),
        category: "",
        ref: { items },
      });
      throw err;
    }
  }

  async unignoreGrnIssueItems(items) {
    try {
      return await this.stockReceivedRepo.unignoreGrnIssueItems(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.UNIGNORE_GRN_ISSUES",
        description: err.toString(),
        category: "",
        ref: { items },
      });
      throw err;
    }
  }
}

module.exports = (stockReceivedRepo, priceCheckerRepo, hqOffersRepo, offersV3Repo) => {
  return new GrnUsecase(stockReceivedRepo, priceCheckerRepo, hqOffersRepo, offersV3Repo);
};
