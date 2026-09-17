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

/** A GRN with no local verification row has not been verified yet. */
const PENDING_VERIFICATION = Object.freeze({
  status: "PENDING",
  verified_by: null,
  verified_by_name: null,
  verified_at: null,
});

/**
 * The verification block every GRN payload carries.
 *
 * Always present, never undefined: a GRN that predates this feature - which
 * is every GRN already in GoFrugal - reads as PENDING rather than as a
 * missing field the frontend has to interpret. The verifier's display NAME
 * is resolved here too, so a list of fifty GRNs does not turn into fifty
 * employee lookups from the browser.
 */
function verificationOf(row) {
  if (!row) return { ...PENDING_VERIFICATION };
  return {
    status: "VERIFIED",
    verified_by: row.verified_by ?? null,
    verified_by_name: row.verified_by_name ?? null,
    verified_at: row.verified_at ?? null,
  };
}

function verificationsByRefno(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    if (row?.mmh_mrc_refno == null) return;
    map.set(String(row.mmh_mrc_refno), verificationOf(row));
  });
  return map;
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
      const headers = await this.stockReceivedRepo.listGrnHeaders(filters);
      const byRefno = verificationsByRefno(
        await this.stockReceivedRepo.listGrnVerificationsByRefnos(
          headers.map((header) => header.mmh_mrc_refno)
        )
      );
      return headers.map((header) => ({
        ...header,
        verification:
          byRefno.get(String(header.mmh_mrc_refno)) ?? {
            ...PENDING_VERIFICATION,
          },
      }));
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
      const [offerDetailsByProductId, ignoredRows, verificationRow] =
        await Promise.all([
          findActiveOfferDetails(
            productIds,
            this.hqOffersRepo,
            this.offersV3Repo
          ),
          this.stockReceivedRepo.listIgnoredGrnIssueKeysByRefno(refno),
          this.stockReceivedRepo.getGrnVerificationByRefno(refno),
        ]);
      tagOfferProducts(detail.items, new Set(offerDetailsByProductId.keys()));
      tagOfferDetails(detail.items, offerDetailsByProductId);
      tagIgnoredItems(
        detail.items,
        new Set(ignoredRows.map((row) => String(row.mmd_mrc_sl_no)))
      );

      detail.verification = verificationOf(verificationRow);

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

  /**
   * Marks a GRN as checked and verified by the authenticated caller.
   *
   * `verifiedBy` is the employee id the route read off the JWT - the route
   * never takes it from the request body - and the timestamp is the
   * database's, written by the column default. The insert is an INSERT
   * IGNORE, so a GRN that is ALREADY VERIFIED comes back with its original
   * verifier and time and `already_verified: true`; clicking twice cannot
   * rewrite who signed it off. Reopening a verification is deliberately not
   * offered here.
   */
  async verifyGrn(refno, verifiedBy) {
    try {
      const detail = await this.stockReceivedRepo.listGrnDetailByRefno(refno);
      if (!detail) return null;

      const { created } = await this.stockReceivedRepo.insertGrnVerification(
        refno,
        verifiedBy
      );
      const row = await this.stockReceivedRepo.getGrnVerificationByRefno(refno);

      return {
        already_verified: !created,
        verification: verificationOf(row),
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GRN",
        code: "USECASE.GRN.VERIFY_GRN",
        description: err.toString(),
        category: "",
        ref: { refno },
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
