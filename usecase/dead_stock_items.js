const logger = require("../utils/logger");

function toNum(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapPivotedRow(row) {
  return {
    product_id: row.product_id,
    outlet_id: row.outlet_id,
    outlet_name: row.outlet_name ?? null,
    de_name: row.de_name ?? null,
    de_distributor: row.de_distributor ?? null,
    buyer_name: row.buyer_name ?? null,
    department_id: row.department_id ?? null,
    department_name: row.department_name ?? null,
    thirty_days: {
      stock: toNum(row.thirty_days_stock),
      stock_value: toNum(row.thirty_days_stock_value),
    },
    ninety_days: {
      stock: toNum(row.ninety_days_stock),
      stock_value: toNum(row.ninety_days_stock_value),
    },
    one_twenty_days: {
      stock: toNum(row.one_twenty_days_stock),
      stock_value: toNum(row.one_twenty_days_stock_value),
    },
    more_thanone_twenty_days: {
      stock: toNum(row.more_thanone_twenty_days_stock),
      stock_value: toNum(row.more_thanone_twenty_days_stock_value),
    },
  };
}

function msaNameToDbType(msaName) {
  const n = String(msaName).trim().toLowerCase();
  if (n === "30 days") return "thirty-days";
  if (n === "90 days") return "ninety-days";
  if (n === "120 days") return "one-twenty-days";
  if (n === "more than 120 days") return "more-than-one-twenty-days";
  return null;
}

class DeadStockItemsUsecase {
  constructor(deadStockItemsRepo) {
    this.deadStockItemsRepo = deadStockItemsRepo;
  }

  async listForClient() {
    const rows = await this.deadStockItemsRepo.listPivotedForClient();
    const data = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      data[i] = mapPivotedRow(rows[i]);
    }
    return { code: 200, data };
  }

  /**
   * @param {Array<{ mid_item_code: string|number, stock: number, stock_value: number, msa_name: string, retail_outlet_id: number }>} rows
   */
  async bulkReplace(rows) {
    const agg = new Map();
    const productIds = new Set();
    const outletIds = new Set();

    for (const r of rows) {
      const pid = parseInt(String(r.mid_item_code).trim(), 10);
      if (!Number.isFinite(pid)) {
        return { code: 400, msg: "Invalid MID_ITEM_CODE: must be numeric product id" };
      }
      const outletId = Number(r.retail_outlet_id);
      if (!Number.isFinite(outletId) || outletId <= 0) {
        return { code: 400, msg: "Invalid RETAIL_OUTLET_ID" };
      }
      const dbType = msaNameToDbType(r.msa_name);
      if (!dbType) {
        return {
          code: 400,
          msg: `Invalid MSA_NAME: ${r.msa_name} (expected 30 Days, 90 Days, 120 Days, More than 120 Days)`,
        };
      }
      const stock = Number(r.stock);
      const stockValue = Number(r.stock_value);
      if (!Number.isFinite(stock) || !Number.isFinite(stockValue)) {
        return { code: 400, msg: "STOCK and STOCK_VALUE must be numbers" };
      }

      productIds.add(pid);
      outletIds.add(outletId);
      const k = `${pid}|${outletId}|${dbType}`;
      const prev = agg.get(k) || { stock: 0, stock_value: 0 };
      prev.stock += stock;
      prev.stock_value += stockValue;
      agg.set(k, prev);
    }

    const insertRows = [];
    for (const [k, sums] of agg.entries()) {
      const [ps, os, t] = k.split("|");
      insertRows.push({
        product_id: parseInt(ps, 10),
        outlet_id: parseInt(os, 10),
        type: t,
        stock: sums.stock,
        stock_value: sums.stock_value,
      });
    }

    try {
      const { validProductIds, validOutletIds } =
        await this.deadStockItemsRepo.resolveValidProductAndOutletIds(
          [...productIds],
          [...outletIds]
        );

      const rowsToInsert = insertRows.filter(
        (r) => validProductIds.has(r.product_id) && validOutletIds.has(r.outlet_id)
      );

      const skippedUnknownProducts = [...productIds].filter((id) => !validProductIds.has(id));
      const skippedUnknownOutlets = [...outletIds].filter((id) => !validOutletIds.has(id));

      const result = await this.deadStockItemsRepo.truncateAndBulkInsert(rowsToInsert);
      if (skippedUnknownProducts.length) {
        result.skipped_unknown_products = skippedUnknownProducts.sort((a, b) => a - b);
      }
      if (skippedUnknownOutlets.length) {
        result.skipped_unknown_outlets = skippedUnknownOutlets.sort((a, b) => a - b);
      }
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.DEAD_STOCK_ITEMS",
        code: "USECASE.DEAD_STOCK_ITEMS.BULK_REPLACE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (deadStockItemsRepo) => {
  return new DeadStockItemsUsecase(deadStockItemsRepo);
};
