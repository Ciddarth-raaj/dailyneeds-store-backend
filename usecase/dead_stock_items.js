const logger = require("../utils/logger");

const TYPE_TO_RESPONSE_KEY = {
  "thirty-days": "thirty_days",
  "ninety-days": "ninety_days",
  "one-twenty-days": "one_twenty_days",
  "more-than-one-twenty-days": "more_thanone_twenty_days",
};

const EMPTY_BUCKET = () => ({ stock: 0, stock_value: 0 });

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
    const rows = await this.deadStockItemsRepo.listAggregatedByProductOutletType();
    const byKey = new Map();

    for (const row of rows) {
      const key = `${row.product_id}|${row.outlet_id}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          product_id: row.product_id,
          outlet_id: row.outlet_id,
          outlet_name: row.outlet_name,
          thirty_days: EMPTY_BUCKET(),
          ninety_days: EMPTY_BUCKET(),
          one_twenty_days: EMPTY_BUCKET(),
          more_thanone_twenty_days: EMPTY_BUCKET(),
        });
      }
      const entry = byKey.get(key);
      if (row.outlet_name != null && entry.outlet_name == null) {
        entry.outlet_name = row.outlet_name;
      }
      const respKey = TYPE_TO_RESPONSE_KEY[row.type];
      if (!respKey) {
        continue;
      }
      const st = Number(row.stock);
      const sv = Number(row.stock_value);
      const bucket = entry[respKey];
      bucket.stock += Number.isFinite(st) ? st : 0;
      bucket.stock_value += Number.isFinite(sv) ? sv : 0;
    }

    return { code: 200, data: [...byKey.values()] };
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
      const check = await this.deadStockItemsRepo.validateProductIdsAndOutletIds(
        [...productIds],
        [...outletIds]
      );
      if (check.code !== 200) {
        return check;
      }
      return await this.deadStockItemsRepo.truncateAndBulkInsert(insertRows);
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
