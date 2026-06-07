const logger = require("../utils/logger");

class ProductDistributorsUsecase {
  constructor(productDistributorsRepo) {
    this.productDistributorsRepo = productDistributorsRepo;
  }

  async getAll() {
    try {
      return await this.productDistributorsRepo.getAll();
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.GET_ALL",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async getByCode(MDM_DIST_CODE) {
    try {
      return await this.productDistributorsRepo.getByCode(MDM_DIST_CODE);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.GET_BY_CODE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async delete(MDM_DIST_CODE) {
    try {
      return await this.productDistributorsRepo.delete(MDM_DIST_CODE);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.DELETE",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async upsertBuyerMap(payload) {
    try {
      return await this.productDistributorsRepo.upsertBuyerMap(
        payload.MDM_DIST_CODE,
        payload.buyer_id
      );
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.UPSERT_BUYER_MAP",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  async bulkUpsertBuyerMap(items) {
    try {
      return await this.productDistributorsRepo.bulkUpsertBuyerMap(items);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.PRODUCT_DISTRIBUTORS",
        code: "USECASE.PRODUCT_DISTRIBUTORS.BULK_UPSERT_BUYER_MAP",
        description: err.toString(),
        category: "",
        ref: {}
      });
      throw err;
    }
  }

  _parseDistCode(value) {
    const code = parseInt(String(value).trim(), 10);
    if (!Number.isFinite(code)) {
      const err = new Error(`Invalid MDM_DIST_CODE: ${value}`);
      err.statusCode = 400;
      throw err;
    }
    return code;
  }

  _parseCid(value) {
    const cid = value == null ? "" : String(value).trim();
    if (!cid) {
      const err = new Error("CID is required");
      err.statusCode = 400;
      throw err;
    }
    return cid;
  }

  _coalesceStr(value) {
    if (value == null) return null;
    const s = String(value).trim();
    return s === "" ? null : s;
  }

  _parseHqImportRow(row) {
    return {
      cid: this._parseCid(row.CID),
      mdm_dist_code: this._parseDistCode(row.MDM_DIST_CODE),
      mdm_dist_name: this._coalesceStr(row.MDM_DIST_NAME),
      mdm_short_name: this._coalesceStr(row.MDM_SHORT_NAME),
      mdm_tag: this._coalesceStr(row.MDM_TAG),
    };
  }

  /** Merge rows sharing a CID into one; later non-empty values fill gaps. */
  _mergeHqRow(existing, incoming) {
    return {
      cid: existing.cid,
      mdm_dist_code: incoming.mdm_dist_code,
      mdm_dist_name: incoming.mdm_dist_name ?? existing.mdm_dist_name,
      mdm_short_name: incoming.mdm_short_name ?? existing.mdm_short_name,
      mdm_tag: incoming.mdm_tag ?? existing.mdm_tag,
    };
  }

  _mergeByCid(items) {
    const byCid = new Map();
    items.forEach((row) => {
      const parsed = this._parseHqImportRow(row);
      const existing = byCid.get(parsed.cid);
      byCid.set(
        parsed.cid,
        existing ? this._mergeHqRow(existing, parsed) : parsed
      );
    });
    return Array.from(byCid.values());
  }

  async bulkHqImport(items) {
    try {
      const merged = this._mergeByCid(items);
      const result = await this.productDistributorsRepo.bulkHqImport(merged);
      return { ...result, inputCount: items.length, mergedCount: merged.length };
    } catch (err) {
      if (!err.statusCode) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.PRODUCT_DISTRIBUTORS",
          code: "USECASE.PRODUCT_DISTRIBUTORS.BULK_HQ_IMPORT",
          description: err.toString(),
          category: "",
          ref: {},
        });
      }
      throw err;
    }
  }
}

module.exports = (productDistributorsRepo) => {
  return new ProductDistributorsUsecase(productDistributorsRepo);
};
