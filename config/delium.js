require("dotenv").config();

const DEFAULT_BASE_URL = "https://dailyneeds.delium.io";
const DEFAULT_API_KEY = "d29f2c2a-ffc5-11e8-baeb-de5a505def9c";

const baseUrl = (process.env.DELIUM_BASE_URL || DEFAULT_BASE_URL).replace(
  /\/$/,
  ""
);
const apiKey = process.env.DELIUM_API_KEY || DEFAULT_API_KEY;

function apiUrl(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalized}`;
}

module.exports = {
  baseUrl,
  apiKey,
  apiUrl,
  paths: {
    articles: "/api/api/articles",
    repackaging: "/api/api/repackaging",
    articlesStockInfo: "/api/api/articles_stock_info",
  },
};
