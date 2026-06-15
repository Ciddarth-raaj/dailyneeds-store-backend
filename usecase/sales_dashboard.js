function formatDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const trimmed = String(value).trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : trimmed.slice(0, 10);
}

class SalesDashboardUsecase {
  constructor(salesDashboardRepo) {
    this.salesDashboardRepo = salesDashboardRepo;
  }

  getDashboardMeta(asOfDate, filters = {}, { fromDate, toDate } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const dateKey = formatDateKey(asOfDate);
        const rangeFrom = formatDateKey(fromDate);
        const rangeTo = formatDateKey(toDate);

        const selectedDateHasSales =
          await this.salesDashboardRepo.hasSalesForDate(dateKey);

        let dailyTotals = [];
        if (rangeFrom && rangeTo) {
          dailyTotals = await this.salesDashboardRepo.getDailyTotals(
            dateKey,
            filters,
            { fromDate: rangeFrom, toDate: rangeTo }
          );
        }

        resolve({
          code: 200,
          message: "Sales dashboard meta fetched successfully",
          data: {
            as_of_date: dateKey,
            selected_date_has_report: selectedDateHasSales,
            from_date: rangeFrom,
            to_date: rangeTo,
            daily_totals: dailyTotals,
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getDashboardFilterOptions(
    asOfDate,
    filters = {},
    { fromDate, toDate } = {}
  ) {
    return new Promise(async (resolve, reject) => {
      try {
        const dateKey = formatDateKey(asOfDate);
        const rangeFrom = formatDateKey(fromDate);
        const rangeTo = formatDateKey(toDate);
        if (!rangeFrom || !rangeTo) {
          resolve({
            code: 422,
            message: "from_date and to_date are required",
          });
          return;
        }

        const filterOptions = await this.salesDashboardRepo.getFilterOptions(
          dateKey,
          { fromDate: rangeFrom, toDate: rangeTo }
        );

        resolve({
          code: 200,
          message: "Sales dashboard filter options fetched successfully",
          data: {
            as_of_date: dateKey,
            from_date: rangeFrom,
            to_date: rangeTo,
            filter_options: filterOptions,
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getDashboardDailyTotals(asOfDate, filters = {}, { fromDate, toDate } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const dateKey = formatDateKey(asOfDate);
        const rangeFrom = formatDateKey(fromDate);
        const rangeTo = formatDateKey(toDate);
        if (!rangeFrom || !rangeTo) {
          resolve({
            code: 422,
            message: "from_date and to_date are required",
          });
          return;
        }

        const dailyTotals = await this.salesDashboardRepo.getDailyTotals(
          dateKey,
          filters,
          { fromDate: rangeFrom, toDate: rangeTo }
        );

        resolve({
          code: 200,
          message: "Sales dashboard daily totals fetched successfully",
          data: {
            as_of_date: dateKey,
            from_date: rangeFrom,
            to_date: rangeTo,
            daily_totals: dailyTotals,
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getDashboardItems(date, filters = {}, pagination = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const dateKey = formatDateKey(date);
        const limit = pagination.limit ?? 5000;
        const offset = pagination.offset ?? 0;

        const items = await this.salesDashboardRepo.getItemsByDate(
          dateKey,
          filters,
          { limit, offset }
        );

        let total = null;
        if (offset === 0) {
          total = await this.salesDashboardRepo.getItemCountByDate(
            dateKey,
            filters
          );
        }

        const nextOffset = offset + items.length;
        const hasMore =
          total != null ? nextOffset < total : items.length >= Number(limit);

        resolve({
          code: 200,
          message: "Sales dashboard items fetched successfully",
          data: {
            date: dateKey,
            items,
            total,
            limit: Number(limit),
            offset: Number(offset),
            has_more: hasMore,
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (salesDashboardRepo) => {
  return new SalesDashboardUsecase(salesDashboardRepo);
};
