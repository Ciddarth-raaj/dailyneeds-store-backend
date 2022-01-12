const logger = require("../utils/logger");

class ProductRepository {
  constructor(db) {
    this.db = db;
  }

  create(product) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO product_table (product_id, variant, variant_of, gf_item_name, gf_description, gf_detailed_description, gf_weight_grams, gf_applies_online, gf_item_product_type, gf_manufacturer, gf_food_type, gf_tax_id, gf_status, de_distributor, brand_id, category_id, subcategory_id, measure, measure_in, packaging_type, cleaning, sticker, grinding, cover_type, cover_sizes, return_prod, de_display_name, department_id, de_name, de_packaging_type, de_preparation_type, de_combo_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          
          ON DUPLICATE KEY UPDATE variant = ?, variant_of = ?, gf_item_name = ?, gf_description = ?, gf_detailed_description = ?, gf_weight_grams = ?, gf_applies_online = ?, gf_item_product_type = ?,
          gf_manufacturer = ?, gf_food_type = ?, gf_tax_id = ?, gf_status = ?, de_distributor = ?, brand_id = ?, category_id = ?, subcategory_id = ?, measure = ?, measure_in = ?, packaging_type = ?,
          cleaning = ?, sticker = ?, grinding = ?, cover_type = ?, cover_sizes = ?, return_prod = ?, de_display_name = ?, department_id = ?, de_name = ?, de_packaging_type = ?, de_preparation_type = ?, de_combo_name = ?`,
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
          product.de_display_name,
          product.department_id,
          product.de_name,
          product.de_packaging_type,
          product.de_preparation_type,
          product.de_combo_name,

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
          product.de_display_name,
          product.department_id,
          product.de_name,
          product.de_packaging_type,
          product.de_preparation_type,
          product.de_combo_name,
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
  getAllProductData() {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT product_id, de_name FROM product_table limit 0,30`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GETALL",
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
  getById(limit, offset, product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT product_table.product_id, categories.category_name, subcategories.subcategory_name, department.department_name, brands.brand_name FROM product_table, categories, subcategories, department, brands
      WHERE categories.category_id = product_table.category_id
      AND subcategories.subcategory_id = product_table.subcategory_id
      AND department.department_id = product_table.department_id
      AND brands.brand_id = product_table.brand_id
      AND product_id = ?
      LIMIT ${offset}, ${limit}`,
        [product_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GETBYID",
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

  get(limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT *, categories.category_name, subcategories.subcategory_name, department.department_name, brands.brand_name FROM product_table, categories, subcategories, department, brands
      WHERE categories.category_id = product_table.category_id
      AND subcategories.subcategory_id = product_table.subcategory_id
      AND department.department_id = product_table.department_id
      AND brands.brand_id = product_table.brand_id
      LIMIT ${offset}, ${limit}`,
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
      this.db.query(`select *, categories.category_name, subcategories.subcategory_name, department.department_name, brands.brand_name from product_table
      LEFT JOIN categories on product_table.category_id = categories.category_id 
      LEFT JOIN subcategories on subcategories.subcategory_id = product_table.subcategory_id
      LEFT JOIN department on department.department_id = product_table.department_id
      LEFT JOIN brands on brands.brand_id = product_table.brand_id
      WHERE product_id = ${product_id} group by product_id`,
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
  getProductByFilter(filter, limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT * FROM product_table, categories, subcategories, department, brands 
      WHERE categories.category_id = product_table.category_id
      AND subcategories.subcategory_id = product_table.subcategory_id
      AND department.department_id = product_table.department_id
      AND brands.brand_id = product_table.brand_id
      AND (gf_item_name LIKE "%${filter}%" OR product_id LIKE "%${filter}%" OR de_distributor LIKE "%${filter}%" OR de_display_name LIKE "%${filter}%" OR de_name LIKE "%${filter}%")
      LIMIT ${offset}, ${limit}`,
        [filter, offset, limit],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-BY-FILTER",
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
  getProductCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(product_id) AS product_count FROM product_table`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-PRODUCT-COUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
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