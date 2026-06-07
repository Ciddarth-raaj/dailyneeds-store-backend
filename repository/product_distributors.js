const logger = require("../utils/logger");

const GF_TABLE = "medishopdb_MED_DISTRIBUTOR_MAST";
const MAP_TABLE = "product_distributor";
const MASTER_TABLE = "product_distributor_master";

class ProductDistributorsRepository {
  constructor(gofrugalDb, mainDb) {
    this.gofrugalDb = gofrugalDb;
    this.mainDb = mainDb;
  }

  /**
   * Merge Gofrugal distributor rows with buyer mapping from main DB (product_distributor + new_employee).
   */
  getAll() {
    return new Promise((resolve, reject) => {
      this.gofrugalDb.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME, MDM_SHORT_NAME FROM ${GF_TABLE} WHERE MDM_TAG = 'a' ORDER BY MDM_DIST_NAME`,
        (err, dists) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
              code: "REPOSITORY.PRODUCT_DISTRIBUTORS.GET_ALL",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          this.mainDb.query(
            `SELECT pd.mdm_dist_code, pd.buyer_id, ne.employee_name AS buyer_name
             FROM ${MAP_TABLE} pd
             LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id`,
            (err2, buyerRows) => {
              if (err2) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.PRODUCT_DISTRIBUTORS",
                  code: "REPOSITORY.PRODUCT_DISTRIBUTORS.GET_ALL_MAP",
                  description: err2.toString(),
                  category: "",
                  ref: {}
                });
                return reject(err2);
              }
              const byCode = {};
              (buyerRows || []).forEach((b) => {
                byCode[String(b.mdm_dist_code)] = b;
              });
              const data = (dists || []).map((d) => {
                const code = String(d.MDM_DIST_CODE);
                const m = byCode[code];
                return {
                  MDM_DIST_CODE: d.MDM_DIST_CODE,
                  MDM_DIST_NAME: d.MDM_DIST_NAME,
                  MDM_SHORT_NAME: d.MDM_SHORT_NAME,
                  buyer_id: m ? m.buyer_id : null,
                  buyer_name: m ? m.buyer_name : null
                };
              });
              resolve(data);
            }
          );
        }
      );
    });
  }

  getByCode(MDM_DIST_CODE) {
    return new Promise((resolve, reject) => {
      const code = String(MDM_DIST_CODE);
      this.gofrugalDb.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME, MDM_SHORT_NAME FROM ${GF_TABLE} WHERE MDM_DIST_CODE = ?`,
        [code],
        (err, rows) => {
          if (err) return reject(err);
          const dist = rows && rows[0] ? rows[0] : null;
          if (!dist) return resolve(null);

          this.mainDb.query(
            `SELECT pd.buyer_id, ne.employee_name AS buyer_name
             FROM ${MAP_TABLE} pd
             LEFT JOIN new_employee ne ON ne.employee_id = pd.buyer_id
             WHERE pd.mdm_dist_code = ?`,
            [code],
            (err2, mapRows) => {
              if (err2) return reject(err2);
              const m = mapRows && mapRows[0] ? mapRows[0] : null;
              resolve({
                MDM_DIST_CODE: dist.MDM_DIST_CODE,
                MDM_DIST_NAME: dist.MDM_DIST_NAME,
                MDM_SHORT_NAME: dist.MDM_SHORT_NAME,
                buyer_id: m ? m.buyer_id : null,
                buyer_name: m ? m.buyer_name : null
              });
            }
          );
        }
      );
    });
  }

  /**
   * Insert or update buyer mapping for a distributor code (main DB).
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
              ref: {}
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
              ref: {}
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
              ref: {}
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
                  ref: {}
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
