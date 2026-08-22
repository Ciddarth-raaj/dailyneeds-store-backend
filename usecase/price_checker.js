const logger = require("../utils/logger");
const priceCheckerJobs = require("../services/price_checker_jobs");
const {
  buildExpectedSellingPrices,
  enrichLineItemExpectedSelling,
} = require("../utils/expectedSellingPrice");
const {
  analyzeProductItems,
  getBasisValue,
  getEffectiveSp,
  parseNum,
  resolveBasisType,
  trimStr,
} = require("../utils/priceCheckerConflicts");

function parseDecimal(v) {
  return parseNum(v);
}

function parseIntId(v) {
  const n = parseInt(trimStr(v), 10);
  return Number.isFinite(n) ? n : null;
}

function productDisplayName(row) {
  return row.de_name || row.de_display_name || "";
}

function mapLineItem(row) {
  return {
    Outlet_ID: String(row.outlet_id ?? ""),
    Outlet_Name: row.outlet_name ?? "",
    Item_Code: String(row.product_id ?? ""),
    Item_Name:
      typeof row.item_name === "string"
        ? row.item_name.replace(/[^a-zA-Z0-9]/g, "_")
        : row.item_name ?? "",
    Batch_No: row.batch_no ?? "",
    Purchase_Price: row.purchase_price ?? "",
    Landing_Cost: row.landing_cost ?? "",
    Old_MRP: row.old_mrp ?? "",
    New_MRP: row.new_mrp ?? "",
    Old_Selling_Price: row.old_selling_price ?? "",
    New_Selling_Price: row.new_selling_price ?? "",
    de_distributor: row.de_distributor ?? "",
    de_preparation_type: row.de_preparation_type ?? "",
    distributor_id: row.distributor_id ?? "",
    buyer_name: row.buyer_name ?? "",
  };
}

function buildProducts(rows) {
  const groupedByItem = {};

  for (const row of rows) {
    const itemCode = String(row.product_id ?? "").trim();
    if (!itemCode) continue;

    if (!groupedByItem[itemCode]) {
      groupedByItem[itemCode] = {
        Item_Code: itemCode,
        Item_Name: productDisplayName(row),
        de_distributor: row.de_distributor ?? "",
        de_preparation_type: row.de_preparation_type ?? "",
        distributor_id: row.distributor_id ?? "",
        buyer_name: row.buyer_name ?? "",
        items: [],
        allSellingPrices: [],
        incorrectSellingPrices: [],
        hasIssue: false,
      };
    }

    groupedByItem[itemCode].items.push(mapLineItem(row));

    if (!groupedByItem[itemCode].Item_Name) {
      groupedByItem[itemCode].Item_Name = productDisplayName(row);
    }
    if (!groupedByItem[itemCode].de_distributor && row.de_distributor) {
      groupedByItem[itemCode].de_distributor = row.de_distributor;
    }
    if (!groupedByItem[itemCode].de_preparation_type && row.de_preparation_type) {
      groupedByItem[itemCode].de_preparation_type = row.de_preparation_type;
    }
    if (!groupedByItem[itemCode].buyer_name && row.buyer_name) {
      groupedByItem[itemCode].buyer_name = row.buyer_name;
    }
    if (!groupedByItem[itemCode].distributor_id && row.distributor_id) {
      groupedByItem[itemCode].distributor_id = row.distributor_id;
    }
  }

  return Object.values(groupedByItem);
}

function sellingPricesMatch(actual, expected) {
  const actualValue = parseDecimal(actual);
  const expectedValue = parseDecimal(expected);
  if (actualValue == null || expectedValue == null) {
    return trimStr(actual) === trimStr(expected);
  }
  return Math.round(actualValue * 100) === Math.round(expectedValue * 100);
}

function enrichSellingPriceIssues(product) {
  const analysis = analyzeProductItems(product.items || []);

  const mismatchesByGroupKey = new Map();
  for (const item of product.items || []) {
    const basisType = resolveBasisType(item.mpfd_price_parameter);
    const basisValue = getBasisValue(item, basisType);
    const selling = getEffectiveSp(item);
    const expected = trimStr(item.Expected_Selling);
    if (basisValue == null || selling == null) continue;

    const key = `${basisType}|${basisValue}`;
    if (!mismatchesByGroupKey.has(key)) {
      mismatchesByGroupKey.set(key, false);
    }

    if (expected && !sellingPricesMatch(selling, expected)) {
      mismatchesByGroupKey.set(key, true);
    }
  }

  product.allSellingPrices = analysis.groups.map((group) => {
    const key = `${group.basisType}|${group.basisValue}`;
    const mismatchesExpected = mismatchesByGroupKey.get(key) === true;
    const hasConflict = group.hasConflict === true;

    return {
      mrp: group.mrp,
      basisType: group.basisType,
      basisValue: group.basisValue,
      basisLabel: group.basisLabel,
      sellingPrices: group.sellingPrices,
      hasConflict,
      mismatchesExpected,
      hasIssue: hasConflict || mismatchesExpected,
    };
  });

  product.hasConflict = analysis.hasConflict;
  product.conflictExportClass = analysis.conflictExportClass;
  product.incorrectSellingPrices = product.allSellingPrices.filter(
    (group) => group.hasIssue
  );
  product.hasIssue = product.incorrectSellingPrices.length > 0;
}

function mapUploadRow(row) {
  const productId = parseIntId(row.item_code);
  const outletId = parseIntId(row.outlet_id);

  if (productId == null || outletId == null) {
    return null;
  }

  return [
    outletId,
    trimStr(row.outlet_name) || null,
    productId,
    trimStr(row.item_name) || null,
    trimStr(row.batch_no) || null,
    parseDecimal(row.purchase_price),
    parseDecimal(row.landing_cost),
    parseDecimal(row.old_mrp),
    parseDecimal(row.new_mrp),
    parseDecimal(row.old_selling_price),
    parseDecimal(row.new_selling_price),
  ];
}

function attachExpectedSellingPrices(products, rulesByItemCode) {
  for (const product of products) {
    const rule = rulesByItemCode.get(product.Item_Code) ?? null;
    product.items = product.items.map((item) =>
      enrichLineItemExpectedSelling(item, rule)
    );
    product.allExpectedSellingPrices = buildExpectedSellingPrices(
      product.items,
      rule
    );
    enrichSellingPriceIssues(product);
    const issueMrps = [
      ...new Set(
        (product.incorrectSellingPrices || [])
          .map((entry) => trimStr(entry.mrp))
          .filter(Boolean)
      ),
    ];
    // Also include Old_MRP from lines in issue groups so expected filter still works for Purchase basis
    if (product.hasIssue) {
      for (const item of product.items || []) {
        const basisType = resolveBasisType(item.mpfd_price_parameter);
        const basisValue = getBasisValue(item, basisType);
        if (basisValue == null) continue;
        const key = `${basisType}|${basisValue}`;
        const group = (product.allSellingPrices || []).find(
          (g) => `${g.basisType}|${g.basisValue}` === key && g.hasIssue
        );
        if (group && trimStr(item.Old_MRP)) {
          issueMrps.push(trimStr(item.Old_MRP));
        }
      }
    }
    product.expectedSellingPrices = buildExpectedSellingPrices(
      product.items,
      rule,
      [...new Set(issueMrps)]
    );
  }
  return products;
}

function attachOfferPrices(products, offersByProductId) {
  for (const product of products) {
    const sellingPrice = offersByProductId.get(product.Item_Code);
    const offerPrice =
      sellingPrice != null && sellingPrice !== "" ? sellingPrice : null;
    product.offerPrice = offerPrice;
    product.items = product.items.map((item) => ({
      ...item,
      offer_price: offerPrice ?? "",
    }));
  }
  return products;
}

function attachHqOfferStatus(products, activeProductIds) {
  const activeSet = new Set(activeProductIds || []);
  for (const product of products) {
    product.hasActiveOffer = activeSet.has(String(product.Item_Code));
  }
  return products;
}

class PriceCheckerUsecase {
  constructor(
    priceCheckerRepo,
    itemMarkupdownRepo,
    productOffersRepo,
    hqOffersRepo
  ) {
    this.priceCheckerRepo = priceCheckerRepo;
    this.itemMarkupdownRepo = itemMarkupdownRepo;
    this.productOffersRepo = productOffersRepo;
    this.hqOffersRepo = hqOffersRepo;
  }

  async listForClient() {
    const [rows, meta] = await Promise.all([
      this.priceCheckerRepo.listItems(),
      this.priceCheckerRepo.getMeta(),
    ]);

    const products = buildProducts(rows || []);
    const itemCodes = products
      .map((product) => parseIntId(product.Item_Code))
      .filter((code) => code != null);

    if (itemCodes.length && this.itemMarkupdownRepo) {
      const rules = await this.itemMarkupdownRepo.listByItemCodes(itemCodes);
      const rulesByItemCode = new Map(
        (rules || []).map((rule) => [String(rule.item_code), rule])
      );
      attachExpectedSellingPrices(products, rulesByItemCode);
    } else {
      attachExpectedSellingPrices(products, new Map());
    }

    if (itemCodes.length && this.productOffersRepo) {
      const offers =
        await this.productOffersRepo.listActiveSellingPricesByProductIds(
          itemCodes
        );
      const offersByProductId = new Map(
        (offers || []).map((offer) => [
          String(offer.product_id),
          offer.selling_price,
        ])
      );
      attachOfferPrices(products, offersByProductId);
    } else {
      attachOfferPrices(products, new Map());
    }

    if (itemCodes.length && this.hqOffersRepo) {
      const activeOfferProductIds =
        await this.hqOffersRepo.listActiveOfferProductIds(itemCodes);
      attachHqOfferStatus(products, activeOfferProductIds);
    } else {
      attachHqOfferStatus(products, []);
    }

    const issueProductCount = products.filter((product) => product.hasIssue).length;

    return {
      code: 200,
      meta: meta
        ? {
            uploaded_at: meta.uploaded_at,
            uploaded_by: meta.uploaded_by,
            total_rows: meta.total_rows,
            issue_product_count: issueProductCount,
            total_product_count: products.length,
          }
        : null,
      data: products,
    };
  }

  async bulkReplace(rows, uploadedBy = null) {
    const insertRows = [];
    let skippedInvalid = 0;

    for (const row of rows) {
      const mapped = mapUploadRow(row);
      if (!mapped) {
        skippedInvalid += 1;
        continue;
      }
      insertRows.push(mapped);
    }

    if (!insertRows.length) {
      return {
        code: 400,
        msg: "No valid rows to import. Item_Code and Outlet_ID must be numeric.",
      };
    }

    const job = priceCheckerJobs.createJob({
      input_rows: rows.length,
      total_rows: insertRows.length,
      skipped_invalid_rows: skippedInvalid,
    });

    setImmediate(() => {
      this.runBulkReplaceJob(
        job.id,
        insertRows,
        uploadedBy,
        skippedInvalid
      ).catch((err) => {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.PRICE_CHECKER",
          code: "USECASE.PRICE_CHECKER.BULK_REPLACE.UNHANDLED",
          description: err.toString(),
          category: "",
          ref: { jobId: job.id },
        });
      });
    });

    return {
      code: 202,
      job_id: job.id,
      message: "Upload started",
    };
  }

  async runBulkReplaceJob(jobId, insertRows, uploadedBy, skippedInvalid) {
    priceCheckerJobs.updateJob(jobId, {
      status: "processing",
      stage: "preparing",
      message: "Preparing upload",
      processed_rows: 0,
    });

    try {
      const result = await this.priceCheckerRepo.replaceAll(
        insertRows,
        {
          uploaded_at: new Date(),
          uploaded_by: uploadedBy,
          total_rows: insertRows.length,
          issue_product_count: 0,
        },
        (progress) => {
          priceCheckerJobs.updateJob(jobId, {
            status: "processing",
            stage: progress.stage,
            message: progress.message,
            processed_rows: progress.processed_rows,
            total_rows: progress.total_rows,
          });
        }
      );

      priceCheckerJobs.updateJob(jobId, {
        status: "completed",
        stage: "done",
        message: "Upload complete",
        processed_rows: insertRows.length,
        total_rows: insertRows.length,
        inserted: result.inserted ?? insertRows.length,
        skipped_invalid_rows: skippedInvalid,
        error: null,
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRICE_CHECKER",
        code: "USECASE.PRICE_CHECKER.BULK_REPLACE",
        description: err.toString(),
        category: "",
        ref: { jobId },
      });

      priceCheckerJobs.updateJob(jobId, {
        status: "failed",
        stage: "failed",
        message: "Upload failed",
        error: err.message || String(err),
      });
    }
  }

  getJobStatus(jobId) {
    return priceCheckerJobs.getJobStatus(jobId);
  }
}

module.exports = (
  priceCheckerRepo,
  itemMarkupdownRepo,
  productOffersRepo,
  hqOffersRepo
) =>
  new PriceCheckerUsecase(
    priceCheckerRepo,
    itemMarkupdownRepo,
    productOffersRepo,
    hqOffersRepo
  );
