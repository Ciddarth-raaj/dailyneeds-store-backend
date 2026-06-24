/**
 * Distinct log types for POST sync/import API calls.
 * `match` is tested against req.baseUrl + req.path (Express mount path + route path).
 */
const API_SYNC_TYPES = [
  // Synker cron sync APIs
  {
    type: "product_sync",
    category: "sync",
    label: "Product Sync",
    match: "/product/sync",
  },
  {
    type: "employee_sync",
    category: "sync",
    label: "Employee Sync",
    match: "/employee/sync",
  },
  {
    type: "stock_holding_report_sync",
    category: "sync",
    label: "Stock Holding Report Sync",
    match: "/stock-holding-report/sync",
  },
  // Bulk import APIs
  {
    type: "purchase_bulk",
    category: "bulk",
    label: "Purchase Bulk Import",
    match: "/purchase/bulk",
    server_script: "/home/delium/query_executor/query_exec.sh",
  },
  {
    type: "product_sales_bulk",
    category: "bulk",
    label: "Product Sales Bulk",
    match: "/product-sales/bulk",
    server_script: "/home/delium/product-sales/run_query_wrapper.sh",
  },
  {
    type: "debit_note_bulk",
    category: "bulk",
    label: "Debit Note Bulk Import",
    match: "/debit-note/bulk",
    server_script: "/home/delium/debit-note/debit_node.sh",
  },
  {
    type: "dead_stock_items_bulk",
    category: "bulk",
    label: "Dead Stock Bulk Import",
    match: "/dead-stock-items/bulk",
    server_script: "/home/delium/cron-dnds/dead-stock/run_stock_query.sh",
  },
  {
    type: "product_distributors_hq_import",
    category: "bulk",
    label: "HQ Distributor Import",
    match: "/product-distributors/bulk/hq-import",
    server_script: "/home/delium/cron-dnds/item-distributor/run_query.sh",
  },
  {
    type: "item_markupdown_bulk",
    category: "bulk",
    label: "Item Markup/Down Bulk Import",
    match: "/item-markupdown/bulk",
    server_script: "/home/delium/cron-dnds/item-markdown/run_query.sh",
  },
  {
    type: "hq_offers_hdr_bulk",
    category: "bulk",
    label: "HQ Offers Header Bulk",
    match: "/hq-offers/hdr/bulk",
    server_script: "/home/delium/cron-dnds/offers/run_query.sh",
  },
  {
    type: "hq_offers_products_bulk",
    category: "bulk",
    label: "HQ Offers Products Bulk",
    match: "/hq-offers/products/bulk",
    server_script: "/home/delium/cron-dnds/offers/run_query.sh",
  },
  {
    type: "hq_offers_issue_bulk",
    category: "bulk",
    label: "HQ Offers Issue Bulk",
    match: "/hq-offers/issue/bulk",
    server_script: "/home/delium/cron-dnds/offers/run_query.sh",
  },
];

const TYPE_BY_MATCH = API_SYNC_TYPES.reduce((acc, item) => {
  acc[item.match] = item;
  return acc;
}, {});

const TYPE_BY_LOG_TYPE = API_SYNC_TYPES.reduce((acc, item) => {
  acc[item.type] = item;
  return acc;
}, {});

function resolveLogType(method, fullPath) {
  if (method !== "POST") return null;
  const normalized = fullPath.split("?")[0].replace(/\/+$/, "") || "/";
  if (TYPE_BY_MATCH[normalized]) return TYPE_BY_MATCH[normalized];
  return null;
}

module.exports = {
  API_SYNC_TYPES,
  TYPE_BY_LOG_TYPE,
  resolveLogType,
};
