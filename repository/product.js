const logger = require("../utils/logger");

class ProductRepository {
  constructor(db) {
    this.db = db;
  }

  create(product) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO product_table (product_id, variant, variant_of, gf_item_name, gf_description, gf_detailed_description, gf_weight_grams, gf_applies_online, gf_item_product_type, gf_manufacturer, gf_food_type, gf_tax_id, gf_status, de_distributor, brand_id, category_id, subcategory_id, measure, measure_in, packaging_type, cleaning, sticker, grinding, cover_type, cover_sizes, return_prod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          
          ON DUPLICATE KEY UPDATE variant = ?, variant_of = ?, gf_item_name = ?, gf_description = ?, gf_detailed_description = ?, gf_weight_grams = ?, gf_applies_online = ?, gf_item_product_type = ?,
          gf_manufacturer = ?, gf_food_type = ?, gf_tax_id = ?, gf_status = ?, de_distributor = ?, brand_id = ?, category_id = ?, subcategory_id = ?, measure = ?, measure_in = ?, packaging_type = ?,
          cleaning = ?, sticker = ?, grinding = ?, cover_type = ?, cover_sizes = ?, return_prod = ?`,
        [
          product.product_id,
          product.variant,
          product.variant_of,
          product.gf_item_name,
          product.gf_description,
          product.gf_detailed_description,
          product.gf_weight_grams,
          product.gf_applies_online,
          product.gf_item_product_type,
          product.gf_manufacturer,
          product.gf_food_type,
          product.gf_tax_id,
          product.gf_status,
          product.de_distributor,
          product.brand_id,
          product.category_id,
          product.subcategory_id,
          product.measure,
          product.measure_in,
          product.packaging_type,
          product.cleaning,
          product.sticker,
          product.grinding,
          product.cover_type,
          product.cover_sizes,
          product.return,

          product.variant,
          product.variant_of,
          product.gf_item_name,
          product.gf_description,
          product.gf_detailed_description,
          product.gf_weight_grams,
          product.gf_applies_online,
          product.gf_item_product_type,
          product.gf_manufacturer,
          product.gf_food_type,
          product.gf_tax_id,
          product.gf_status,
          product.de_distributor,
          product.brand_id,
          product.category_id,
          product.subcategory_id,
          product.measure,
          product.measure_in,
          product.packaging_type,
          product.cleaning,
          product.sticker,
          product.grinding,
          product.cover_type,
          product.cover_sizes,
          product.return,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM product_table",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
    });
  }

  getProductById(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM product_table WHERE product_id = ?",
        [product_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
    });
  }
  updateProductDetails(data, product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE product_table SET ? WHERE product_id = ?`,
        [data, product_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.UPDATE-PRODUCT-DETAILS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ProductRepository(db);
};