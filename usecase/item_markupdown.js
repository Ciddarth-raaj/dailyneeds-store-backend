const logger = require("../utils/logger");

function toOptionalString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function mapImportRow(row) {
  const itemCode = parseInt(String(row.MPFD_ITEM_CODE).trim(), 10);
  if (!Number.isFinite(itemCode) || itemCode <= 0) {
    return null;
  }

  return {
    item_code: itemCode,
    mpfd_class_type: toOptionalString(row.MPFD_CLASS_TYPE),
    mpfd_id: toOptionalString(row.MPFD_ID),
    mpfd_markup_down: toOptionalString(row.MPFD_MARKUP_DOWN),
    mpfd_price_parameter: toOptionalString(row.MPFD_PRICE_PARAMETER),
    mpfd_value: toOptionalString(row.MPFD_VALUE),
    mpfd_amt_perc: toOptionalString(row.MPFD_AMT_PERC),
    mpfd_roundoff_type: toOptionalString(row.MPFD_ROUNDOFF_TYPE),
    mpfd_roundoff_value: toOptionalString(row.MPFD_ROUNDOFF_VALUE),
    mpfd_status: toOptionalString(row.MPFD_STATUS),
    mpfd_mrp_price_param: toOptionalString(row.MPFD_MRP_PRICE_PARAM),
    mpfd_mrp_value: toOptionalString(row.MPFD_MRP_VALUE),
    mpfd_mrp_amt_perc: toOptionalString(row.MPFD_MRP_AMT_PERC),
  };
}

class ItemMarkupdownUsecase {
  constructor(itemMarkupdownRepo) {
    this.itemMarkupdownRepo = itemMarkupdownRepo;
  }

  /**
   * @param {Array<object>} rows
   */
  async bulkReplace(rows) {
    const byItemCode = new Map();
    let skippedInvalid = 0;

    for (const row of rows) {
      const mapped = mapImportRow(row);
      if (!mapped) {
        skippedInvalid += 1;
        continue;
      }
      byItemCode.set(mapped.item_code, mapped);
    }

    const insertRows = [...byItemCode.values()];
    if (!insertRows.length) {
      return {
        code: 400,
        msg: "No valid rows to import. MPFD_ITEM_CODE must be a numeric product id.",
      };
    }

    try {
      const itemCodes = insertRows.map((r) => r.item_code);
      const validItemCodes = await this.itemMarkupdownRepo.resolveValidItemCodes(
        itemCodes
      );

      const rowsToInsert = insertRows.filter((r) =>
        validItemCodes.has(r.item_code)
      );
      const skippedUnknownProducts = itemCodes.filter(
        (id) => !validItemCodes.has(id)
      );

      const result = await this.itemMarkupdownRepo.truncateAndBulkInsert(
        rowsToInsert
      );

      if (skippedInvalid) {
        result.skipped_invalid_rows = skippedInvalid;
      }
      if (skippedUnknownProducts.length) {
        result.skipped_unknown_products = skippedUnknownProducts.sort(
          (a, b) => a - b
        );
      }
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.ITEM_MARKUPDOWN",
        code: "USECASE.ITEM_MARKUPDOWN.BULK_REPLACE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }
}

module.exports = (itemMarkupdownRepo) => {
  return new ItemMarkupdownUsecase(itemMarkupdownRepo);
};
