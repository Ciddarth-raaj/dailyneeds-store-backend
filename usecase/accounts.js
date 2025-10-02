const { ALERTS_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const moment = require("moment");
const { uuid } = require("uuidv4");

class AccountsUsecase {
  constructor(
    accountsRepo,
    accountsEbookUsecase,
    outletUsecase,
    employeeUsecase
  ) {
    this.accountsRepo = accountsRepo;
    this.accountsEbookUsecase = accountsEbookUsecase;
    this.outletUsecase = outletUsecase;
    this.employeeUsecase = employeeUsecase;
    this.telegram = require("../services/telegram")();
  }

  async createAccount(account) {
    try {
      const employeeData = await this.employeeUsecase.getEmployeeById(
        account.cashier_id
      );
      account.store_id = employeeData[0].store_id;
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
}

module.exports = (
  accountsRepo,
  accountsEbookUsecase,
  outletUsecase,
  employeeUsecase
) => {
  return new AccountsUsecase(
    accountsRepo,
    accountsEbookUsecase,
    outletUsecase,
    employeeUsecase
  );
};
