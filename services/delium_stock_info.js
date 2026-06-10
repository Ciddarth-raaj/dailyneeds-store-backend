const axios = require("axios");
const logger = require("../utils/logger");
const { parseDeliumStockInfoCsv } = require("../utils/deliumStockInfoCsv");
const deliumConfig = require("../config/delium");

async function fetchStockInfoCsv(storeId) {
  const url = deliumConfig.apiUrl(deliumConfig.paths.articlesStockInfo);

  logger.Log({
    level: logger.LEVEL.INFO,
    component: "SERVICE.DELIUM_STOCK_INFO",
    code: "SERVICE.DELIUM_STOCK_INFO.FETCH_START",
    description: `Fetching Delium stock info for store ${storeId}`,
    category: "",
    ref: { storeId, url },
  });

  const response = await axios({
    method: "GET",
    url,
    headers: {
      "X-DELIUM-KEY": deliumConfig.apiKey,
      "Accept-Encoding": "gzip, deflate, br",
    },
    params: { store_id: storeId },
    responseType: "text",
    timeout: 120000,
    decompress: true,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    const err = new Error(
      `Delium stock info failed for store ${storeId}: HTTP ${response.status}`
    );
    err.status = response.status;
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "SERVICE.DELIUM_STOCK_INFO",
      code: "SERVICE.DELIUM_STOCK_INFO.FETCH_HTTP",
      description: err.message,
      category: "",
      ref: { storeId, status: response.status },
    });
    throw err;
  }

  logger.Log({
    level: logger.LEVEL.INFO,
    component: "SERVICE.DELIUM_STOCK_INFO",
    code: "SERVICE.DELIUM_STOCK_INFO.FETCH_OK",
    description: `Delium stock info fetched for store ${storeId}`,
    category: "",
    ref: {
      storeId,
      bytes: response.data ? String(response.data).length : 0,
    },
  });

  return response.data;
}

async function fetchStockInfoItemsForStore(storeId) {
  const csv = await fetchStockInfoCsv(storeId);
  const items = parseDeliumStockInfoCsv(csv, storeId);

  logger.Log({
    level: logger.LEVEL.INFO,
    component: "SERVICE.DELIUM_STOCK_INFO",
    code: "SERVICE.DELIUM_STOCK_INFO.PARSE_OK",
    description: `Parsed ${items.length} stock rows for store ${storeId}`,
    category: "",
    ref: { storeId, row_count: items.length },
  });

  return items;
}

async function fetchStockInfoItemsForStores(storeIds) {
  logger.Log({
    level: logger.LEVEL.INFO,
    component: "SERVICE.DELIUM_STOCK_INFO",
    code: "SERVICE.DELIUM_STOCK_INFO.BATCH_START",
    description: `Fetching Delium stock info for ${storeIds.length} store(s)`,
    category: "",
    ref: { store_ids: storeIds },
  });

  const allItems = [];
  const errors = [];

  for (const storeId of storeIds) {
    try {
      const items = await fetchStockInfoItemsForStore(storeId);
      allItems.push(...items);
    } catch (err) {
      errors.push({ store_id: storeId, message: err.message || String(err) });
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE.DELIUM_STOCK_INFO",
        code: "SERVICE.DELIUM_STOCK_INFO.FETCH_STORE",
        description: err.toString(),
        category: "",
        ref: { storeId },
      });
    }
  }

  logger.Log({
    level: logger.LEVEL.INFO,
    component: "SERVICE.DELIUM_STOCK_INFO",
    code: "SERVICE.DELIUM_STOCK_INFO.BATCH_DONE",
    description: `Delium batch fetch complete: ${allItems.length} row(s), ${errors.length} error(s)`,
    category: "",
    ref: {
      total_rows: allItems.length,
      store_count: storeIds.length,
      error_count: errors.length,
      errors: errors.length ? errors : undefined,
    },
  });

  return { items: allItems, errors };
}

module.exports = {
  fetchStockInfoCsv,
  fetchStockInfoItemsForStore,
  fetchStockInfoItemsForStores,
};
