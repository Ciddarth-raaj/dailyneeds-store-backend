const logger = require("../utils/logger");
const priceCheckerJobs = require("../services/price_checker_jobs");
const {
  buildExpectedSellingPrices,
  enrichLineItemExpectedSelling,
} = require("../utils/expectedSellingPrice");

function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function parseDecimal(v) {
  const s = trimStr(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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

function buildIncorrectSellingPrices(rows) {
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
        incorrectSellingPrices: [],
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

  const issues = [];

  Object.values(groupedByItem).forEach((itemData) => {
    const mrpGroups = itemData.items.reduce((acc, item) => {
      const mrp = trimStr(item.Old_MRP);
      if (!acc[mrp]) acc[mrp] = [];
      acc[mrp].push(item);
      return acc;
    }, {});

    let hasIssue = false;

    Object.keys(mrpGroups).forEach((mrp) => {
      const sellingPricesForMrp = mrpGroups[mrp]
        .map((item) => trimStr(item.Old_Selling_Price))
        .filter((price) => price !== "");

      const uniqueSellingPrices = [...new Set(sellingPricesForMrp)];

      if (uniqueSellingPrices.length > 1) {
        hasIssue = true;
        itemData.incorrectSellingPrices.push({
          mrp,
          sellingPrices: uniqueSellingPrices,
        });
      }
    });

    if (hasIssue) {
      issues.push(itemData);
    }
  });

  return issues;
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
    const issueMrps = (product.incorrectSellingPrices || []).map(
      (entry) => entry.mrp
    );
    product.expectedSellingPrices = buildExpectedSellingPrices(
      product.items,
      rule,
      issueMrps
    );
    product.items = product.items.map((item) =>
      enrichLineItemExpectedSelling(item, rule)
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

class PriceCheckerUsecase {
  constructor(priceCheckerRepo, itemMarkupdownRepo, productOffersRepo) {
    this.priceCheckerRepo = priceCheckerRepo;
    this.itemMarkupdownRepo = itemMarkupdownRepo;
    this.productOffersRepo = productOffersRepo;
  }

  async listForClient() {
    const [rows, meta] = await Promise.all([
      this.priceCheckerRepo.listItems(),
      this.priceCheckerRepo.getMeta(),
    ]);

    const products = buildIncorrectSellingPrices(rows || []);
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

    return {
      code: 200,
      meta: meta
        ? {
            uploaded_at: meta.uploaded_at,
            uploaded_by: meta.uploaded_by,
            total_rows: meta.total_rows,
            issue_product_count: products.length,
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

module.exports = (priceCheckerRepo, itemMarkupdownRepo, productOffersRepo) =>
  new PriceCheckerUsecase(
    priceCheckerRepo,
    itemMarkupdownRepo,
    productOffersRepo
  );
