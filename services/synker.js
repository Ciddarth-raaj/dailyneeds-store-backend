const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const encryptAES = require("../utils/encryptAES");
const { exec } = require("child_process");
const { capitalizeWords } = require("../utils/string");

const logger = require("../utils/logger");

const DELIUM_API_KEY = "d29f2c2a-ffc5-11e8-baeb-de5a505def9c";
const GOFRUGAL_API_KEY =
  "92389031420AEF2B22174FA933F178040AFD9395A5E9C3F013A74C4CA152CE786116998975B7AF31";

const DIGISME_API_KEY =
  "87961db9-7af8-472f-bf20-41c4f8ba117d:6eGalmciCUs09JToTitdJeOJzO4VZr";
const DIGISME_CUSTOM_KEY =
  "RO9XC34ub5YjttUlD08VuP3Q6JIldpNCRAwLm+YovhbOWC/BNGJ45VNGegryFBvCy30m+r1ocix8CwhULO7SWQ==";

const CRON_SYNTAX_PRODUCT = "0 6 * * *";
const CRON_SYNTAX_EMPLOYEE = "0 7 * * *";
const CRON_SYNTAX_CLEANING_PACKING = "0 9 * * *";

class Synker {
  constructor(
    productUsecase,
    categoryUsecase,
    subcategoryUsecase,
    departmentUsecase,
    brandUsecase,
    cleaningPackingUsecase,
    designationUsecase,
    outletUsecase,
    employeeUsecase
  ) {
    this.productUsecase = productUsecase;
    this.categoryUsecase = categoryUsecase;
    this.departmentUsecase = departmentUsecase;
    this.subcategoryUsecase = subcategoryUsecase;
    this.brandUsecase = brandUsecase;
    this.cleaningPackingUsecase = cleaningPackingUsecase;
    this.designationUsecase = designationUsecase;
    this.outletUsecase = outletUsecase;
    this.employeeUsecase = employeeUsecase;
  }

  initCronJobs() {
    this.syncProductsWithLogging();
    // Schedule CRON job for product sync
    cron.schedule(CRON_SYNTAX_PRODUCT, () => {
      console.log(
        `Running scheduled product sync at ${new Date().toISOString()}`
      );
      this.syncProductsWithLogging();
    });

    // cron.schedule(CRON_SYNTAX_CLEANING_PACKING, () => {

    cron.schedule(CRON_SYNTAX_EMPLOYEE, () => {
      console.log(
        `Running scheduled employee sync at ${new Date().toISOString()}`
      );
      this.syncDigismeEmployees();
    });

    // cron.schedule(CRON_SYNTAX_CLEANING_PACKING, () => {
    //   console.log(`Running scheduled cleaning packing sync at ${new Date().toISOString()}`);
    //   this.syncCleaningPacking();
    // });

    console.log(
      `Product sync CRON job scheduled with syntax: ${CRON_SYNTAX_PRODUCT}`
    );
    console.log(
      `Employee sync CRON job scheduled with syntax: ${CRON_SYNTAX_EMPLOYEE}`
    );
    // console.log(`Cleaning packing sync CRON job scheduled with syntax: ${CRON_SYNTAX_CLEANING_PACKING}`);
  }

  async getDigismeToken() {
    try {
      const response = await this._authenticateDigisme();
      return response.access_token;
    } catch (error) {
      console.error(error);
      throw err;
    }
  }

  async syncDigismeEmployees() {
    try {
      const GENDER_MAP = {
        FEMALE: "F",
        MALE: "M",
      };

      const MARITAL_STATUS_MAP = {
        MARRIED: "M",
        SINGLE: "S",
      };

      const employees = await this._fetchDigismeEmployees();
      const parsedDesignations = {};
      const parsedDepartments = {};
      const parsedBranches = {};

      let formattedEmployees = employees.map((employee) => {
        if (!parsedDesignations[employee.DesignationCode]) {
          parsedDesignations[employee.DesignationCode] = {
            designation_code: employee.DesignationCode,
            designation_name: capitalizeWords(employee.DesignationName),
            online_portal: 1,
            login_access: 1,
          };
        }

        if (!parsedBranches[employee.CategoryCode]) {
          parsedBranches[employee.CategoryCode] = {
            outlet_nickname: capitalizeWords(employee.CategoryName),
            outlet_code: employee.CategoryCode,
          };
        }

        if (
          employee.DepartmentCode !== "NONE" &&
          !parsedDepartments[employee.DepartmentCode]
        ) {
          parsedDepartments[employee.DepartmentCode] = {
            department_code: employee.DepartmentCode,
            department_name: capitalizeWords(employee.DepartmentName),
          };
        }

        return {
          employee_id: employee.EmployeeCode,
          employee_name: capitalizeWords(employee.EmployeeName),
          gender: GENDER_MAP[employee.Gender] ?? null,
          marital_status: MARITAL_STATUS_MAP[employee.MartialStatus] ?? null,
          department_code: employee.DepartmentCode,
          designation_code: employee.DesignationCode,
          outlet_code: employee.CategoryCode,
          shift_code: employee.ShiftCode,
          primary_contact_number: employee.MobileNo
            ? employee.MobileNo.replace("91-", "")
            : null,
          status:
            employee.IsTerminated &&
              employee.IsTerminated.toLowerCase() === "yes"
              ? 0
              : 1,
          resignation_date:
            employee.IsTerminated &&
              employee.IsTerminated.toLowerCase() === "yes"
              ? new Date(employee.TerminateDate)
              : null,
        };
      });

      const designationsRes = await this.designationUsecase.bulkCreate(
        Object.values(parsedDesignations)
      );
      const departmentsRes = await this.departmentUsecase.bulkCreate(
        Object.values(parsedDepartments)
      );
      const branchesRes = await this.outletUsecase.bulkCreate(
        Object.values(parsedBranches)
      );

      const designations = Object.fromEntries(
        (designationsRes.designations || []).map((d) => [d.designation_code, d])
      );
      const departments = Object.fromEntries(
        (departmentsRes.departments || []).map((d) => [d.department_code, d])
      );
      const branches = Object.fromEntries(
        (branchesRes.branches || []).map((d) => [d.outlet_code, d])
      );

      formattedEmployees = formattedEmployees.map((employee) => {
        const data = {
          ...employee,
          designation_id:
            designations[employee.designation_code]?.designation_id,
          department_id: departments[employee.department_code]?.department_id,
          store_id: branches[employee.outlet_code]?.outlet_id,
        };

        delete data.designation_code;
        delete data.department_code;
        delete data.outlet_code;

        return data;
      });

      await this.employeeUsecase.bulkCreate(formattedEmployees);
      console.log("Employee sync completed");
    } catch (err) {
      console.error(err);
    }
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
      const goFrugalItemsCount = await this._fetchGoFrugalItemsCount();
      const goFrugalItems = await this._fetchGoFrugalItems(goFrugalItemsCount);
      const deliumItems = await this._fetchDeliumItems();

      const { itemPrices, outlets, products } =
        this._transformGofrugalItems(goFrugalItems);
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
      };
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  _fetchGoFrugalItems(limit) {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: "GET",
          url: `http://dailyneeds.gofrugal.com/RayMedi_HQ/api/v1/items?limit=${limit}`,
          headers: {
            "X-Auth-Token": GOFRUGAL_API_KEY,
          },
        });
        if (response.status !== 200) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE.SYNKER",
            code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject();
          return;
        }
        const items = response.data.items;
        resolve(items);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.SYNKER",
          code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  _fetchGoFrugalItemsCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: "GET",
          url: "http://dailyneeds.gofrugal.com/RayMedi_HQ/api/v1/items?limit=1",
          headers: {
            "X-Auth-Token": GOFRUGAL_API_KEY,
          },
        });
        if (response.status !== 200) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE.SYNKER",
            code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject();
          return;
        }
        const totalItems = Number(response.data.total_records);
        resolve(totalItems);
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.SYNKER",
          code: "SERVICE.SYNKER.GOFRUGAL-FETCH",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  _transformGofrugalItems(goFrugalItems) {
    try {
      const itemPrices = [];
      const outlets = {};
      const products = {};

      for (const item of goFrugalItems) {
        products[item.itemId] = {
          gf_item_name: item.itemName,
          gf_description: item.description,
          gf_detailed_description: item.detailedDescription,
          gf_weight_grams: item.weightGrams,
          gf_applies_online: item.appliesOnline,
          gf_item_product_type: item.itemProductType,
          gf_manufacturer: item.manufacturer,
          gf_food_type: item.foodType,
          gf_tax_id: item.taxId,
          gf_status: item.status,
        };

        for (const stock of item.stock) {
          itemPrices.push({
            product_id: item.itemId,
            outlet_id: stock.outletId,
            stock: stock.stock,
            cost_price: stock.mrp,
            selling_price: stock.salePrice,
          });
          outlets[stock.outletId] = true;
        }
      }
      return { itemPrices, outlets, products };
    } catch (err) { }
  }

  _fetchDeliumItems() {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: "GET",
          url: "https://dailyneeds.delium.io/api/api/articles",
          headers: {
            "X-DELIUM-KEY": DELIUM_API_KEY,
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
          url: `https://dailyneeds.delium.io/api/api/repackaging?for_date=${forDate}`,
          headers: {
            "X-DELIUM-KEY": DELIUM_API_KEY,
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

  _authenticateDigisme() {
    return new Promise(async (resolve, reject) => {
      try {
        const curlCommand = `curl -s --location --request GET 'https://indhrmsgateway.azurewebsites.net/Authenticate' \
--header 'Authorization: ${DIGISME_API_KEY}' \
--header 'customKey: ${DIGISME_CUSTOM_KEY}' \
--header 'Content-Type: application/x-www-form-urlencoded' \
--header 'Cookie: ARRAffinity=9a42df7877699a1820bb3aff0e46053675d3b7c9cb3150938bf21e214337c56e; ARRAffinitySameSite=9a42df7877699a1820bb3aff0e46053675d3b7c9cb3150938bf21e214337c56e' \
--data-urlencode 'Grant_type=password'`;

        exec(curlCommand, (error, stdout, stderr) => {
          if (error) {
            console.error(`Error executing curl: ${error.message}`);
            reject(error);
            return;
          }
          if (stderr) {
            console.error(`Curl stderr: ${stderr}`);
            reject(stderr);
            return;
          }

          console.log(`Curl stdout: ${stdout}`);
          // Process the 'stdout' which contains the response from the curl command
          resolve(JSON.parse(stdout));
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE.SYNKER",
          code: "SERVICE.SYNKER.DIGISME-AUTHENTICATE",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }

  async getDigismeToken() {
    try {
      const response = await this._authenticateDigisme();
      return response.access_token;
    } catch (error) {
      console.error(error);
      throw err;
    }
  }

  _fetchDigismeEmployees() {
    return new Promise(async (resolve, reject) => {
      try {
        const str = encryptAES({
          CompanyId: "1",
          IsActive: "2",
        });
        const token = await this.getDigismeToken();

        const response = await axios({
          method: "GET",
          url: "https://indhrmsgateway.azurewebsites.net/api/GetEmployeeDetails",
          headers: {
            Authorization: `bearer ${token}`,
          },
          data: {
            str,
          },
        });
        if (response.status !== 200) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE.SYNKER",
            code: "SERVICE.SYNKER.DIGISME-EMPLOYEES-FETCH",
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
          code: "SERVICE.SYNKER.DIGISME-EMPLOYEES-FETCH",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
      }
    });
  }
}

module.exports = (
  productUsecase,
  categoryUsecase,
  subcategoryUsecase,
  departmentUsecase,
  brandUsecase,
  cleaningPackingUsecase,
  designationUsecase,
  outletUsecase,
  employeeUsecase
) => {
  return new Synker(
    productUsecase,
    categoryUsecase,
    subcategoryUsecase,
    departmentUsecase,
    brandUsecase,
    cleaningPackingUsecase,
    designationUsecase,
    outletUsecase,
    employeeUsecase
  );
};
