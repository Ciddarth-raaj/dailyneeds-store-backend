class AccountsUsecase {
  constructor(accountsRepo) {
    this.accountsRepo = accountsRepo;
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

  async getAllAccounts() {
    try {
      const result = await this.accountsRepo.getAll();
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
}

module.exports = (accountsRepo) => {
  return new AccountsUsecase(accountsRepo);
};
