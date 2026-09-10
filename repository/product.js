const logger = require("../utils/logger");

class ProductRepository {
  constructor(db) {
    this.db = db;
  }

  // gf_* columns are deprecated for application use; still written for GoFrugal sync / API compatibility.
  create(product) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO product_table (product_id, variant, variant_of, gf_item_name, gf_description, gf_detailed_description, gf_weight_grams, gf_applies_online, gf_item_product_type, gf_manufacturer, gf_food_type, gf_tax_id, gf_status, de_distributor, brand_id, category_id, subcategory_id, measure, measure_in, packaging_type, cleaning, sticker, grinding, cover_type, cover_sizes, return_prod, de_display_name, department_id, de_name, de_packaging_type, de_preparation_type, de_combo_name, purchase_uom, store_uom, repln_mode, de_is_online_allowed, buyer_name, distributor_id, de_manufacturer_name, de_bill_count_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          
          ON DUPLICATE KEY UPDATE variant = ?, variant_of = ?, gf_item_name = ?, gf_description = ?, gf_detailed_description = ?, gf_weight_grams = ?, gf_applies_online = ?, gf_item_product_type = ?,
          gf_manufacturer = ?, gf_food_type = ?, gf_tax_id = ?, gf_status = ?, de_distributor = ?, brand_id = ?, category_id = ?, subcategory_id = ?, measure = ?, measure_in = ?, packaging_type = ?,
          cleaning = ?, sticker = ?, grinding = ?, cover_type = ?, cover_sizes = ?, return_prod = ?, de_display_name = ?, department_id = ?, de_name = ?, de_packaging_type = ?, de_preparation_type = ?, de_combo_name = ?, purchase_uom = ?, store_uom = ?, repln_mode = ?, de_is_online_allowed = ?, buyer_name = ?, distributor_id = ?, de_manufacturer_name = ?, de_bill_count_level = ?`,
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
          product.purchase_uom ?? null,
          product.store_uom ?? null,
          product.repln_mode ?? null,
          product.de_is_online_allowed ?? null,
          product.buyer_name ?? null,
          product.distributor_id ?? null,
          product.de_manufacturer_name ?? null,
          product.de_bill_count_level ?? null,

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
          product.purchase_uom ?? null,
          product.store_uom ?? null,
          product.repln_mode ?? null,
          product.de_is_online_allowed ?? null,
          product.buyer_name ?? null,
          product.distributor_id ?? null,
          product.de_manufacturer_name ?? null,
          product.de_bill_count_level ?? null,
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
      this.db.query(
        `SELECT 
          product_table.product_id, 
          product_table.de_name,
          COALESCE(pi.has_images, 0) as has_images,
          product_table.de_preparation_type,
          product_table.purchase_uom,
          product_table.store_uom,
          product_table.repln_mode,
          (
            SELECT image_url
            FROM product_images
            WHERE product_id = product_table.product_id
            ORDER BY priority ASC, image_id ASC
            LIMIT 1
          ) as image_url
        FROM product_table 
        LEFT JOIN (
          SELECT product_id, 1 as has_images
          FROM product_images
          GROUP BY product_id
        ) as pi ON pi.product_id = product_table.product_id
        LIMIT 0, 30`,
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
          // Convert has_images to boolean and include first image link
          const formatted = docs.map((doc) => ({
            product_id: doc.product_id,
            de_name: doc.de_name,
            has_images:
              doc.has_images === 1 ||
              doc.has_images === "1" ||
              doc.has_images === true,
            image_url: doc.image_url || null,
            purchase_uom: doc.purchase_uom,
            store_uom: doc.store_uom,
            repln_mode: doc.repln_mode,
          }));
          resolve(formatted);
        }
      );
    });
  }
  getById(limit, offset, product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT product_table.product_id, categories.category_name, subcategories.subcategory_name, department.department_name, brands.brand_name FROM product_table, categories, subcategories, department, brands
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
        }
      );
    });
  }

  get(limit, offset, fetchAll = false) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT
            p.product_id,
            p.de_name,
            p.de_display_name,
            p.gf_item_name,
            p.de_distributor,
            p.distributor_id,
            p.de_manufacturer_name,
            COALESCE(pdm.mdm_dist_name, p.de_distributor) AS distributor_name,
            p.category_id,
            cat.category_name,
            p.subcategory_id,
            sub.subcategory_name,
            p.department_id,
            p.brand_id,
            p.de_preparation_type,
            p.purchase_uom,
            p.store_uom,
            p.repln_mode,
            EXISTS (
                SELECT 1
                FROM product_images pi
                WHERE pi.product_id = p.product_id
                LIMIT 1
            ) AS has_images,
            (
                SELECT image_url
                FROM product_images
                WHERE product_id = p.product_id
                ORDER BY priority ASC, image_id ASC
                LIMIT 1
            ) AS image_url
        FROM product_table p
        LEFT JOIN product_distributor_master pdm ON pdm.cid = p.distributor_id
        LEFT JOIN categories cat ON p.category_id = cat.category_id
        LEFT JOIN subcategories sub ON p.subcategory_id = sub.category_id
        ORDER BY p.product_id DESC
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
          // Convert has_images to boolean and include first image link
          const formatted = docs.map((doc) => {
            const product = { ...doc };
            product.has_images =
              doc.has_images === 1 ||
              doc.has_images === "1" ||
              doc.has_images === true;
            product.image_url = doc.image_url || null;
            return product;
          });
          resolve(formatted);
        }
      );
    });
  }

  getProductById(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT product_table.*, categories.category_name, subcategories.subcategory_name, department.department_name, brands.brand_name,
              COALESCE(pdm.mdm_dist_name, product_table.de_distributor) AS distributor_name
      FROM product_table
      LEFT JOIN categories ON product_table.category_id = categories.category_id
      LEFT JOIN subcategories ON subcategories.subcategory_id = product_table.subcategory_id
      LEFT JOIN department ON department.department_id = product_table.department_id
      LEFT JOIN brands ON brands.brand_id = product_table.brand_id
      LEFT JOIN product_distributor_master pdm ON pdm.cid = product_table.distributor_id
      WHERE product_table.product_id = ?`,
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
        }
      );
    });
  }
  getProductByFilter(filter, limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT DISTINCT 
          product_table.product_id, 
          product_table.*, 
          categories.*, 
          subcategories.*, 
          department.*, 
          brands.*,
          COALESCE(pdm.mdm_dist_name, product_table.de_distributor) AS distributor_name,
          COALESCE(pi.has_images, 0) as has_images
        FROM product_table
        JOIN categories ON categories.category_id = product_table.category_id
        JOIN subcategories ON subcategories.subcategory_id = product_table.subcategory_id
        JOIN product_department as department ON department.department_id = product_table.department_id
        JOIN brands ON brands.brand_id = product_table.brand_id
        LEFT JOIN product_distributor_master pdm ON pdm.cid = product_table.distributor_id
        LEFT JOIN (
          SELECT product_id, 1 as has_images
          FROM product_images
          GROUP BY product_id
        ) as pi ON pi.product_id = product_table.product_id
        WHERE (product_table.product_id LIKE "%${filter}%" OR de_distributor LIKE "%${filter}%" OR de_display_name LIKE "%${filter}%" OR de_name LIKE "%${filter}%")
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
          // Convert has_images to boolean
          const formatted = docs.map((doc) => {
            const product = { ...doc };
            product.has_images =
              doc.has_images === 1 ||
              doc.has_images === "1" ||
              doc.has_images === true;
            return product;
          });
          resolve(formatted);
        }
      );
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

  createProductImages(product_id, images) {
    return new Promise((resolve, reject) => {
      if (!images || images.length === 0) {
        resolve({ code: 200 });
        return;
      }

      const values = images.map((img) => [
        product_id,
        img.image_url,
        img.priority || 0,
      ]);
      const query = `INSERT INTO product_images (product_id, image_url, priority) VALUES ?`;

      this.db.query(query, [values], (err, res) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PRODUCT",
            code: "REPOSITORY.PRODUCT.CREATE-IMAGES",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({ code: 200 });
      });
    });
  }

  deleteProductImages(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM product_images WHERE product_id = ?`,
        [product_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.DELETE-IMAGES",
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

  getProductImages(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT image_id, product_id, image_url, priority, created_at, updated_at 
         FROM product_images 
         WHERE product_id = ? 
         ORDER BY priority ASC, image_id ASC`,
        [product_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-IMAGES",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs || []);
        }
      );
    });
  }

  getProductImagesBatch(product_ids) {
    return new Promise((resolve, reject) => {
      if (!product_ids || product_ids.length === 0) {
        resolve({});
        return;
      }

      const placeholders = product_ids.map(() => "?").join(",");
      this.db.query(
        `SELECT image_id, product_id, image_url, priority, created_at, updated_at 
         FROM product_images 
         WHERE product_id IN (${placeholders})
         ORDER BY product_id, priority ASC, image_id ASC`,
        product_ids,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PRODUCT",
              code: "REPOSITORY.PRODUCT.GET-IMAGES-BATCH",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }

          // Group images by product_id
          const imagesByProduct = {};
          if (docs && docs.length > 0) {
            docs.forEach((img) => {
              if (!imagesByProduct[img.product_id]) {
                imagesByProduct[img.product_id] = [];
              }
              imagesByProduct[img.product_id].push(img);
            });
          }
          resolve(imagesByProduct);
        }
      );
    });
  }
}

module.exports = (db) => {
  return new ProductRepository(db);
};
