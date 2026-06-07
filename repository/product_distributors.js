const logger = require("../utils/logger");
const {
  GF_TABLE,
  resolveByMedishopDistCodes,
  getActiveWithMedishopCodes,
} = require("./lib/distributor_master_lookup");

const MAP_TABLE = "product_distributor";
const MASTER_TABLE = "product_distributor_master";

class ProductDistributorsRepository {
  constructor(gofrugalDb, mainDb) {
    this.gofrugalDb = gofrugalDb;
    this.mainDb = mainDb;
  }

  _getBuyerMapByDistCodes(distCodes) {
    return new Promise((resolve, reject) => {
      const codes = [
        ...new Set(
          (distCodes || [])
            .map((c) => (c != null && c !== "" ? String(c) : null))
            .filter(Boolean)
        ),
      ];
      if (codes.length === 0) return resolve({});

      const placeholders = codes.map(() => "?").join(",");
      this.mainDb.query(
        `SELECT pd.mdm_dist_code, pd.buyer_id, ne.employee_name AS buyer_name
         FROM ${MAP_TABLE} pd
         LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id
         WHERE pd.mdm_dist_code IN (${placeholders})`,
        codes,
        (err, buyerRows) => {
          if (err) return reject(err);
          const byCode = {};
          (buyerRows || []).forEach((b) => {
            byCode[String(b.mdm_dist_code)] = b;
          });
          resolve(byCode);
        }
      );
    });
  }

  _attachBuyer(rows, buyerByCode) {
    return rows.map((row) => {
      const code = String(row.MDM_DIST_CODE);
      const buyer = buyerByCode[code];
      return {
        ...row,
        buyer_id: buyer ? buyer.buyer_id : null,
        buyer_name: buyer ? buyer.buyer_name : null,
      };
    });
  }

  /**
   * Active distributors: master details via cid, medishop MDM_DIST_CODE for external keys.
   */
  getAll() {
    return new Promise((resolve, reject) => {
      getActiveWithMedishopCodes(this.gofrugalDb, this.mainDb)
        .then((rows) => {
          const codes = rows.map((r) => String(r.MDM_DIST_CODE));
          return this._getBuyerMapByDistCodes(codes).then((buyerByCode) =>
            this._attachBuyer(rows, buyerByCode)
          );
        })
        .then(resolve)
        .catch((err) => {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
            code: "REPOSITORY.PRODUCT_DISTRIBUTORS.GET_ALL",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
        });
    });
  }

  getByCode(MDM_DIST_CODE) {
    return new Promise((resolve, reject) => {
      const code = String(MDM_DIST_CODE);
      resolveByMedishopDistCodes(this.gofrugalDb, this.mainDb, [code])
        .then((map) => {
          const dist = map[code];
          if (!dist) return resolve(null);
          return this._getBuyerMapByDistCodes([code]).then((buyerByCode) => {
            const buyer = buyerByCode[code];
            resolve({
              MDM_DIST_CODE: dist.MDM_DIST_CODE,
              CID: dist.CID,
              MDM_DIST_NAME: dist.MDM_DIST_NAME,
              MDM_SHORT_NAME: dist.MDM_SHORT_NAME,
              buyer_id: buyer ? buyer.buyer_id : null,
              buyer_name: buyer ? buyer.buyer_name : null,
            });
          });
        })
        .catch(reject);
    });
  }

  /**
   * Insert or update buyer mapping for a distributor code (main DB).
   * mdm_dist_code is the medishop MDM_DIST_CODE.
   */
  upsertBuyerMap(MDM_DIST_CODE, buyer_id) {
    return new Promise((resolve, reject) => {
      const code = String(MDM_DIST_CODE);
      const bid = buyer_id == null ? null : buyer_id;
      this.mainDb.query(
        `INSERT INTO ${MAP_TABLE} (mdm_dist_code, buyer_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE buyer_id = VALUES(buyer_id), updated_at = CURRENT_TIMESTAMP`,
        [code, bid],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.UPSERT_BUYER_MAP",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, MDM_DIST_CODE: code, buyer_id: bid });
        }
      );
    });
  }

  /**
   * Bulk insert/update buyer mappings. Later entries win if MDM_DIST_CODE repeats.
   */
  bulkUpsertBuyerMap(items) {
    return new Promise((resolve, reject) => {
      if (!items || items.length === 0) {
        return resolve({ code: 200, count: 0 });
      }

      const byCode = new Map();
      items.forEach((row) => {
        const code = String(row.MDM_DIST_CODE);
        const bid = row.buyer_id == null ? null : row.buyer_id;
        byCode.set(code, bid);
      });
      const pairs = Array.from(byCode.entries());
      const placeholders = pairs.map(() => "(?, ?)").join(", ");
      const values = pairs.flatMap(([code, bid]) => [code, bid]);

      this.mainDb.query(
        `INSERT INTO ${MAP_TABLE} (mdm_dist_code, buyer_id) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE buyer_id = VALUES(buyer_id), updated_at = CURRENT_TIMESTAMP`,
        values,
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.BULK_UPSERT_BUYER_MAP",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, count: pairs.length });
        }
      );
    });
  }

  /**
   * Bulk insert/update HQ distributor master rows (main DB).
   * Expects one row per cid (merged upstream).
   */
  bulkHqImport(items) {
    return new Promise((resolve, reject) => {
      if (!items || items.length === 0) {
        return resolve({ code: 200, count: 0 });
      }

      const rows = items;
      const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const values = rows.flatMap((row) => [
        row.cid,
        row.mdm_dist_code,
        row.mdm_dist_name ?? null,
        row.mdm_short_name ?? null,
        row.mdm_tag ?? null,
      ]);

      this.mainDb.query(
        `INSERT INTO ${MASTER_TABLE}
          (cid, mdm_dist_code, mdm_dist_name, mdm_short_name, mdm_tag)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
          mdm_dist_code = VALUES(mdm_dist_code),
          mdm_dist_name = VALUES(mdm_dist_name),
          mdm_short_name = VALUES(mdm_short_name),
          mdm_tag = VALUES(mdm_tag),
          updated_at = CURRENT_TIMESTAMP`,
        values,
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.BULK_HQ_IMPORT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200, count: rows.length });
        }
      );
    });
  }

  delete(MDM_DIST_CODE) {
    return new Promise((resolve, reject) => {
      const code = String(MDM_DIST_CODE);
      this.mainDb.query(
        `DELETE FROM ${MAP_TABLE} WHERE mdm_dist_code = ?`,
        [code],
        (mapErr) => {
          if (mapErr) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.DELETE_MAP",
              description: mapErr.toString(),
              category: "",
              ref: {},
            });
            return reject(mapErr);
          }
          this.gofrugalDb.query(
            `DELETE FROM ${GF_TABLE} WHERE MDM_DIST_CODE = ?`,
            [code],
            (err, res) => {
              if (err) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
                  code: "REPOSITORY.PRODUCT_DISTRIBUTORS.DELETE",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
                return reject(err);
              }
              resolve({ code: 200, affectedRows: res.affectedRows });
            }
          );
        }
      );
    });
  }
}

module.exports = (gofrugalDb, mainDb) => {
  return new ProductDistributorsRepository(gofrugalDb, mainDb);
};
