
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment");

const logger = require("../utils/logger");

const DELIUM_API_KEY = "d29f2c2a-ffc5-11e8-baeb-de5a505def9c";
const GOFRUGAL_API_KEY =
    "92389031420AEF2B22174FA933F178040AFD9395A5E9C3F013A74C4CA152CE786116998975B7AF31";

const CRON_SYNTAX_PRODUCT = "0 6 * * *";
const CRON_SYNTAX_PRODUCT_PREF = "0 6 * * *";
const CRON_SYNTAX_GENERAL = "0 7,16 * * *";

class Synker {
    constructor() {

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
                }

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

    formatProducts(products) {
        const brands = {};
        const categories = {};
        const subcategories = {};
        const departments = {};
        const packageTypes = {};

        const formattedProduct = []

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
                de_distributor: product.distributor,
                brand_id: transformed.brand_id,
                category_id: transformed.category_id,
                subcategory_id: transformed.subcategory_id,
                measure: product.measure,
                measure_in: product.measure_in,
                packaging_type: product.packaging_type,
            })
        }

        return { brands, categories, subcategories, departments, packageTypes, formattedProduct }
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

const test = async () => {
    const obj = new Synker()
    const goFrugalItemsCount = await obj._fetchGoFrugalItemsCount()
    const goFrugalItems = await obj._fetchGoFrugalItems(goFrugalItemsCount);
    const deliumItems = await obj._fetchDeliumItems()

    const { itemPrices, outlets, products } = obj._transformGofrugalItems(goFrugalItems);
    const { brands, categories, subcategories, departments, packageTypes, formattedProduct } = obj.formatProducts(deliumItems)

    for (const i in formattedProduct) {
        formattedProduct[i] = { ...formattedProduct[i], ...products[formattedProduct[i].product_id] }
    }
}

test()