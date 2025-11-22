const accountsUtil = {};

function getCashSales(accountData) {
  const { total_sales, card_sales, loyalty } = accountData;
  const totalSales = parseFloat(total_sales);
  const cardSales = parseFloat(card_sales);
  const parsedLoyalty = parseFloat(loyalty);

  return totalSales - cardSales - parsedLoyalty;
}

accountsUtil.calculcateTotal = (accounts) => {
  return accounts.reduce(
    (acc, item) => {
      return {
        no_of_bills: acc.no_of_bills + parseFloat(item.no_of_bills || 0),
        total_sales: acc.total_sales + parseFloat(item.total_sales || 0),
        card_sales: acc.card_sales + parseFloat(item.card_sales || 0),
        sales_return: acc.sales_return + parseFloat(item.sales_return || 0),
        loyalty: acc.loyalty + parseFloat(item.loyalty || 0),
        cash_sales: acc.cash_sales + getCashSales(item),
      };
    },
    {
      no_of_bills: 0,
      total_sales: 0,
      card_sales: 0,
      sales_return: 0,
      loyalty: 0,
      cash_sales: 0,
    }
  );
};

accountsUtil.getFilter = (sheetData) => {
  const startOfDay = new Date(sheetData.sheet_date);
  startOfDay.setHours(0, 0, 0, 0);
  startOfDay.setDate(1);

  const endOfDay = new Date(sheetData.sheet_date);
  endOfDay.setHours(23, 59, 59, 999);

  return {
    store_id: sheetData.store_id,
    from_date: startOfDay.toISOString(),
    to_date: endOfDay.toISOString(),
  };
};

accountsUtil.currencyFormatter = (value) => {
  let formatter = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return formatter.format(value);
};

module.exports = accountsUtil;
