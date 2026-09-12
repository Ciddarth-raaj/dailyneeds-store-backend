const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const moment = require("moment");

const logger = require("../utils/logger");
const deliumConfig = require("../config/delium");
// const GOFRUGAL_API_KEY =
//   "92389031420AEF2B22174FA933F178040AFD9395A5E9C3F013A74C4CA152CE786116998975B7AF31";

const CRON_SYNTAX_PRODUCT = "0 4 * * *";
const CRON_SYNTAX_STOCK_HOLDING = "30 7 * * *";
const CRON_SYNTAX_CLEANING_PACKING = "0 9 * * *";

class Synker {
  constructor(
    productUsecase,
    categoryUsecase,
    subcategoryUsecase,
    departmentUsecase,
    brandUsecase,
    cleaningPackingUsecase,
    productRepo,
    stockHoldingReportUsecase
  ) {
    this.productUsecase = productUsecase;
    this.categoryUsecase = categoryUsecase;
    this.departmentUsecase = departmentUsecase;
    this.subcategoryUsecase = subcategoryUsecase;
    this.brandUsecase = brandUsecase;
    this.cleaningPackingUsecase = cleaningPackingUsecase;
    this.productRepo = productRepo;
    this.stockHoldingReportUsecase = stockHoldingReportUsecase;
    // Stage 0C / C1c. Set by setEmployeeLifecycleUsecase after construction.
    this.employeeLifecycleUsecase = null;
  }

  initCronJobs(cronService, apiSyncLogger) {
    const wrap = (logType, path, fn) =>
      apiSyncLogger ? apiSyncLogger.wrapCron(logType, path, fn) : fn;

    cronService.register(
      "product_sync",
      CRON_SYNTAX_PRODUCT,
      wrap("product_sync", "/product/sync", async () => {
        return await this.syncProductsWithLogging();
      })
    );

    cronService.register(
      "stock_holding_report_sync",
      CRON_SYNTAX_STOCK_HOLDING,
      wrap(
        "stock_holding_report_sync",
        "/stock-holding-report/sync",
        async () => {
          await this.syncStockHoldingReportWithLogging();
        }
      )
    );
  }

  async syncStockHoldingReportWithLogging() {
    logger.Log({
      level: logger.LEVEL.INFO,
      component: "SERVICE.SYNKER",
      code: "SERVICE.SYNKER.STOCK-HOLDING-SYNC",
      description: "Syncing stock holding report",
      category: "",
      ref: {},
    });

    if (!this.stockHoldingReportUsecase) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.SYNKER",
        code: "SERVICE.SYNKER.STOCK-HOLDING-SYNC",
        description: "stockHoldingReportUsecase not configured",
        category: "",
        ref: {},
      });
      return;
    }

    try {
      const result = await this.stockHoldingReportUsecase.syncFromDeliumApi();
      logger.Log({
        level: logger.LEVEL.INFO,
        component: "SERVICE.SYNKER",
        code: "SERVICE.SYNKER.STOCK-HOLDING-SYNC",
        description: JSON.stringify(result),
        category: "",
        ref: {},
      });
      return result;
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.SYNKER",
        code: "SERVICE.SYNKER.STOCK-HOLDING-SYNC",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  /**
   * Stage 0C / C1c employment-period reconciliation.
   *
   * HAS NO CALLER. Its only caller was syncDigismeEmployees(), removed with
   * the rest of the Digisme employee sync. It is kept, wired and callable
   * because removing it would discard working reconciliation logic, and
   * because that sync had been disabled at two switches for the whole of
   * Stage 0C - so this had not run in production either way, and keeping it
   * callerless changes nothing that was happening.
   *
   * GIVING IT A CALLER IS A SEPARATE, DELIBERATE DECISION: its own cron, or
   * the local Resign / Rejoin actions calling it directly. Until then no
   * process reconciles employment periods, which is the state Stage 0C has
   * been in since the pause, not a regression introduced here.
   */
  async reconcileEmployeeLifecycle() {
    if (!this.employeeLifecycleUsecase) {
      console.log("Employee lifecycle reconciler not wired; skipping");
      return { code: 200, lifecycle: { skipped: "not_wired" } };
    }

    try {
      const summary = await this.employeeLifecycleUsecase.reconcileAll();
      console.log(
        `Employee lifecycle reconciled: ${summary.candidates} candidate(s), ` +
          `${summary.open_initial} opened, ${summary.open_rejoin} rejoined, ` +
          `${summary.close} closed, ${summary.fill} filled, ${summary.failed} failed`
      );
      return { code: summary.failed > 0 ? 207 : 200, lifecycle: summary };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.SYNKER",
        code: "SERVICE.SYNKER.LIFECYCLE-RECONCILE-FAILED",
        description: err.toString(),
        category: "",
        ref: {},
      });
      console.error("Employee lifecycle reconciliation failed:", err.message);
      return { code: 207, msg: "Employee sync completed; lifecycle reconciliation failed", error: err.message };
    }
  }

  /** Wired after construction, like setSynker elsewhere, to avoid a 12th positional argument. */
  setEmployeeLifecycleUsecase(employeeLifecycleUsecase) {
    this.employeeLifecycleUsecase = employeeLifecycleUsecase;
  }

  async syncProductsWithLogging() {
    const startTime = new Date();
    const logEntry = {
      timestamp: startTime.toISOString(),
      startTime: startTime.toLocaleString(),
      status: "started",
    };

    try {
      console.log(`Product sync started at ${logEntry.startTime}`);

      // Call the original syncProducts method
      const result = await this.syncProducts();

      const endTime = new Date();
      const timeTaken = endTime - startTime;

      logEntry.endTime = endTime.toLocaleString();
      logEntry.timeTakenMs = timeTaken;
      logEntry.timeTakenSeconds = Math.round(timeTaken / 1000);
      logEntry.status = "completed";
      logEntry.productsProcessed = result?.productsProcessed || 0;
      logEntry.categoriesProcessed = result?.categoriesProcessed || 0;
      logEntry.subcategoriesProcessed = result?.subcategoriesProcessed || 0;
      logEntry.brandsProcessed = result?.brandsProcessed || 0;
      logEntry.departmentsProcessed = result?.departmentsProcessed || 0;

      console.log(
        `Product sync completed in ${logEntry.timeTakenSeconds} seconds. Products: ${logEntry.productsProcessed}`
      );

      // Write to log file
      this.writeToLogFile(logEntry);
      return result;
    } catch (error) {
      const endTime = new Date();
      const timeTaken = endTime - startTime;

      logEntry.endTime = endTime.toLocaleString();
      logEntry.timeTakenMs = timeTaken;
      logEntry.timeTakenSeconds = Math.round(timeTaken / 1000);
      logEntry.status = "failed";
      logEntry.error = error.message;

      console.error(
        `Product sync failed after ${logEntry.timeTakenSeconds} seconds: ${error.message}`
      );

      // Write error to log file
      this.writeToLogFile(logEntry);
      throw error;
    }
  }

  writeToLogFile(logEntry) {
    try {
      const logDir = path.join(__dirname, "..", "logs");

      // Create logs directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const logFile = path.join(logDir, "product-sync.log");
      const logLine = JSON.stringify(logEntry) + "\n";

      // Append to log file
      fs.appendFileSync(logFile, logLine);
    } catch (error) {
      console.error("Failed to write to log file:", error.message);
    }
  }

  async syncCleaningPacking() {
    try {
      await this.cleaningPackingUsecase.deleteAll();
      const deliumCleaningPacking = await this._fetchDeliumCleaningPacking();
      for (const item of deliumCleaningPacking) {
        await this.cleaningPackingUsecase.create({
          purchase_item: item.purchase_item,
          purchase_item_name: item.purchase_item_name,
          article_id: item.article_id,
          article_name: item.article_name,
          priority_score: item.priority_score,
          repackage_conversion: item.repackage_conversion,
          planner: item.planner,
          repack_quantity: item.repack_quantity,
          forecast_quantity: item.forecast_quantity,
          order_date: moment(item.order_date).format("YYYY-MM-DD"),
          child_stock_in_hand: item.child_stock_in_hand,
          parent_stock: item.parent_stock,
          store_uom: item.store_uom,
          num_stores_oos: item.num_stores_oos,
          chain_bill_count_level: item.chain_bill_count_level,
        });
      }
      console.log("INSERTING CLEANING PACKING Done");
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  async syncProducts() {
    try {
      const warnings = [];
      // const goFrugalItems = [];
      // GoFrugal REST API disabled — not used anymore
      // try {
      //   const goFrugalItemsCount = await this._fetchGoFrugalItemsCount();
      //   goFrugalItems = await this._fetchGoFrugalItems(goFrugalItemsCount);
      // } catch (err) {
      //   const status = err?.response?.status;
      //   if (status === 401 || status === 403) {
      //     const warning = `GoFrugal API auth failed (${status}); continuing without gf_* enrichment`;
      //     warnings.push(warning);
      //     logger.Log({
      //       level: logger.LEVEL.WARN,
      //       component: "SERVICE.SYNKER",
      //       code: "SERVICE.SYNKER.GOFRUGAL-AUTH",
      //       description: warning,
      //       category: "",
      //       ref: { status },
      //     });
      //   } else {
      //     throw err;
      //   }
      // }
      const deliumItems = await this._fetchDeliumItems();

      // const { itemPrices, outlets, products } =
      //   this._transformGofrugalItems(goFrugalItems);
      const products = {};
      const {
        brands,
        categories,
        subcategories,
        departments,
        packageTypes,
        formattedProduct,
      } = this.formatProducts(deliumItems);

      let productsProcessed = 0;
      let categoriesProcessed = 0;
      let subcategoriesProcessed = 0;
      let brandsProcessed = 0;
      let departmentsProcessed = 0;

      for (const i in formattedProduct) {
        formattedProduct[i] = {
          ...formattedProduct[i],
          ...products[formattedProduct[i].product_id],
        };
        await this.productUsecase.create(formattedProduct[i]);
        productsProcessed++;
      }
      console.log("INSERTING PRODUCTS Done");

      for (const i in categories) {
        await this.categoryUsecase.upsert(categories[i]);
        categoriesProcessed++;
      }
      console.log("INSERTING CATEGORIES Done");

      for (const i of Object.keys(subcategories)) {
        await this.subcategoryUsecase.upsert(subcategories[i]);
        subcategoriesProcessed++;
      }
      console.log("INSERTING SUBCATEGORIES Done");

      for (const i of Object.keys(brands)) {
        await this.brandUsecase.upsert(brands[i]);
        brandsProcessed++;
      }
      console.log("INSERTING BRANDS Done");

      for (const i in departments) {
        await this.departmentUsecase.upsert(departments[i]);
        departmentsProcessed++;
      }
      console.log("INSERTING DEPARTMENTS Done");

      return {
        productsProcessed,
        categoriesProcessed,
        subcategoriesProcessed,
        brandsProcessed,
        departmentsProcessed,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  // _fetchGoFrugalItems(limit) {
  //   return new Promise(async (resolve, reject) => {
  //     try {
  //       const response = await axios({
  //         method: "GET",
  //         url: `http://dailyneeds.gofrugal.com/RayMedi_HQ/api/v1/items?limit=${limit}`,
  //         headers: {
  //           "X-Auth-Token": GOFRUGAL_API_KEY,
  //         },
  //       });
  //       if (response.status !== 200) {
  //         logger.Log({
  //           level: logger.LEVEL.ERROR,
  //           component: "SERVICE.SYNKER",
  //           code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
  //           description: err.toString(),
  //           category: "",
  //           ref: {},
  //         });
  //         reject();
  //         return;
  //       }
  //       const items = response.data.items;
  //       resolve(items);
  //     } catch (err) {
  //       logger.Log({
  //         level: logger.LEVEL.ERROR,
  //         component: "SERVICE.SYNKER",
  //         code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
  //         description: err.toString(),
  //         category: "",
  //         ref: {},
  //       });
  //       reject(err);
  //     }
  //   });
  // }

  // _fetchGoFrugalItemsCount() {
  //   return new Promise(async (resolve, reject) => {
  //     try {
  //       const response = await axios({
  //         method: "GET",
  //         url: "http://dailyneeds.gofrugal.com/RayMedi_HQ/api/v1/items?limit=1",
  //         headers: {
  //           "X-Auth-Token": GOFRUGAL_API_KEY,
  //         },
  //       });
  //       if (response.status !== 200) {
  //         logger.Log({
  //           level: logger.LEVEL.ERROR,
  //           component: "SERVICE.SYNKER",
  //           code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
  //           description: err.toString(),
  //           category: "",
  //           ref: {},
  //         });
  //         reject();
  //         return;
  //       }
  //       const totalItems = Number(response.data.total_records);
  //       resolve(totalItems);
  //     } catch (err) {
  //       logger.Log({
  //         level: logger.LEVEL.ERROR,
  //         component: "SERVICE.SYNKER",
  //         code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
  //         description: err.toString(),
  //         category: "",
  //         ref: {},
  //       });
  //       reject(err);
  //     }
  //   });
  // }

  // _transformGofrugalItems(goFrugalItems) {
  //   try {
  //     const itemPrices = [];
  //     const outlets = {};
  //     const products = {};
  //
  //     for (const item of goFrugalItems) {
  //       products[item.itemId] = {
  //         gf_item_name: item.itemName,
  //         gf_description: item.description,
  //         gf_detailed_description: item.detailedDescription,
  //         gf_weight_grams: item.weightGrams,
  //         gf_applies_online: item.appliesOnline,
  //         gf_item_product_type: item.itemProductType,
  //         gf_manufacturer: item.manufacturer,
  //         gf_food_type: item.foodType,
  //         gf_tax_id: item.taxId,
  //         gf_status: item.status,
  //       };
  //
  //       for (const stock of item.stock) {
  //         itemPrices.push({
  //           product_id: item.itemId,
  //           outlet_id: stock.outletId,
  //           stock: stock.stock,
  //           cost_price: stock.mrp,
  //           selling_price: stock.salePrice,
  //         });
  //         outlets[stock.outletId] = true;
  //       }
  //     }
  //     return { itemPrices, outlets, products };
  //   } catch (err) {}
  // }

  _fetchDeliumItems() {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: "GET",
          url: deliumConfig.apiUrl(deliumConfig.paths.articles),
          headers: {
            "X-DELIUM-KEY": deliumConfig.apiKey,
          },
        });
        if (response.status !== 200) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE.SYNKER",
            code: "SERVICE.SYNKER.DELIUM-FETCH",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject();
          return;
        }
        resolve(response.data);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.SYNKER",
          code: "SERVICE.SYNKER.DELIUM-FETCH",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  _fetchDeliumCleaningPacking(forDate = moment().format("YYYY-MM-DD")) {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: "GET",
          url: deliumConfig.apiUrl(
            `${deliumConfig.paths.repackaging}?for_date=${forDate}`
          ),
          headers: {
            "X-DELIUM-KEY": deliumConfig.apiKey,
          },
        });
        if (response.status !== 200) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE.SYNKER",
            code: "SERVICE.SYNKER.DELIUM-CLEANING-PACKING-FETCH",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject();
          return;
        }
        resolve(response.data);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.SYNKER",
          code: "SERVICE.SYNKER.DELIUM-CLEANING-PACKING-FETCH",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  formatProducts(products) {
    const brands = {};
    const categories = {};
    const subcategories = {};
    const departments = {};
    const packageTypes = {};

    const formattedProduct = [];

    for (const product of products) {
      const transformed = this._transformProduct(product);

      if (brands[transformed.brand_id] == undefined)
        brands[transformed.brand_id] = {
          brand_id: transformed.brand_id,
          brand_name: transformed.brand_name,
          category_id: transformed.category_id,
        };

      if (categories[transformed.category_id] == undefined)
        categories[transformed.category_id] = {
          category_id: transformed.category_id,
          category_name: transformed.category_name,
          department_id: transformed.department_id,
        };

      if (subcategories[transformed.subcategory_id] == undefined)
        subcategories[transformed.subcategory_id] = {
          category_id: transformed.category_id,
          subcategory_id: transformed.subcategory_id,
          subcategory_name: transformed.subcategory_name,
        };

      if (departments[transformed.department_id] == undefined)
        departments[transformed.department_id] = {
          department_id: transformed.department_id,
          department_name: transformed.department_name,
        };

      if (
        transformed.packaging_type &&
        transformed.packaging_type.trim() != ""
      ) {
        packageTypes[transformed.packaging_type] = true;
      }

      formattedProduct.push({
        product_id: transformed.product_id,
        de_distributor: product.distributor_name,
        brand_id: transformed.brand_id,
        category_id: transformed.category_id,
        subcategory_id: transformed.subcategory_id,
        department_id: transformed.department_id,
        measure: product.measure,
        measure_in: product.measure_in,
        packaging_type: product.packaging_type,
        de_display_name: product.display_name,
        de_name: product.name,
        de_packaging_type: product.packaging_type,
        de_preparation_type: product.preparation_type,
        de_combo_name: product.combo_name,
        purchase_uom: product.purchase_uom,
        store_uom: product.store_uom,
        repln_mode: product.repln_mode,
        de_is_online_allowed: product.is_online_allowed,
        buyer_name: product.buyer_name ?? null,
        distributor_id:
          product.distributor != null &&
          String(product.distributor).trim() !== ""
            ? String(product.distributor).trim()
            : null,
        de_manufacturer_name: product.manufacturer_name ?? null,
        de_bill_count_level:
          product.bill_count_level != null &&
          String(product.bill_count_level).trim() !== ""
            ? String(product.bill_count_level).trim()
            : null,
      });
    }

    return {
      brands,
      categories,
      subcategories,
      departments,
      packageTypes,
      formattedProduct,
    };
  }

  _transformProduct(product) {
    const productId = product.article_id;
    const brandId = product.brand;
    const categoryId = product.category;
    const departmentId = product.department;
    const subcategoryId = product.subcategory;

    delete product.article_id;
    delete product.brand;
    delete product.category;
    delete product.department;
    delete product.subcategory;

    product.product_id = productId;
    product.brand_id = brandId;
    product.category_id = categoryId;
    product.department_id = departmentId;
    product.subcategory_id = subcategoryId;
    product.variant_count = 0;

    return product;
  }
}

module.exports = (
  productUsecase,
  categoryUsecase,
  subcategoryUsecase,
  departmentUsecase,
  brandUsecase,
  cleaningPackingUsecase,
  productRepo,
  stockHoldingReportUsecase
) => {
  return new Synker(
    productUsecase,
    categoryUsecase,
    subcategoryUsecase,
    departmentUsecase,
    brandUsecase,
    cleaningPackingUsecase,
    productRepo,
    stockHoldingReportUsecase
  );
};
