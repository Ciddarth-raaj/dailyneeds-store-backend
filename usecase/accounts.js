const { ALERTS_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const moment = require("moment");
const { uuid } = require("uuidv4");

const OUTLET_CASH_ID_MAP = {
  4: "Dn1",
  3: "Dn2",
  5: "Dn3",
  6: "Dn4",
};

const INIT_JOURNAL_ENTRY = (date) => ({
  MasterID: uuid(),
  SellerGSTIN: null,
  VoucherState: "Puducherry",
  ShipFromState: "Puducherry",
  VoucherNumber: null,
  VoucherDate: date,
  VoucherType: "Journal",
  VoucherBaseType: "Journal ",
  Reference: null,
  ReferenceDate: date,
  IsCancelled: null,
  PartyName: null,
  GSTREGISTRATIONTYPE: null,
  Voucher_Total: null,
  DeliveryNoteNo: null,
  DeliveryNoteDate: null,
  DispatchDocNo: null,
  DispatchThrough: null,
  Destination: null,
  CarrierName: null,
  LRNo: null,
  LRDate: null,
  MotorVehicleNo: null,
  OrderNo: "",
  OrderDate: "",
  TermsOfPayment: null,
  OtherReferences: null,
  TermsOfDelivery: null,
  PlaceOfSupply: " ",
  IsInvoice: "No",
  IsDeleted: "No",
  Narration: null,
  VoucherCostCentre: null,
  ledgerentries: [],
});

class AccountsUsecase {
  constructor(accountsRepo, accountsEbookUsecase, outletUsecase) {
    this.accountsRepo = accountsRepo;
    this.accountsEbookUsecase = accountsEbookUsecase;
    this.outletUsecase = outletUsecase;
    this.telegram = require("../services/telegram")();
  }

  async createAccount(account) {
    try {
      const result = await this.accountsRepo.create(account);

      if (result.code === 200 && account.sales) {
        for (const sale of account.sales) {
          await this.accountsRepo.createSale({
            ...sale,
            accounts_id: result.id,
          });
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  async updateAccount(account) {
    try {
      const result = await this.accountsRepo.update(account);

      if (account.sales) {
        for (const sale of account.sales) {
          if (sale.sales_id) {
            await this.accountsRepo.updateSale({
              ...sale,
              accounts_id: account.accounts_id,
            });
          } else {
            await this.accountsRepo.createSale({
              ...sale,
              receipt_path: sale.receipt_path ?? "",
              accounts_id: account.accounts_id,
            });
          }
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteAccount(accountId) {
    try {
      const result = await this.accountsRepo.delete(accountId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllAccounts(filters) {
    try {
      const result = await this.accountsRepo.getAll(filters);
      const accountsEbook = await this.accountsEbookUsecase.getAllEbooks(
        filters
      );
      let outlet_data = null;
      let is_saved = false;

      if (filters.store_id) {
        const outletResponse = await this.outletUsecase.getOutletByOutletId(
          filters.store_id
        );

        if (outletResponse.length > 0) {
          outlet_data = outletResponse[0];
        }
      }

      const is_saved_response = await this.checkSheetSaved(
        moment(filters.to_date).format("YYYY-MM-DD"),
        filters.store_id
      );

      if (is_saved_response.code === 200) {
        is_saved = is_saved_response.is_saved;
      }

      const { data } = result;
      result.data = {
        account: data,
        ebook: accountsEbook.data,
        outlet: outlet_data,
        is_saved,
      };

      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAccountById(accountId) {
    try {
      const result = await this.accountsRepo.getById(accountId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async saveAccount(sheetData) {
    try {
      const result = await this.accountsRepo.saveAccount(sheetData);

      try {
        // Get outlet name
        const outletResponse = await this.outletUsecase.getOutletByOutletId(
          sheetData.store_id
        );
        const outletName =
          outletResponse.length > 0
            ? outletResponse[0].outlet_name
            : "Unknown Outlet";

        const formattedDate = moment(sheetData.sheet_date).format("DD-MM-YYYY");
        await this.telegram.sendMessage(
          ALERTS_TELEGRAM_CHAT_ID,
          `✅ Account sheet saved for ${outletName} (Date: ${formattedDate})`
        );
      } catch (telegramErr) {
        console.log("Failed to send Telegram notification:", telegramErr);
        // Don't throw here as the data was saved successfully
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteSavedAccount(sheetId) {
    try {
      const result = await this.accountsRepo.deleteSavedAccount(sheetId);

      if (result.code === 200) {
        try {
          // Get outlet name
          const outletResponse = await this.outletUsecase.getOutletByOutletId(
            sheetId.store_id
          );
          const outletName =
            outletResponse.length > 0
              ? outletResponse[0].outlet_name
              : "Unknown Outlet";

          const formattedDate = moment(sheetId.sheet_date).format("DD-MM-YYYY");

          await this.telegram.sendMessage(
            ALERTS_TELEGRAM_CHAT_ID,
            `❌ Account sheet unlocked for ${outletName} (Date: ${formattedDate})`
          );
        } catch (telegramErr) {
          console.log("Failed to send Telegram notification:", telegramErr);
          // Don't throw here as the data was deleted successfully
        }
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  async checkSheetSaved(date, store_id) {
    try {
      const result = await this.accountsRepo.checkSheetSaved(date, store_id);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getStandaloneSaleById(saleId) {
    try {
      const result = await this.accountsRepo.getStandaloneSaleById(saleId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async createWarehouseSale(sale) {
    try {
      const result = await this.accountsRepo.createWarehouseSale(sale);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updateWarehouseSale(sale) {
    try {
      const result = await this.accountsRepo.updateWarehouseSale(sale);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteWarehouseSale(saleId) {
    try {
      const result = await this.accountsRepo.deleteWarehouseSale(saleId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseSales(filters) {
    try {
      const result = await this.accountsRepo.getWarehouseSales(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseSaleById(saleId) {
    try {
      const result = await this.accountsRepo.getWarehouseSaleById(saleId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async createWarehouseCashDenomination(denomination) {
    try {
      const result = await this.accountsRepo.createWarehouseCashDenomination(
        denomination
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updateWarehouseCashDenomination(denomination) {
    try {
      const result = await this.accountsRepo.updateWarehouseCashDenomination(
        denomination
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteWarehouseCashDenomination(denominationId) {
    try {
      const result = await this.accountsRepo.deleteWarehouseCashDenomination(
        denominationId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseCashDenominations(filters) {
    try {
      const result = await this.accountsRepo.getWarehouseCashDenominations(
        filters
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getWarehouseCashDenominationById(denominationId) {
    try {
      const result = await this.accountsRepo.getWarehouseCashDenominationById(
        denominationId
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllOutletsCashHandover(filters) {
    try {
      const result = await this.accountsRepo.getAllOutletsCashHandover(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async addStartingCash(params) {
    try {
      const result = await this.accountsRepo.addStartingCash(params);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getStartingCash(date) {
    try {
      const result = await this.accountsRepo.getStartingCash(new Date(date));
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getSavedAccount(date, store_id) {
    try {
      const result = await this.accountsRepo.getSavedAccount(date, store_id);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getSalesByOutlet(filters) {
    try {
      const result = await this.accountsRepo.getSalesByOutlet(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updateSale(sale) {
    try {
      const result = await this.accountsRepo.updateSale(sale);
      return result;
    } catch (error) {
      throw error;
    }
  }

  getLedgerObject(
    ledgerName,
    ledgerAmount,
    storeName,
    isCredit,
    ledgerGroup = "$$GroupCurrentAssets"
  ) {
    return {
      LedgerName: ledgerName,
      LedgerGroup: ledgerGroup,
      IsPartyLedger: null,
      LedgerAmount: ledgerAmount,
      IsDeemedPositive: isCredit ? "No" : "Yes",
      BillsAllocation: [],
      LedgerDescription: [],
      GSTClassification: " ",
      IGSTRate: null,
      AppropriateOnValue: "Yes",
      CategoryAllocation: [
        {
          Category: "Primary Cost Category",
          IsDeemedPositive: isCredit ? "No" : "Yes",
          CostCentreAllocation: [
            {
              Name: storeName,
              Amount: ledgerAmount,
            },
          ],
        },
      ],
    };
  }

  getCashSales(accountData) {
    const { total_sales, card_sales, loyalty } = accountData;
    const totalSales = parseFloat(total_sales);
    const cardSales = parseFloat(card_sales);
    const parsedLoyalty = parseFloat(loyalty);

    return totalSales - cardSales - parsedLoyalty;
  }

  async getTallySalesEntry(from_date, to_date) {
    try {
      const data = {};
      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);

      const accounts = await this.getAllAccounts(filter);
      const sales = accounts.data.account;

      sales.forEach((item) => {
        const date = moment(new Date(item.date)).format("YYYYMMDD");

        if (!data[item.outlet_name]) {
          data[item.outlet_name] = {};
        }

        if (!data[item.outlet_name][date]) {
          data[item.outlet_name][date] = INIT_JOURNAL_ENTRY(date);
        }

        const cash_sales = this.getCashSales(item);
        const accountName = `Cash (${
          OUTLET_CASH_ID_MAP[item.store_id] ?? "N/A"
        })`;

        const cashSales =
          parseInt(cash_sales) +
          parseInt(item.loyalty) -
          parseInt(item.sales_return);

        const checkAndInsert = (
          ledgerName,
          ledgerAmount,
          storeName,
          isCredit,
          index,
          ledgerGroup
        ) => {
          if (!data[item.outlet_name][date].ledgerentries[index]) {
            data[item.outlet_name][date].ledgerentries[index] =
              this.getLedgerObject(
                ledgerName,
                parseInt(ledgerAmount),
                storeName,
                isCredit,
                ledgerGroup
              );
          } else {
            data[item.outlet_name][date].ledgerentries[index].LedgerAmount +=
              parseInt(ledgerAmount);

            data[item.outlet_name][date].ledgerentries[
              index
            ].CategoryAllocation[0].CostCentreAllocation[0].Amount +=
              parseInt(ledgerAmount);
          }
        };

        checkAndInsert(accountName, cashSales, item.outlet_name, false, 0);
        checkAndInsert(
          "Card Sales",
          item.card_sales,
          item.outlet_name,
          false,
          1
        );
        checkAndInsert(
          "sales",
          parseInt(item.card_sales) +
            (cash_sales + parseInt(item.loyalty) - parseInt(item.sales_return)),
          item.outlet_name,
          true,
          2,
          "$$GroupSales"
        );
      });

      const finalData = this.getFinalData(data);

      return {
        error: "false",
        data: finalData,
      };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }

  getFinalData(data) {
    return Object.keys(data).flatMap((storeNameKey) =>
      Object.keys(data[storeNameKey]).map(
        (dateKey) => data[storeNameKey][dateKey]
      )
    );
  }

  async getTallyCardToBank(from_date, to_date) {
    try {
      const data = {};

      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);

      const accounts = await this.getAllAccounts(filter);
      const ebook = accounts.data.ebook;
      let totalCardSales = {};

      ebook.forEach((item) => {
        const date = moment(new Date(item.date)).format("YYYYMMDD");

        if (!data[item.store_name]) {
          data[item.store_name] = {};
        }

        if (!data[item.store_name][date]) {
          data[item.store_name][date] = INIT_JOURNAL_ENTRY(date);
        }

        if (!totalCardSales[item.store_name]) {
          totalCardSales[item.store_name] = {};
        }

        if (!totalCardSales[item.store_name][date]) {
          totalCardSales[item.store_name][date] = 0;
        }

        if (item.hdur) {
          totalCardSales[item.store_name][date] += item.hdur;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject(
              "HDFC - UPI",
              item.hdur,
              item.store_name,
              false
            )
          );
        }

        if (item.hfpp) {
          totalCardSales[item.store_name][date] += item.hfpp;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject(
              "HDFC (Card)",
              item.hfpp,
              item.store_name,
              false
            )
          );
        }

        if (item.sedc) {
          totalCardSales[item.store_name][date] += item.sedc;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject("Sodexo", item.sedc, item.store_name, false)
          );
        }

        if (item.ppbl) {
          totalCardSales[item.store_name][date] += item.ppbl;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject("Paytm", item.ppbl, item.store_name, false)
          );
        }
      });

      Object.keys(totalCardSales).forEach((storeNameKey) => {
        Object.keys(totalCardSales[storeNameKey]).forEach((dateKey) => {
          const cardSales = totalCardSales[storeNameKey][dateKey];

          data[storeNameKey][dateKey].ledgerentries.push(
            this.getLedgerObject("Card Sales", cardSales, storeNameKey, true)
          );
        });
      });

      const finalData = this.getFinalData(data);

      return {
        error: "false",
        data: finalData,
      };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }

  getAmmountDifference(values, totalCashHandover) {
    try {
      const {
        total_sales,
        card_sales,
        loyalty,
        sales_return,
        accounts,
        sales,
      } = values;

      let calculated_sales =
        totalCashHandover +
        (card_sales ? parseFloat(card_sales) : 0) +
        (loyalty ? parseFloat(loyalty) : 0) +
        (sales_return ? parseFloat(sales_return) : 0);

      if (accounts || sales) {
        (accounts ?? sales).forEach((item) => {
          if (item.payment_type == 1) {
            // Payment
            calculated_sales += item.amount ? parseFloat(item.amount) : 0;
          } else {
            // Receipt
            calculated_sales -= item.amount ? parseFloat(item.amount) : 0;
          }
        });
      }

      return parseInt(total_sales) - calculated_sales;
    } catch (err) {
      console.log(err);
      return 0;
    }
  }

  getTotalCashHandover(accountItem) {
    return (
      accountItem.cash_handover_500 * 500 +
      accountItem.cash_handover_200 * 200 +
      accountItem.cash_handover_100 * 100 +
      accountItem.cash_handover_50 * 50 +
      accountItem.cash_handover_20 * 20 +
      accountItem.cash_handover_10 * 10 +
      accountItem.cash_handover_5 * 5 +
      accountItem.cash_handover_2 * 2 +
      accountItem.cash_handover_1 * 1
    );
  }

  async getTallyExpenses(from_date, to_date) {
    try {
      const data = {};
      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);
      const accounts = await this.getAllAccounts(filter);

      const totals = {};

      const expenses = accounts.data.account.flatMap((accountItem) => {
        const date = moment(new Date(accountItem.date)).format("YYYYMMDD");

        if (!totals[accountItem.outlet_name]) {
          totals[accountItem.outlet_name] = {};
        }

        if (!totals[accountItem.outlet_name][date]) {
          totals[accountItem.outlet_name][date] = {
            loyalty: 0,
            cash: 0,
            difference: 0,
            difference_excess_list: [],
          };
        }

        totals[accountItem.outlet_name][date].loyalty += parseInt(
          accountItem.loyalty
        );

        const totalCash = this.getTotalCashHandover(accountItem);

        totals[accountItem.outlet_name][date].cash += totalCash;

        const currentDifference = this.getAmmountDifference(
          accountItem,
          totalCash
        );

        if (currentDifference < 0) {
          totals[accountItem.outlet_name][date].difference +=
            Math.abs(currentDifference);
        } else if (currentDifference > 0) {
          totals[accountItem.outlet_name][date].difference_excess_list.push(
            this.getLedgerObject(
              accountItem.cashier_name,
              currentDifference,
              accountItem.outlet_name,
              false
            )
          );
        }

        if (!accountItem.sales) {
          return [];
        }

        return accountItem.sales.map((item) => ({
          ...item,
          outlet_name: accountItem.outlet_name,
          store_id: accountItem.store_id,
          date: accountItem.date,
        }));
      });

      const warehouseExpensesRes = await this.getWarehouseSales(filter);
      const warehouseExpenses = warehouseExpensesRes.data;

      const parseList = (list, defaultOutletName) => {
        list.forEach((item) => {
          if (defaultOutletName) {
            item.outlet_name = defaultOutletName;
          }

          const date = moment(new Date(item.date)).format("YYYYMMDD");

          if (!data[item.outlet_name]) {
            data[item.outlet_name] = {};
          }

          if (!data[item.outlet_name][date]) {
            data[item.outlet_name][date] = INIT_JOURNAL_ENTRY(date);
            data[item.outlet_name][date].store_id = item.store_id;

            if (totals[item.outlet_name] && totals[item.outlet_name][date]) {
              if (totals[item.outlet_name][date].loyalty) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Loyalty",
                    totals[item.outlet_name][date].loyalty,
                    item.outlet_name,
                    false
                  ),
                  Narration: "",
                });
              }

              if (totals[item.outlet_name][date].cash) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Cash",
                    totals[item.outlet_name][date].cash,
                    item.outlet_name,
                    false
                  ),
                  Narration: "Handover",
                });
              }

              if (totals[item.outlet_name][date].difference_excess_list) {
                data[item.outlet_name][date].ledgerentries = [
                  ...data[item.outlet_name][date].ledgerentries,
                  ...totals[item.outlet_name][date].difference_excess_list,
                ];
              }

              if (
                totals[item.outlet_name][date].difference &&
                totals[item.outlet_name][date].difference > 0
              ) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Cash Excess",
                    totals[item.outlet_name][date].difference,
                    item.outlet_name,
                    true
                  ),
                  Narration: "",
                });
              }
            }
          }

          data[item.outlet_name][date].ledgerentries.push({
            ...this.getLedgerObject(
              item.person_name,
              item.amount,
              item.outlet_name,
              item.payment_type === 2
            ),
            Narration: item.description,
          });
        });
      };

      parseList(expenses, undefined);
      parseList(warehouseExpenses, "Warehouse");

      const finalData = [];

      Object.keys(data).map((outlet_name) => {
        Object.keys(data[outlet_name]).map((date) => {
          const tmpMasterData = data[outlet_name][date];
          const tmpLedgerEntries = tmpMasterData.ledgerentries;
          tmpMasterData.ledgerentries = [];

          const accountName = OUTLET_CASH_ID_MAP[tmpMasterData.store_id]
            ? `Cash (${OUTLET_CASH_ID_MAP[tmpMasterData.store_id]})`
            : "Cash";

          finalData.push(
            ...tmpLedgerEntries.map((item) => {
              const tmpObject = {
                ...tmpMasterData,
                MasterID: uuid(),
                Narration: item.Narration ?? "",
                ledgerentries: [
                  this.getLedgerObject(
                    item.LedgerName,
                    item.LedgerAmount,
                    item.CategoryAllocation[0].CostCentreAllocation[0].Name,
                    item.IsDeemedPositive === "No",
                    "$$GroupIndirectExpenses"
                  ),

                  this.getLedgerObject(
                    accountName,
                    item.LedgerAmount,
                    item.CategoryAllocation[0].CostCentreAllocation[0].Name,
                    item.IsDeemedPositive === "Yes",
                    "$$GroupCurrentAssets"
                  ),
                ],
              };

              delete tmpObject.store_id;

              return tmpObject;
            })
          );
        });
      });

      // const finalData = this.getFinalData(data);

      return { error: "false", data: finalData };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }
}

module.exports = (accountsRepo, accountsEbookUsecase, outletUsecase) => {
  return new AccountsUsecase(accountsRepo, accountsEbookUsecase, outletUsecase);
};
