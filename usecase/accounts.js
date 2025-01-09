class AccountsUsecase {
  constructor(accountsRepo, accountsEbookUsecase) {
    this.accountsRepo = accountsRepo;
    this.accountsEbookUsecase = accountsEbookUsecase;
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

      console.log(accountsEbook);

      result.data = { account: result.data, ebook: accountsEbook.data };

      console.log(result);
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
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteSavedAccount(sheetId) {
    try {
      const result = await this.accountsRepo.deleteSavedAccount(sheetId);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (accountsRepo, accountsEbookUsecase) => {
  return new AccountsUsecase(accountsRepo, accountsEbookUsecase);
};
